#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?}"
: "${KIND_KUBECONFIG:?}"
: "${PAPERCLIP_PLUGIN_KUBECONFIG:?}"

cluster="${KIND_CLUSTER:-paperclip-e2e}"
context="${KIND_CONTEXT:-kind-paperclip-e2e}"
evidence="${GITHUB_WORKSPACE:-$RUNNER_TEMP}/.paperclip-kind-evidence"
mkdir -p "$evidence"

# Preserve a machine-readable non-pass result even when setup fails before the
# runtime test can emit its markers. This prevents an infrastructure failure
# from being mistaken for missing evidence.
jq -n --arg subject "paperclip-kubernetes-kind-e2e:${GITHUB_SHA:-unknown}" \
  '{contract:"agent-test-result-v1",subject:$subject,checks:(
    ["PLUGIN_LOAD","SANDBOX_CR","READY","MULTI_EXEC","WORKSPACE_SYNC","TERMINAL_STATES","NETWORK_ISOLATION","TOKEN_ISOLATION","CLEANUP","CI_E2E"]
    | map({id:.,executed:false,classification:"unavailable",reason:"setup did not complete",risk:"disposable Kind evidence unavailable",ciTreatment:"fail the PR when E2E setup is unavailable"})
    + [{id:"H3_GATE",executed:false,classification:"skipped",reason:"H3 approval is out of scope",risk:"no homelab authorization",ciTreatment:"must remain blocked"}]
  ),transmission:{status:"partial",records:11}}' > "$evidence/agent-test-result-v1.json"

cleanup() {
  kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
  rm -f "$KIND_KUBECONFIG" "$PAPERCLIP_PLUGIN_KUBECONFIG"
}
trap cleanup EXIT

deps="$RUNNER_TEMP/paperclip-plugin-deps"
mkdir -p "$deps"
pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
pnpm --filter @paperclipai/shared build
pnpm --filter @paperclipai/plugin-sdk build
pnpm -C packages/shared pack --pack-destination "$deps" >/dev/null
pnpm -C packages/plugins/sdk pack --pack-destination "$deps" >/dev/null
shared_tar="$(find "$deps" -maxdepth 1 -name 'paperclipai-shared-*.tgz' -print -quit)"
sdk_tar="$(find "$deps" -maxdepth 1 -name 'paperclipai-plugin-sdk-*.tgz' -print -quit)"
test -n "$shared_tar" -a -n "$sdk_tar"
pnpm -C packages/plugins/sandbox-providers/kubernetes install --ignore-workspace --no-lockfile
pnpm -C packages/plugins/sandbox-providers/kubernetes add --save-prod --ignore-workspace --no-lockfile "$shared_tar" "$sdk_tar"
sdk_root="$(realpath packages/plugins/sandbox-providers/kubernetes/node_modules/@paperclipai/plugin-sdk)"
shared_root="$(realpath packages/plugins/sandbox-providers/kubernetes/node_modules/@paperclipai/shared)"
sdk_shared="$sdk_root/node_modules/@paperclipai/shared"
rm -rf "$sdk_shared"
mkdir -p "$(dirname "$sdk_shared")"
cp -R "$shared_root" "$sdk_shared"
pnpm -C packages/plugins/sandbox-providers/kubernetes build

curl -fsSL -o "$RUNNER_TEMP/kind" https://github.com/kubernetes-sigs/kind/releases/download/v0.29.0/kind-linux-amd64
echo "c72eda46430f065fb45c5f70e7c957cc9209402ef309294821978677c8fb3284  $RUNNER_TEMP/kind" | sha256sum -c -
chmod +x "$RUNNER_TEMP/kind"
export PATH="$RUNNER_TEMP:$PATH"
cat > "$RUNNER_TEMP/kind-config.yaml" <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  kubeProxyMode: none
nodes:
  - role: control-plane
  - role: worker
EOF
kind create cluster --name "$cluster" --config "$RUNNER_TEMP/kind-config.yaml" --kubeconfig "$KIND_KUBECONFIG" --wait 180s
kubectl --kubeconfig "$KIND_KUBECONFIG" config use-context "$context"

curl -fsSL -o "$RUNNER_TEMP/cilium.tar.gz" https://github.com/cilium/cilium-cli/releases/download/v0.18.5/cilium-linux-amd64.tar.gz
echo "e63893745b67f58032d9b4f142ae7d6e97286df66af27ff24cd72dc81efc9ff9  $RUNNER_TEMP/cilium.tar.gz" | sha256sum -c -
tar -xzf "$RUNNER_TEMP/cilium.tar.gz" -C "$RUNNER_TEMP"
cilium install --version 1.17.6 --set kubeProxyReplacement=true
cilium status --wait --wait-duration 5m

curl -fsSL -o "$RUNNER_TEMP/sandbox.yaml" https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.5/sandbox-with-extensions.yaml
echo "b150cb058c577c59c42b060ff7f22e31b5311ca80430db98129f1280a0e85970  $RUNNER_TEMP/sandbox.yaml" | sha256sum -c -
kubectl --kubeconfig "$KIND_KUBECONFIG" apply -f "$RUNNER_TEMP/sandbox.yaml"
kubectl --kubeconfig "$KIND_KUBECONFIG" wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=120s
kubectl --kubeconfig "$KIND_KUBECONFIG" rollout status deployment/agent-sandbox-controller -n agent-sandbox-system --timeout=180s
test "$(kubectl --kubeconfig "$KIND_KUBECONFIG" get crd sandboxes.agents.x-k8s.io -o jsonpath='{.spec.versions[?(@.name=="v1beta1")].served}')" = true

