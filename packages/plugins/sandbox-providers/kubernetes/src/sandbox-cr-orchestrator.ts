/**
 * SandboxOrchestrator implementation backed by the kubernetes-sigs/agent-sandbox
 * Sandbox CRD (agents.x-k8s.io/v1beta1).
 *
 * The Sandbox CR creates a long-lived pod that paperclip-server can exec into
 * for multi-command adapter-install workflows — the key architectural win over
 * the batch/v1 Job backend.
 *
 * Key semantic differences from jobOrchestrator:
 * - claim() creates a Sandbox CR via CustomObjectsApi instead of a batch Job
 * - getStatus() maps Sandbox phase (Pending|Ready|Terminating|Failed) to SandboxStatus
 * - findPod() reads status.podName from the Sandbox CR (falls back to label query)
 * - waitForCompletion() means "wait until pod is Ready to exec" NOT "wait until
 *   workload finishes". The Sandbox pod runs sleep infinity; execution completion
 *   is tracked by the individual execInPod() calls.
 * - release() deletes the Sandbox CR with Foreground propagation (controller
 *   tears down the underlying pod).
 *
 * NOTE: streamLogs() is provided for interface conformance but is limited —
 * the sleep-infinity pod has no meaningful stdout. Callers in execute mode
 * should use execInPod() and capture its stdout/stderr directly.
 */

import type { KubeClients } from "./kube-client.js";
import type { SandboxOrchestrator, SandboxStatus } from "./sandbox-orchestrator.js";

const SANDBOX_GROUP = "agents.x-k8s.io";
const SANDBOX_VERSION = "v1beta1";
const SANDBOX_PLURAL = "sandboxes";

export class SandboxCrTimeoutError extends Error {
  constructor(namespace: string, name: string, timeoutMs: number) {
    super(
      `Sandbox ${namespace}/${name} did not reach Ready phase within ${timeoutMs}ms`,
    );
    this.name = "SandboxCrTimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map the v1beta1 condition-based Sandbox status to our internal shape.
 * v1beta1 deliberately has no phase field; readiness is represented by the
 * Ready condition. Finished is terminal for the sandbox pod, not proof that
 * the coding-agent commands succeeded.
 */
function mapSandboxPhase(
  cr: Record<string, unknown>,
): SandboxStatus {
  const status = (cr.status as Record<string, unknown>) ?? {};
  const metadata = (cr.metadata as Record<string, unknown>) ?? {};
  const conditions = Array.isArray(status.conditions)
    ? (status.conditions as Array<Record<string, unknown>>)
    : [];
  const isCurrent = (condition: Record<string, unknown>): boolean => {
    const observed = condition.observedGeneration;
    const generation = metadata.generation;
    return typeof generation === "number" && observed === generation;
  };
  const current = (type: string) =>
    conditions.find((condition) => condition.type === type && isCurrent(condition));
  const conditionText = (condition: Record<string, unknown> | undefined) => ({
    reason: typeof condition?.reason === "string" ? condition.reason : undefined,
    message: typeof condition?.message === "string" ? condition.message : undefined,
  });

  const finished = current("Finished");
  if (finished?.status === "True") {
    const text = conditionText(finished);
    return {
      phase: "Failed",
      complete: false,
      active: 0,
      succeeded: 0,
      failed: 1,
      reason: text.reason ?? "SandboxFinished",
      message: text.message ?? "The Sandbox pod finished before the coding-agent run completed.",
    };
  }

  const ready = current("Ready");
  const terminalReadyReasons = new Set([
    "InvalidConfiguration",
    "MultiplePods",
    "SandboxExpired",
    "SandboxSuspended",
    "PodSucceeded",
    "PodFailed",
  ]);
  if (ready?.status === "False" && terminalReadyReasons.has(String(ready.reason))) {
    const text = conditionText(ready);
    return {
      phase: "Failed",
      complete: false,
      active: 0,
      succeeded: 0,
      failed: 1,
      reason: text.reason,
      message: text.message,
    };
  }
  if (ready?.status === "True") {
    return {
      phase: "Running",
      complete: false,
      active: 1,
      succeeded: 0,
      failed: 0,
    };
  }

  // DependenciesNotReady, ReconcilerError, unknown Ready=False reasons, stale
  // conditions and the legacy phase field are all non-authoritative for
  // v1beta1 readiness. Keep them Pending and wait for a fenced Ready condition.
  return {
    phase: "Pending",
    complete: false,
    active: 0,
    succeeded: 0,
    failed: 0,
  };
}

function sandboxFailureMessage(
  namespace: string,
  name: string,
  status: SandboxStatus,
): string {
  return `Sandbox ${namespace}/${name} failed: ${status.reason ?? "unknown reason"} — ${status.message ?? ""}`;
}

export async function createSandboxCr(
  clients: KubeClients,
  namespace: string,
  manifest: Record<string, unknown>,
): Promise<{ uid: string }> {
  const result = await clients.custom.createNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    body: manifest,
  });
  const uid = (result as { metadata?: { uid?: string } }).metadata?.uid;
  if (!uid) throw new Error("Sandbox CR created without a UID");
  return { uid };
}

