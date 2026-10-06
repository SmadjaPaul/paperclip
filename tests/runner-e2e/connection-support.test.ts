import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_ADAPTER_TYPES } from "../../packages/shared/src/constants.js";
import { runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions, buildMatrixJobs } from "./selectors.js";
import { connectionHarnesses, connectionScopeGaps, connectionCell, supportsConnection } from "./connection-cases.js";
import { parseConnectionConfig, targetOrigin, selectedSecret, resolveConnectionSecret, resolveConnectionSettings } from "./connection-config.js";
import { connectionCheckpoints, connectionEvidencePasses, connectionRunDiagnostic, createConnectionProof, verifyConnectionArtifact, verifyConnectionRun, completedConnectionArtifactRun, connectionProbeChecks, type ConnectionEvidence } from "./connection-evidence.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import { verifyConnectionTarget } from "./connection-target.js";
import { safeConnectionFailure } from "./connection-launch.js";
import { buildRunnerCampaign } from "./history.js";
import { renderCaseOutcome } from "./case-outcome.js";
import type { RunnerE2EResult } from "./types.js";

const cells = runnerMatrix.filter(e => e.suite.id === "provider-connections");
const cell = (method: string) => cells.find(e => e.id === `provider-connections.connection-codex-native.local.agent-${method}`)!;

describe("live connection coverage", () => {
  it("inventories every built-in adapter and keeps remote exclusions explicit", () => {
    const inventory = new Set<string>(["paperclip_runner", ...connectionHarnesses.map(h => h.adapter), ...connectionScopeGaps.map(h => h.adapter)]);
    expect(AGENT_ADAPTER_TYPES.filter(type => !inventory.has(type))).toEqual([]);
    expect(connectionHarnesses.some(h => h.adapter === "hermes_local")).toBe(true);
    expect(connectionScopeGaps.find(h => h.adapter === "hermes_gateway")?.status).toBe("excluded");
  });
  it("includes both UI entry points and actual runner variants without invented auth capabilities", () => {
    expect(cells.length).toBe(116);
    expect(new Set(cells.map(e => connectionCell(e).entry))).toEqual(new Set(["agent", "apps"]));
    expect(cells.filter(e => connectionCell(e).harness.id === "grok").every(e => ["subscription", "api-key"].includes(connectionCell(e).mode))).toBe(true);
    expect(supportsConnection(connectionHarnesses.find(h => h.id === "gemini")!, "subscription")).toBe(false);
  });
  it("never runs on --all or advertises a preinstalled subscription token as a credential", () => {
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(e => e.suite.id === "provider-connections")).toBe(false);
    expect(cell("subscription").requiredCredentials).toEqual([]);
    expect(() => buildMatrixJobs(cells)).toThrow(/not admitted/);
    expect(parseRunnerSelectors(["--suite", "provider-connections", "--connection-config", "/private/qa.json"]).connectionConfig).toBe("/private/qa.json");
  });
});

