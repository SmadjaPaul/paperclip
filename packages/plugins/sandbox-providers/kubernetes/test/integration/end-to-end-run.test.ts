/**
 * One bounded runtime test for the v1beta1 Paperclip provider.
 *
 * The CI workflow creates an ephemeral Kind cluster, installs Cilium and the
 * pinned Agent Sandbox v1.0.5 release, and gives the plugin a dedicated
 * least-privilege kubeconfig. This test deliberately refuses to use an
 * ambient ~/.kube/config (see _kind-harness.ts).
 */

import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKubeConfig, makeKubeClients } from "../../src/kube-client.js";
import { findPodForSandbox, sandboxCrOrchestrator } from "../../src/sandbox-cr-orchestrator.js";
import {
  deleteNamespaceIfExists,
  kubectl,
  kubectlWithKubeconfig,
  readKindKubeconfig,
} from "./_kind-harness.js";

const pluginModule = process.env.K8S_E2E_USE_DIST === "1"
  ? await import("../../dist/index.js")
  : await import("../../src/index.js");
const plugin = pluginModule.plugin;
const manifest = pluginModule.manifest;

const NAMESPACE = "paperclip-spike-e2e";
const COMPANY_ID = "22222222-2222-2222-2222-222222222222";
const OPENCODE_IMAGE =
  "ghcr.io/paperclipai/agent-runtime-opencode@sha256:349fc68e609998f1d9fc77f94208d50263368b49631f746a51f819917d9b0d2d";

function integrationEnabled(): boolean {
  return process.env.RUN_K8S_INTEGRATION_TESTS === "1";
}

function pluginKubeconfig(): string {
  const file = process.env.PAPERCLIP_PLUGIN_KUBECONFIG;
  if (!file) {
    throw new Error(
      "PAPERCLIP_PLUGIN_KUBECONFIG is required for the CI E2E; refusing to use an ambient credential.",
    );
  }
  return readFileSync(file, "utf8");
}

const config = () => ({
  inCluster: false,
  kubeconfig: pluginKubeconfig(),
  companySlug: "spike-e2e",
  adapterType: "opencode_local",
  adapters: [
    {
      adapterType: "opencode_local",
      enabled: true,
      runtimeImage: OPENCODE_IMAGE,
      envKeys: [],
      allowFqdns: [],
      probeCommand: [],
    },
  ],
  backend: "sandbox-cr",
  egressMode: "standard",
  egressAllowFqdns: [],
  egressAllowCidrs: [],
  imageAllowList: [],
  podActivityDeadlineSec: 30,
});

function jsonFromKubectl(command: string): Record<string, any> {
  return JSON.parse(kubectl(command));
}

async function execute(
  lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> },
  cfg: ReturnType<typeof config>,
  command: string,
  args: string[] = [],
  timeoutMs = 15_000,
) {
  return plugin.definition.onEnvironmentExecute!({
    driverKey: "kubernetes",
    companyId: COMPANY_ID,
    environmentId: "env-test-cr",
    config: cfg,
    lease,
    command,
    args,
    cwd: "/workspace",
    env: {},
    timeoutMs,
  });
}

function listRunScopedResources(runId: string): string[] {
  const resources = kubectl(
    `get pods,secrets,sandboxes.agents.x-k8s.io,networkpolicies.networking.k8s.io -n ${NAMESPACE} -l paperclip.io/run-id=${runId} -o name 2>&1 || true`,
  );
  return resources
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(pod|secret|sandbox|networkpolicy)(\.|\/)/.test(line));
}

