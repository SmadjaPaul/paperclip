import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const KIND_CONTEXT = process.env.KIND_CONTEXT ?? "kind-paperclip-e2e";

function kubeconfigPath(): string {
  const value = process.env.KIND_KUBECONFIG;
  if (!value) {
    throw new Error(
      "KIND_KUBECONFIG is required; refusing to read ~/.kube/config or any ambient kubeconfig.",
    );
  }
  return value;
}

export function readKindKubeconfig(): string {
  return readFileSync(kubeconfigPath(), "utf-8");
}

export function kubectl(args: string): string {
  return kubectlWithKubeconfig(kubeconfigPath(), args);
}

export function kubectlWithKubeconfig(file: string, args: string, timeoutMs?: number): string {
  const path = file.replaceAll("'", "'\\''");
  return execSync(
    `kubectl --kubeconfig '${path}' --context '${KIND_CONTEXT}' ${args}`,
    {
      encoding: "utf-8",
      env: { ...process.env, KUBECONFIG: path },
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    },
  );
}

export function deleteNamespaceIfExists(namespace: string): void {
  try {
    kubectl(`delete namespace ${namespace} --wait=true --timeout=60s --ignore-not-found`);
  } catch {
    // ignore
  }
}