describe("target and selected credential boundaries", () => {
  it("accepts local/staging origins and rejects credential-bearing or redirectable target strings", () => {
    expect(targetOrigin("http://127.0.0.1:3109/")).toBe("http://127.0.0.1:3109");
    expect(targetOrigin("https://staging.example.test")).toBe("https://staging.example.test");
    for (const url of ["http://staging.example.test", "https://user:password@example.test", "https://example.test/path", "https://example.test/?token=secret", "https://example.test/#secret", "file:///tmp/qa"]) expect(() => targetOrigin(url)).toThrow();
  });
  it("requires an exact staging revision and rejects unknown configuration instead of ignoring typos", () => {
    expect(() => parseConnectionConfig({ target: { mode: "attach", baseURL: "https://example.test" } })).toThrow();
    expect(() => parseConnectionConfig({ target: { mode: "managed-local", baseURL: "https://example.test" } })).toThrow();
    expect(() => parseConnectionConfig({ broswer: {} })).toThrow();
    expect(() => parseConnectionConfig({ browser: { loginTimeoutMs: Infinity } })).toThrow();
    expect(parseConnectionConfig({}).browser.headed).toBe(true);
  });
  it("pins the target revision before permitting credential selection", async () => {
    const config = parseConnectionConfig({ target: { mode: "attach", baseURL: "https://staging.example.test", expectedCommit: "a".repeat(40), deploymentMode: "authenticated" } });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ commit: "b".repeat(40), deploymentMode: "authenticated" })));
    try {
      await expect(verifyConnectionTarget("https://staging.example.test", config)).rejects.toThrow("target_identity_mismatch");
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
      fetch.mockResolvedValue(new Response(JSON.stringify({ commit: "a".repeat(40), deploymentMode: "authenticated" })));
      await expect(verifyConnectionTarget("https://staging.example.test", config)).resolves.toMatchObject({ commit: "a".repeat(40) });
    } finally { fetch.mockRestore(); }
  });
  it("reads literal selected keys without sourcing shell commands or returning unrelated secrets", async () => {
    expect(selectedSecret("UNRELATED=do-not-read\nexport OPENAI_API_KEY='chosen-value'\n", "OPENAI_API_KEY")).toBe("chosen-value");
    expect(selectedSecret("OPENAI_API_KEY=one\nOPENAI_API_KEY=two", "OPENAI_API_KEY")).toBe("two");
    expect(() => selectedSecret("OPENAI_API_KEY=$(touch /tmp/should-not-exist)", "OPENAI_API_KEY")).toThrow();
    const root = await mkdtemp(path.join(os.tmpdir(), "connection-secret-test-"));
    try {
      const file = path.join(root, "keys");
      await writeFile(file, "OPENAI_API_KEY=selected-only\nUNRELATED=private\n", { mode: 0o600 });
      const config = parseConnectionConfig({ secretFile: file });
      expect(await resolveConnectionSecret(config, "OPENAI_API_KEY", {})).toBe("selected-only");
      expect(await resolveConnectionSecret(config, undefined, {})).toBeUndefined();
      await expect(resolveConnectionSecret(config, "XAI_API_KEY", {})).rejects.toThrow("missing_XAI_API_KEY");
      await writeFile(path.join(root, "public"), "OPENAI_API_KEY=private", { mode: 0o644 });
      await expect(resolveConnectionSecret(parseConnectionConfig({ secretFile: path.join(root, "public") }), "OPENAI_API_KEY", {})).rejects.toThrow(/owner_only/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("never resolves an API key for a subscription or defaults a gateway to the direct provider's credential", () => {
    expect(resolveConnectionSettings(cell("subscription"), parseConnectionConfig({})).credentialEnv).toBeUndefined();
    expect(resolveConnectionSettings(cell("api-key"), parseConnectionConfig({})).credentialEnv).toBe("OPENAI_API_KEY");
    expect(() => resolveConnectionSettings(cell("responses"), parseConnectionConfig({ routes: { responses: { model: "qa-alias", baseURL: "https://gateway.example.test/v1" } } }))).toThrow(/credential_reference/);
    const config = parseConnectionConfig({ routes: { responses: { model: "qa-alias", baseURL: "https://gateway.example.test/v1", credentialEnv: "GATEWAY_QA_KEY" } } });
    expect(resolveConnectionSettings(cell("responses"), config).credentialEnv).toBe("GATEWAY_QA_KEY");
  });
});

function passingEvidence(): ConnectionEvidence {
  return { version: 1, outcome: "passed", phase: "finished", assisted: true, authFreshness: "signed-in", target: { mode: "attach", origin: "https://staging.example.test", commit: "a".repeat(40), deploymentMode: "authenticated" }, entry: "agent", method: "subscription", checkpoints: Object.fromEntries(connectionCheckpoints.map(key => [key, true])), waits: [] };
}

describe("independent qualification", () => {
  it("retains closed failure signals across split log chunks without messages or reasoning", () => {
    const sentinel = "SENTINEL_CREDENTIAL_DO_NOT_RETAIN";
    const rows = [
      { type: "acpx.text_delta", channel: "thought", text: 'HTTP 429 '+sentinel },
      { type: "acpx.error", childStderrTail: 'ApiError: {"error":{"code":503,"message":"model overloaded '+sentinel+'"}}' },
      { type: "acpx.tool_call", status: "failed", text: "Error checking existing file: Resource not found: "+sentinel },
    ].map(row => JSON.stringify(row)).join("\n")+"\n";
    const split = Math.floor(rows.length / 2);
    const log = { content: [rows.slice(0, split), rows.slice(split)].map(chunk => JSON.stringify({ chunk })).join("\n") };
    const diagnostic = connectionRunDiagnostic({ id: "run-1", status: "failed" }, log);
    expect(diagnostic).toEqual({ runId: "run-1", status: "failed", signals: ["provider_overloaded", "missing_file_conversion"], logAvailable: true });
    expect(JSON.stringify(diagnostic)).not.toContain(sentinel);
    expect(connectionRunDiagnostic({ id: "run-2", status: "running" })).toEqual({ runId: "run-2", status: "unknown", signals: [], logAvailable: false });
  });
  it("distinguishes terminal quota and unsupported configuration from generic failures", () => {
    expect(connectionRunDiagnostic({ id: "quota", status: "failed", error: 'HTTP 429 RESOURCE_EXHAUSTED' }).signals).toEqual(["provider_quota"]);
    expect(connectionRunDiagnostic({ id: "config", status: "failed", error: 'session/set_config_option: Method not found (-32601)' }).signals).toEqual(["unsupported_session_configuration"]);
    expect(connectionRunDiagnostic({ id: "generic", status: "failed", error: 'unknown provider error' }).signals).toEqual([]);
    expect(connectionRunDiagnostic({ id: "unattributed-503", status: "failed", error: 'HTTP 503' }).signals).toEqual([]);
  });
  it("waits for disposition repair and requires the successful artifact-producing run", () => {
    const expected = { agentId: "a", connectionId: "c", method: "api_key", runtimeMode: "legacy" };
    const first = { id: "first", agentId: "a", status: "succeeded", runtimeMode: "legacy", contextSnapshot: { aiConnection: { connectionId: "c", method: "api_key" } } };
    const repair = { ...first, id: "repair" };
    const file = { originalFilename: "proof.json", createdByAgentId: "a", originatingRunId: "repair" };
    expect(completedConnectionArtifactRun([first, { ...repair, status: "running" }], [file], "proof.json", expected)).toBeUndefined();
    expect(completedConnectionArtifactRun([first, repair], [file], "proof.json", expected)).toBe(repair);
    expect(completedConnectionArtifactRun([first, { ...repair, status: "cancelled" }], [file], "proof.json", expected)).toBeUndefined();
    expect(completedConnectionArtifactRun([first, repair], [{ ...file, createdByAgentId: "someone-else" }], "proof.json", expected)).toBeUndefined();
    expect(completedConnectionArtifactRun([first, repair], [file], "followup.json", expected)).toBeUndefined();
    expect(completedConnectionArtifactRun([first, repair], [file], "proof.json", { ...expected, connectionId: "another" })).toBeUndefined();
  });
  it("retains probe codes without provider text, URLs, or credential-bearing fields", () => {
    const sentinel = "SENTINEL_CREDENTIAL_DO_NOT_RETAIN";
    const checks = connectionProbeChecks({ checks: [
      { code: "hermes_cli_not_found", level: "error", message: sentinel, detail: `https://provider.test/?code=${sentinel}` },
      { code: sentinel, level: "error" }, { code: "safe_code", level: sentinel }, null,
    ] });
    expect(checks).toEqual([{ code: "hermes_cli_not_found", level: "error" }]);
    expect(JSON.stringify(checks)).not.toContain(sentinel);
  });
  it("rejects plausible prose, wrong bytes and wrong run attribution", () => {
    const proof = createConnectionProof();
    expect(verifyConnectionArtifact(Buffer.from(JSON.stringify(proof.expected)), proof.expected)).toBe(true);
    expect(verifyConnectionArtifact(Buffer.from("Provider routing works"), proof.expected)).toBe(false);
    expect(verifyConnectionArtifact(Buffer.from(JSON.stringify({ ...proof.expected, total: proof.expected.total + 1 })), proof.expected)).toBe(false);
    const expected = { agentId: "a", connectionId: "c", method: "subscription", runtimeMode: "native", model: "m" };
    const run = { agentId: "a", status: "succeeded", runtimeMode: "native", contextSnapshot: { aiConnection: { connectionId: "c", method: "subscription" } } };
    expect(verifyConnectionRun(run, expected)).toBe(true);
    expect(verifyConnectionRun(run, { ...expected, connectionId: "ambient" })).toBe(false);
    expect(verifyConnectionRun(run, { ...expected, method: "api_key" })).toBe(false);
  });
  it("requires every checkpoint and never passes absent evidence or a human deadline", () => {
    expect(connectionEvidencePasses(passingEvidence())).toBe(true);
    for (const key of connectionCheckpoints) {
      const evidence = passingEvidence(); delete evidence.checkpoints[key];
      expect(connectionEvidencePasses(evidence)).toBe(false);
    }
    expect(connectionEvidencePasses({ ...passingEvidence(), outcome: "awaiting_user" })).toBe(false);
    expect(connectionEvidencePasses({ ...passingEvidence(), target: { ...passingEvidence().target, commit: null } })).toBe(false);
  });
  it("withholds raw Playwright call logs including filled secrets, codes, and callback URLs", () => {
    const sentinel = "SENTINEL_CREDENTIAL_DO_NOT_RETAIN";
    for (const message of [`locator.fill: value ${sentinel}`, `https://provider.test/callback?code=${sentinel}`, `password=${sentinel}`, "lowercasesecret"]) {
      const safe = safeConnectionFailure(new Error(message), "connection_creation");
      expect(safe).toBe("connection_creation_failed"); expect(safe).not.toContain(sentinel);
    }
  });
  it("keeps blocked authentication incomplete in the existing campaign/report", () => {
    const execution = cell("subscription");
    const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: execution.id, suiteId: execution.suite.id, suiteDefinitionHash: execution.suiteDefinitionHash,
      attempt: 1, status: "failed", failureClass: "permanent_infrastructure", error: "provider_login_deadline_reached", profileId: execution.profile.id, environmentId: "local", caseId: execution.task.id, provider: "codex", model: "model", runtimeMode: "native",
      startedAt: "2026-10-03T00:00:00Z", finishedAt: "2026-10-03T00:01:00Z", durationMs: 60_000, cleanup: "passed", providerConnection: { ...passingEvidence(), outcome: "awaiting_user", checkpoints: { target: true } } };
    const campaign = buildRunnerCampaign({ campaignId: "test", generatedAt: result.finishedAt, expected: [execution.id], results: [result] });
    expect(() => validateRetainedRunnerResult({ ...result, status: "passed" })).toThrow(/providerConnection/);
    expect(() => validateRetainedRunnerResult({ ...result, status: "passed", providerConnection: undefined })).toThrow(/providerConnection/);
    expect(campaign.passed).toBe(0); expect(campaign.incomplete).toBe(1); expect(campaign.complete).toBe(false);
    expect(renderCaseOutcome(result, false, [])).toContain("Blocked: awaiting user");
    const cleanupFailed = buildRunnerCampaign({ campaignId: "failed-cleanup", generatedAt: result.finishedAt, expected: [execution.id], results: [{ ...result, cleanup: "failed", failureClass: "cleanup_failure" }] });
    expect(cleanupFailed.failed).toBe(1); expect(cleanupFailed.incomplete).toBe(0);
  });
});