function captureSandboxDiagnostics(name: string): void {
  const sandbox = kubectl(
    `get sandbox.agents.x-k8s.io ${name} -n ${NAMESPACE} -o json 2>&1 || true`,
  );
  let generation: number | null = null;
  let conditions: unknown[] = [];
  try {
    const parsed = JSON.parse(sandbox) as {
      metadata?: { generation?: number };
      status?: { conditions?: unknown[] };
    };
    generation = parsed.metadata?.generation ?? null;
    conditions = parsed.status?.conditions ?? [];
  } catch {
    // Keep the raw kubectl output in the diagnostic record.
  }
  console.log(JSON.stringify({
    check: "READY_DIAGNOSTICS",
    sandbox,
    generation,
    conditions,
    podDescribe: kubectl(`describe pods -n ${NAMESPACE} 2>&1 || true`),
    events: kubectl(`get events -n ${NAMESPACE} --sort-by=.lastTimestamp 2>&1 || true`),
    controllerLogs: kubectl(
      "logs -n agent-sandbox-system deployment/agent-sandbox-controller --all-containers=true --tail=-1 2>&1 || true",
    ),
  }));
}

async function waitForNoRunScopedResources(runId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let remaining = listRunScopedResources(runId);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    remaining = listRunScopedResources(runId);
  }
  expect(remaining).toEqual([]);
}