export async function getSandboxCrStatus(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<SandboxStatus> {
  const result = await clients.custom.getNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
  });
  return mapSandboxPhase(result as Record<string, unknown>);
}

/**
 * Returns the pod name backing a Sandbox CR.
 * Primary: read status.podName from the CR (set by the controller once ready).
 * Fallback: list pods in the namespace filtered by the paperclip.io/managed-by
 * label and the sandbox name label set on the pod template.
 */
export async function findPodForSandbox(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<string | null> {
  // Primary: read status.podName from the Sandbox CR
  const cr = await clients.custom.getNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
  }) as Record<string, unknown>;

  const status = (cr.status as Record<string, unknown>) ?? {};
  const podName = status.podName as string | undefined;
  if (podName && podName.trim().length > 0) {
    return podName;
  }

  // Secondary: the agent-sandbox controller (v0.4.x) names the backing pod
  // EXACTLY after the Sandbox CR and labels it only with
  // agents.x-k8s.io/sandbox-name-hash (a hash, not the full name), so the
  // full-name label selector below matches nothing on that controller. An
  // exact-name GET is collision-free (unlike name-prefix matching, which
  // could hit a concurrent sandbox sharing a prefix) and resolves the pod on
  // every controller version that keeps pod name == sandbox name.
  try {
    const pod = (await clients.core.readNamespacedPod({ namespace, name })) as {
      metadata?: { name?: string };
    };
    if (pod?.metadata?.name) {
      return pod.metadata.name;
    }
  } catch (err) {
    const code =
      (err as { code?: number; statusCode?: number }).code ??
      (err as { code?: number; statusCode?: number }).statusCode;
    if (code !== 404) throw err;
  }

  // Fallback: list pods by a full-name sandbox label, for controller versions
  // that label pods with the sandbox name. A broader managed-by selector plus
  // name-prefix narrowing could match a concurrent sandbox whose generated
  // name shares a prefix, and exec would target the wrong lease's pod.
  const result = await clients.core.listNamespacedPod({
    namespace,
    labelSelector: `agents.x-k8s.io/sandbox-name=${name}`,
  });
  const items =
    (
      (
        result as {
          items?: {
            metadata?: { name?: string; labels?: Record<string, string> };
            status?: { phase?: string };
          }[];
        }
      ).items
    ) ?? [];

  // The label selector already scopes to exactly this sandbox's pod(s); keep a
  // defensive re-check on the label value only (no name-prefix matching).
  const matching = items.filter(
    (p) => (p.metadata?.labels ?? {})["agents.x-k8s.io/sandbox-name"] === name,
  );

  const running = matching.find((p) => p.status?.phase === "Running");
  return (running ?? matching[0])?.metadata?.name ?? null;
}