image="${OPENCODE_IMAGE:?}"
docker pull "$image"
docker image inspect "$image" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -Fx "$image"
test "$(docker image inspect "$image" --format '{{.Architecture}}')" = amd64
# Do not use `kind load docker-image` here. Kind's import path can register
# digest-pinned images under a temporary docker.io/library/import-* name; the
# containerd checkpoint-image probe then fails CreateContainer before the
# actual image can start. The image is public, so let the kubelet pull the
# exact verified digest directly from GHCR instead.

kubectl --kubeconfig "$KIND_KUBECONFIG" apply -f - <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: paperclip-system
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: paperclip-kubernetes-e2e
  namespace: paperclip-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: paperclip-kubernetes-e2e
rules:
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "create"]
  - apiGroups: [""]
    resources: ["serviceaccounts", "secrets", "pods", "pods/log"]
    verbs: ["get", "list", "create", "delete"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["get", "create"]
  - apiGroups: [""]
    resources: ["resourcequotas", "limitranges"]
    verbs: ["get", "create"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles", "rolebindings"]
    verbs: ["get", "create"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["get", "create"]
  - apiGroups: ["agents.x-k8s.io"]
    resources: ["sandboxes"]
    verbs: ["get", "list", "create", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: paperclip-kubernetes-e2e
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: paperclip-kubernetes-e2e
subjects:
  - kind: ServiceAccount
    name: paperclip-kubernetes-e2e
    namespace: paperclip-system
EOF
token="$(kubectl --kubeconfig "$KIND_KUBECONFIG" -n paperclip-system create token paperclip-kubernetes-e2e --duration=1h)"
cp "$KIND_KUBECONFIG" "$PAPERCLIP_PLUGIN_KUBECONFIG"
kubectl --kubeconfig "$PAPERCLIP_PLUGIN_KUBECONFIG" config set-credentials paperclip-kubernetes-e2e --token="$token" >/dev/null
kubectl --kubeconfig "$PAPERCLIP_PLUGIN_KUBECONFIG" config set-context "$context" --cluster="$context" --user=paperclip-kubernetes-e2e >/dev/null
kubectl --kubeconfig "$PAPERCLIP_PLUGIN_KUBECONFIG" config use-context "$context" >/dev/null
kubectl --kubeconfig "$KIND_KUBECONFIG" auth can-i --as=system:serviceaccount:paperclip-system:paperclip-kubernetes-e2e create namespaces
kubectl --kubeconfig "$KIND_KUBECONFIG" auth can-i --as=system:serviceaccount:paperclip-system:paperclip-kubernetes-e2e create sandboxes.agents.x-k8s.io
kubectl --kubeconfig "$KIND_KUBECONFIG" auth can-i --as=system:serviceaccount:paperclip-system:paperclip-kubernetes-e2e get pods/exec
kubectl --kubeconfig "$KIND_KUBECONFIG" auth can-i --as=system:serviceaccount:paperclip-system:paperclip-kubernetes-e2e create pods/exec
test "$(kubectl --kubeconfig "$KIND_KUBECONFIG" auth can-i --as=system:serviceaccount:paperclip-system:paperclip-kubernetes-e2e delete deployments)" = no

set +e
RUN_K8S_INTEGRATION_TESTS=1 K8S_E2E_USE_DIST=1 pnpm -C packages/plugins/sandbox-providers/kubernetes test 2>&1 | tee "$evidence/paperclip-kind-e2e.log"
e2e_exit=${PIPESTATUS[0]}
set -e

checks='[]'
for id in PLUGIN_LOAD SANDBOX_CR READY MULTI_EXEC WORKSPACE_SYNC TERMINAL_STATES NETWORK_ISOLATION TOKEN_ISOLATION CLEANUP; do
  if grep -Fq "\"check\":\"$id\"" "$evidence/paperclip-kind-e2e.log"; then classification=passed; reason="marker $id present"; else classification=failed; reason="marker $id absent"; fi
  checks="$(jq --arg id "$id" --arg classification "$classification" --arg reason "$reason" '. + [{id:$id,executed:true,classification:$classification,reason:$reason,risk:"disposable Kind evidence only",ciTreatment:"fail the PR when E2E fails"}]' <<< "$checks")"
done
ci_classification=passed; [ "$e2e_exit" -eq 0 ] || ci_classification=failed
checks="$(jq --arg classification "$ci_classification" '. + [{id:"CI_E2E",executed:true,classification:$classification,reason:"Vitest result",risk:"CI is the disposable runtime gate",ciTreatment:"required for PR merge"},{id:"H3_GATE",executed:false,classification:"skipped",reason:"H3 approval is out of scope",risk:"no homelab authorization",ciTreatment:"must remain blocked"}]' <<< "$checks")"
jq -n --arg subject "paperclip-kubernetes-kind-e2e:${GITHUB_SHA:-unknown}" --argjson checks "$checks" '{contract:"agent-test-result-v1",subject:$subject,checks:$checks,transmission:{status:(if any($checks[]; .classification == "failed") then "partial" else "complete" end),records:11}}' > "$evidence/agent-test-result-v1.json"
kubectl --kubeconfig "$KIND_KUBECONFIG" get pods -A -o wide > "$evidence/pods.txt" 2>&1 || true
kubectl --kubeconfig "$KIND_KUBECONFIG" get sandbox.agents.x-k8s.io -A -o yaml > "$evidence/sandboxes.yaml" 2>&1 || true
kubectl --kubeconfig "$KIND_KUBECONFIG" get events -A --sort-by=.lastTimestamp > "$evidence/events.txt" 2>&1 || true
kubectl --kubeconfig "$KIND_KUBECONFIG" logs -n agent-sandbox-system deployment/agent-sandbox-controller --all-containers=true --tail=-1 > "$evidence/agent-sandbox-controller.log" 2>&1 || true
exit "$e2e_exit"