describe("plugin-kubernetes v1beta1 Kind runtime", () => {
  beforeAll(() => {
    if (!integrationEnabled()) return;
    deleteNamespaceIfExists(NAMESPACE);
  });

  afterAll(() => {
    if (!integrationEnabled()) return;
    deleteNamespaceIfExists(NAMESPACE);
  });

  it.runIf(integrationEnabled())(
    "loads, runs, syncs, isolates and cleans one Sandbox v1beta1 lease",
    async () => {
      expect(manifest.id).toBe("paperclip.kubernetes-sandbox-provider");
      expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
      expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
      expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
      console.log(JSON.stringify({ check: "PLUGIN_LOAD", manifest: manifest.id, dist: process.env.K8S_E2E_USE_DIST === "1" }));

      const cfg = config();
      const runId = "r-test-e2e-sandbox-cr";
      const lease = await plugin.definition.onEnvironmentAcquireLease!({
        driverKey: "kubernetes",
        config: cfg,
        runId,
        companyId: COMPANY_ID,
        environmentId: "env-test-cr",
      });

      expect(lease.providerLeaseId).toMatch(/^pc-/);
      const leaseId = lease.providerLeaseId!;
      const realized = await plugin.definition.onEnvironmentRealizeWorkspace!({
        driverKey: "kubernetes",
        companyId: COMPANY_ID,
        environmentId: "env-test-cr",
        config: cfg,
        lease,
        workspace: { remotePath: "/workspace" },
      });
      const activeLease = {
        ...lease,
        metadata: { ...lease.metadata, ...realized.metadata, remoteCwd: realized.cwd },
      };

      try {
        const sandbox = jsonFromKubectl(
          `get sandbox.agents.x-k8s.io ${leaseId} -n ${NAMESPACE} -o json`,
        );
        expect(sandbox.apiVersion).toBe("agents.x-k8s.io/v1beta1");
        expect(sandbox.kind).toBe("Sandbox");
        console.log(JSON.stringify({ check: "SANDBOX_CR", apiVersion: sandbox.apiVersion, sha: process.env.GITHUB_SHA ?? null }));

        const adminClients = makeKubeClients(
          createKubeConfig({ inCluster: false, kubeconfig: readKindKubeconfig() }),
        );
        try {
          await sandboxCrOrchestrator.waitForCompletion(adminClients, NAMESPACE, leaseId, {
            timeoutMs: 120_000,
            pollMs: 1_000,
          });
        } catch (error) {
          // Preserve the live controller evidence before the finally block
          // releases the lease and the suite's afterAll removes the tenant.
          captureSandboxDiagnostics(leaseId);
          throw error;
        }

        const readySandbox = jsonFromKubectl(
          `get sandbox.agents.x-k8s.io ${leaseId} -n ${NAMESPACE} -o json`,
        );
        const generation = Number(readySandbox.metadata?.generation);
        const ready = readySandbox.status?.conditions?.find((condition: any) => condition.type === "Ready");
        expect(ready?.status).toBe("True");
        expect(Number(ready?.observedGeneration)).toBe(generation);
        const readyPodName = await findPodForSandbox(adminClients, NAMESPACE, leaseId);
        expect(readyPodName).toBeTruthy();
        console.log(JSON.stringify({ check: "READY", generation, observedGeneration: ready.observedGeneration }));

        const podName = String(readyPodName);
        const pod = jsonFromKubectl(`get pod ${podName} -n ${NAMESPACE} -o json`);
        expect(pod.spec?.automountServiceAccountToken).toBe(false);
        expect(pod.spec?.volumes?.some((volume: any) => volume.projected?.sources?.some((source: any) => source.serviceAccountToken))).toBe(false);
        expect(pod.spec?.containers?.[0]?.image).toBe(OPENCODE_IMAGE);
        console.log(JSON.stringify({ check: "TOKEN_ISOLATION", serviceAccountTokenMounted: false }));

        const policies = kubectl(`get networkpolicy -n ${NAMESPACE} -o name`);
        expect(policies).toContain("networkpolicy.networking.k8s.io/paperclip-deny-all");
        expect(policies).toContain("networkpolicy.networking.k8s.io/paperclip-egress-allow");

        const execProbe = (actor: string, kubeconfig: string) => {
          try {
            const output = kubectlWithKubeconfig(
              kubeconfig,
              `auth can-i create pods/exec -n ${NAMESPACE} && exec -n ${NAMESPACE} ${podName} -c agent -- sh -c 'printf direct-exec'`,
              10_000,
            ).trim();
            console.log(JSON.stringify({ check: "EXEC_PROBE", actor, ok: true, output }));
          } catch (error) {
            console.log(JSON.stringify({
              check: "EXEC_PROBE",
              actor,
              ok: false,
              error: String(error).slice(0, 500),
            }));
          }
        };
        execProbe("admin", process.env.KIND_KUBECONFIG!);
        execProbe("plugin", process.env.PAPERCLIP_PLUGIN_KUBECONFIG!);

        const first = await execute(activeLease, cfg, "sh", ["-c", "test -d /workspace && printf first > /workspace/multi.txt"]);
        if (first.timedOut) {
          console.log(JSON.stringify({ check: "EXEC_TIMEOUT", result: first }));
          captureSandboxDiagnostics(leaseId);
        }
        expect(first).toMatchObject({ exitCode: 0, timedOut: false });
        const second = await execute(activeLease, cfg, "cat", ["/workspace/multi.txt"]);
        expect(second).toMatchObject({ exitCode: 0, stdout: "first" });
        console.log(JSON.stringify({ check: "MULTI_EXEC", exitCodes: [first.exitCode, second.exitCode] }));

        const streams = await execute(activeLease, cfg, "sh", ["-c", "printf stdout; printf stderr >&2; exit 7"]);
        expect(streams.exitCode).toBe(7);
        expect(streams.stdout).toBe("stdout");
        expect(streams.stderr).toBe("stderr");

        const timeout = await execute(activeLease, cfg, "sleep", ["30"], 1_000);
        expect(timeout.timedOut).toBe(true);
        expect(timeout.exitCode).toBeNull();
        console.log(JSON.stringify({ check: "TERMINAL_STATES", exitCode: streams.exitCode, timeout: timeout.timedOut }));

        const nodeProbe = await execute(activeLease, cfg, "node", ["-e", "process.stdout.write(process.version)"]);
        expect(nodeProbe.exitCode).toBe(0);
        const dnsProbe = await execute(activeLease, cfg, "node", [
          "-e",
          "require('dns').lookup('kubernetes.default.svc', error => process.exit(error ? 41 : 0))",
        ], 8_000);
        expect(dnsProbe.exitCode).toBe(0);
        const network = await execute(activeLease, cfg, "node", [
          "-e",
          "const https=require('https'); const r=https.get('https://kubernetes.default.svc/version',{rejectUnauthorized:false,timeout:1500},()=>process.exit(0)); r.on('error',()=>process.exit(42)); r.on('timeout',()=>{r.destroy();process.exit(43)});",
        ], 8_000);
        expect(network.exitCode).not.toBe(0);
        console.log(JSON.stringify({ check: "NETWORK_ISOLATION", dnsExitCode: dnsProbe.exitCode, deniedExitCode: network.exitCode, timedOut: network.timedOut }));

        const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-k8s-e2e-"));
        try {
          const source = path.join(hostDir, "input.txt");
          const target = path.join(hostDir, "output.txt");
          await fs.writeFile(source, "synced-by-paperclip\n", "utf8");
          const syncParams = {
            driverKey: "kubernetes",
            companyId: COMPANY_ID,
            environmentId: "env-test-cr",
            config: cfg,
            lease: activeLease,
            operations: [{
              operationId: "sync-in",
              files: [{ sourcePath: source, targetPath: "/workspace/sync/input.txt", kind: "file" as const }],
            }],
          };
          const syncIn = await plugin.definition.onEnvironmentSyncIn!(syncParams);
          expect(syncIn.operations[0]).toMatchObject({ operationId: "sync-in", filesTransferred: 1 });
          const syncOut = await plugin.definition.onEnvironmentSyncOut!({
            ...syncParams,
            operations: [{
              operationId: "sync-out",
              files: [{ sourcePath: "/workspace/sync/input.txt", targetPath: target, kind: "file" as const }],
            }],
          });
          expect(syncOut.operations[0]).toMatchObject({ operationId: "sync-out", filesTransferred: 1 });
          await expect(fs.readFile(target, "utf8")).resolves.toBe("synced-by-paperclip\n");
          console.log(JSON.stringify({ check: "WORKSPACE_SYNC", bytes: syncIn.operations[0].bytesTransferred }));
        } finally {
          await fs.rm(hostDir, { recursive: true, force: true });
        }

        const resumed = await plugin.definition.onEnvironmentResumeLease!({
          driverKey: "kubernetes",
          companyId: COMPANY_ID,
          environmentId: "env-test-cr",
          config: cfg,
          providerLeaseId: leaseId,
          leaseMetadata: activeLease.metadata,
        });
        expect(resumed.providerLeaseId).toBe(leaseId);
        console.log(JSON.stringify({ check: "LEASE_RESUME", providerLeaseId: leaseId }));

        const deletingLease = await plugin.definition.onEnvironmentAcquireLease!({
          driverKey: "kubernetes",
          config: cfg,
          runId: "r-test-e2e-delete-during-wait",
          companyId: COMPANY_ID,
          environmentId: "env-test-delete",
        });
        const deletingId = deletingLease.providerLeaseId!;
        const deletingWait = sandboxCrOrchestrator.waitForCompletion(adminClients, NAMESPACE, deletingId, {
          timeoutMs: 30_000,
          pollMs: 100,
        });
        await plugin.definition.onEnvironmentReleaseLease!({
          driverKey: "kubernetes",
          config: cfg,
          providerLeaseId: deletingId,
          leaseMetadata: deletingLease.metadata,
          companyId: COMPANY_ID,
          environmentId: "env-test-delete",
        });
        await expect(deletingWait).rejects.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(kubectl(`get sandbox.agents.x-k8s.io ${deletingId} -n ${NAMESPACE} 2>&1 || true`)).not.toContain(deletingId);
        await waitForNoRunScopedResources("r-test-e2e-delete-during-wait");
        console.log(JSON.stringify({ check: "DELETION_DURING_WAIT", providerLeaseId: deletingId }));
      } finally {
        await plugin.definition.onEnvironmentReleaseLease!({
          driverKey: "kubernetes",
          config: cfg,
          providerLeaseId: leaseId,
          leaseMetadata: activeLease.metadata,
          companyId: COMPANY_ID,
          environmentId: "env-test-cr",
        });
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await waitForNoRunScopedResources(runId);
        expect(kubectl(`get namespace ${NAMESPACE} -o name`)).toContain(`namespace/${NAMESPACE}`);
        console.log(JSON.stringify({ check: "CLEANUP", runId, orphanedResources: false, tenantNamespaceRetained: true }));
      }
    },
    300_000,
  );
});