export async function streamSandboxLogs(
  clients: KubeClients,
  namespace: string,
  podName: string,
  onChunk: (stream: "stdout" | "stderr", text: string) => Promise<void>,
): Promise<void> {
  // V1 limitation: readNamespacedPodLog returns combined stdout. The
  // sleep-infinity pod will have minimal output; this is provided for interface
  // conformance. For actual command output, use execInPod() directly.
  const result = await clients.core.readNamespacedPodLog({
    namespace,
    name: podName,
  });
  const text = (result as string) ?? "";
  if (text.length > 0) await onChunk("stdout", text);
}

export async function deleteSandboxCr(
  clients: KubeClients,
  namespace: string,
  name: string,
): Promise<void> {
  await clients.custom.deleteNamespacedCustomObject({
    group: SANDBOX_GROUP,
    version: SANDBOX_VERSION,
    namespace,
    plural: SANDBOX_PLURAL,
    name,
    propagationPolicy: "Foreground",
  });
}

/**
 * Wait until the Sandbox CR's pod reaches Ready phase (i.e., the pod is up and
 * exec-able). This is NOT waiting for a workload to finish — the Sandbox pod
 * runs sleep infinity indefinitely. Execution completion is tracked by the
 * individual execInPod() calls.
 *
 * Throws SandboxCrTimeoutError if Ready is not reached within timeoutMs.
 * Throws if the Sandbox transitions to Failed.
 */
export async function waitForSandboxReady(
  clients: KubeClients,
  namespace: string,
  name: string,
  opts: { timeoutMs: number; pollMs?: number } = {
    timeoutMs: 120_000,
    pollMs: 2000,
  },
): Promise<SandboxStatus> {
  const deadline = Date.now() + opts.timeoutMs;
  const pollMs = opts.pollMs ?? 2000;

  while (Date.now() < deadline) {
    const cr = await clients.custom.getNamespacedCustomObject({
      group: SANDBOX_GROUP,
      version: SANDBOX_VERSION,
      namespace,
      plural: SANDBOX_PLURAL,
      name,
    }) as Record<string, unknown>;

    const metadata = (cr.metadata as Record<string, unknown>) ?? {};
    if (typeof metadata.deletionTimestamp === "string" && metadata.deletionTimestamp.length > 0) {
      throw new Error(`Sandbox ${namespace}/${name} is being deleted — cannot wait for Ready`);
    }
    // Use the exact same condition ordering and generation filtering as
    // getSandboxCrStatus(). A current terminal condition must win over Ready;
    // otherwise this loop can return a Failed status that callers interpret as
    // successful readiness and then exec into a dead pod.
    const mapped = mapSandboxPhase(cr);
    if (mapped.phase === "Failed") {
      throw new Error(sandboxFailureMessage(namespace, name, mapped));
    }
    if (mapped.phase === "Running" && mapped.reason !== "Terminating") {
      return mapped;
    }
    if (mapped.reason === "Terminating") {
      // A Sandbox being torn down will never transition to Ready. Polling
      // until the deadline would burn the full timeoutMs (potentially
      // 30+ minutes) before throwing a generic timeout. Fail fast instead
      // so the caller can surface a clear "the lease is being released"
      // error and decide whether to retry against a fresh Sandbox.
      throw new Error(
        `Sandbox ${namespace}/${name} is Terminating — cannot wait for Ready`,
      );
    }
    // Pending — keep polling
    await sleep(pollMs);
  }

  throw new SandboxCrTimeoutError(namespace, name, opts.timeoutMs);
}

/**
 * Sandbox CR-backed conformance to SandboxOrchestrator.
 *
 * waitForCompletion semantics change: for this backend, "completion" means
 * "pod is up and Ready to exec into" — NOT "workload finished". The actual
 * command execution and its completion is handled by execInPod().
 */
export const sandboxCrOrchestrator: SandboxOrchestrator = {
  claim: createSandboxCr,
  getStatus: getSandboxCrStatus,
  findPod: findPodForSandbox,
  streamLogs: streamSandboxLogs,
  release: deleteSandboxCr,
  waitForCompletion: waitForSandboxReady,
};
