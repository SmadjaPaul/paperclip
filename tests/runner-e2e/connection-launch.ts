import { chromium, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, readdir, lstat, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FixtureRegistry } from "./fixture-registry.js";
import { buildRunnerCampaign } from "./history.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import { buildRuntimeUsage, summarizeExecutionBilling } from "./billing.js";
import { stageDashboardBrandAssets } from "./report-assets.js";
import { classifyFailure } from "./failure-classifier.js";
import { packageEvidence } from "./evidence.js";
import { assertSecretFree, sanitizeJson } from "./redaction.js";
import { connectionCell, connectionHarnesses, connectionModes, connectionScopeGaps, supportsConnection } from "./connection-cases.js";
import { assertOutsideRepository, ConnectionBlock, ConnectionFailure, loadConnectionConfig, resolveConnectionSecret, resolveConnectionSettings, type ConnectionConfig } from "./connection-config.js";
import { connectionEvidencePasses, connectionRunDiagnostic, gradeConnectionEvidence, type ConnectionEvidence } from "./connection-evidence.js";
import { ConnectionApi, connectionDelay, startConnectionTarget, verifyConnectionTarget } from "./connection-target.js";
import { runConnectionFlow } from "./connection-flow.js";
import type { MatrixExecution, RunnerE2EResult } from "./types.js";

type Row = Record<string, any>;

export async function openConnectionBrowser(config: ConnectionConfig, repositoryRoot: string, origin: string) {
  const temporary = config.browser.freshness === "signed-out" || !config.browser.profileDir;
  const profile = temporary ? await mkdtemp(path.join(os.tmpdir(), "paperclip-qa-browser-")) : path.resolve(config.browser.profileDir!);
  await assertOutsideRepository(profile, repositoryRoot);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const stat = await lstat(profile);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new ConnectionBlock("blocked_target", "browser_profile_requires_private_directory");
  const marker = path.join(profile, ".paperclip-provider-qa");
  const entries = await readdir(profile);
  if (entries.length && !entries.includes(path.basename(marker))) throw new ConnectionBlock("blocked_target", "use_a_dedicated_empty_qa_browser_profile");
  if (!entries.length) await writeFile(marker, "Dedicated Paperclip provider QA browser. Contains private authentication state.\n", { mode: 0o600, flag: "wx" });
  const lock = path.join(profile, ".paperclip-qa.lock");
  try { await (await open(lock, "wx", 0o600)).close(); }
  catch { throw new ConnectionBlock("blocked_target", "qa_browser_profile_in_use"); }
  let context: BrowserContext;
  try {
    const browserEnv = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    context = await chromium.launchPersistentContext(profile, {
      channel: config.browser.channel === "chrome" ? "chrome" : undefined,
      headless: !config.browser.headed, baseURL: origin, viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce",
      env: browserEnv, acceptDownloads: true,
      // Teardown needs this context's authenticated request client to cancel
      // login sessions and revoke fixtures before the browser is closed.
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      // Deliberately use the Playwright library without Test's automatic reporters,
      // traces, HARs, videos, snapshots, assertion call logs, or failure screenshots.
    });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(30_000);
  } catch {
    await rm(lock, { force: true });
    if (temporary) await rm(profile, { recursive: true, force: true });
    throw new ConnectionBlock("blocked_target", "qa_browser_launch_failed");
  }
  return { context, close: async () => { try { await context.close(); } finally { await rm(lock, { force: true }); if (temporary) await rm(profile, { recursive: true, force: true }); } } };
}

export function safeConnectionFailure(error: unknown, phase: string) {
  if (error instanceof ConnectionBlock) return error.code;
  // Arbitrary Playwright/provider messages can contain filled values and URLs.
  const known = error instanceof ConnectionFailure;
  const frame = error instanceof Error ? error.stack?.match(/connection-(?:flow|target|launch)\.ts:\d+:\d+/)?.[0] : undefined;
  return known ? error.message : `${phase}_failed${frame ? ` (${frame})` : ""}`;
}

function sourceRevision(repositoryRoot: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return { sha: git(["rev-parse", "HEAD"]), ref: `${git(["branch", "--show-current"])}${git(["status", "--porcelain"]) ? " (working tree)" : ""}`, workflowRunUrl: null };
}

async function safeWrite(file: string, value: unknown, secrets: readonly string[]) {
  const text = `${JSON.stringify(sanitizeJson(value, secrets), null, 2)}\n`;
  assertSecretFree(text, secrets, path.basename(file));
  await writeFile(file, text, { mode: 0o600 });
}

async function connectionAttempt(execution: MatrixExecution, config: ConnectionConfig, origin: string, summaryDir: string, repositoryRoot: string): Promise<RunnerE2EResult> {
  const startedAt = new Date().toISOString();
  const nonce = randomBytes(6).toString("hex");
  const privateDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-connection-proof-"));
  const evidenceDir = path.join(summaryDir, execution.suite.id, execution.profile.id, execution.environment.id, execution.task.id, "attempt-1");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const { entry, mode } = connectionCell(execution);
  const evidence: ConnectionEvidence = { version: 1, outcome: "running", phase: "target", assisted: false, authFreshness: config.browser.freshness,
    target: { mode: config.target.mode, origin, commit: null, deploymentMode: null }, entry, method: mode, checkpoints: {}, waits: [] };
  const secrets: string[] = [];
  const checkpoint = async (phase: string) => { evidence.phase = phase; await safeWrite(path.join(summaryDir, "progress.json"), { executionId: execution.id, ...evidence }, secrets); };
  const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: execution.id, suiteId: execution.suite.id, suiteDefinitionHash: execution.suiteDefinitionHash,
    source: sourceRevision(repositoryRoot), attempt: 1, status: "failed", profileId: execution.profile.id, environmentId: execution.environment.id, caseId: execution.task.id,
    provider: execution.profile.provider, model: execution.profile.model, runtimeMode: execution.profile.generation, startedAt, finishedAt: startedAt, durationMs: 0, cleanup: "not_started", providerConnection: evidence };
  let browser: Awaited<ReturnType<typeof openConnectionBrowser>> | undefined;
  let fixtures: Awaited<ReturnType<FixtureRegistry["setupAll"]>> | undefined;
  const observedRuns = new Map<string, Row>();
  let diagnosticApi: ConnectionApi | undefined;
  const loginSessions = new Map<string, "DELETE" | "POST">();
  const loginObservers: Promise<void>[] = [];
  let stopped: "test_interrupted" | "cell_deadline_reached" | undefined;
  const stopBrowserActions = () => { for (const page of browser?.context.pages() ?? []) void page.close().catch(() => {}); };
  const interrupt = () => { stopped = "test_interrupted"; stopBrowserActions(); };
  const assertActive = () => { if (stopped) throw new ConnectionBlock("blocked_target", stopped); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const deadlineTimer = setTimeout(() => { stopped = "cell_deadline_reached"; stopBrowserActions(); }, execution.task.attemptTimeoutMs?.[execution.environment.id] ?? 30 * 60_000);
  try {
    const identity = await verifyConnectionTarget(origin, config);
    Object.assign(evidence.target, identity);
    evidence.checkpoints.target = true;
    assertActive();
    const settings = resolveConnectionSettings(execution, config);
    result.model = settings.model;
    evidence.model = settings.model;
    if (mode === "subscription" && !config.browser.headed) throw new ConnectionBlock("awaiting_user", "subscription_requires_headed_browser");
    // Resolve only the selected credential, and only after validating the target.
    const secret = await resolveConnectionSecret(config, settings.credentialEnv);
    if (secret) secrets.push(secret);
    browser = await openConnectionBrowser(config, repositoryRoot, origin);
    const page = browser.context.pages()[0] ?? await browser.context.newPage();
    const api = new ConnectionApi(browser.context.request, origin);
    diagnosticApi = api;
    browser.context.on("response", response => {
      const url = new URL(response.url());
      if (url.origin !== origin || response.request().method() !== "POST" || !response.ok()) return;
      const local = /^\/api\/companies\/([a-f0-9-]+)\/ai-connections\/local\/attempts$/.test(url.pathname);
      const cloud = /^\/api\/companies\/([a-f0-9-]+)\/(?:setup-token-login-sessions|adapters\/[^/]+\/login-sessions)$/.test(url.pathname);
      if (!local && !cloud) return;
      loginObservers.push((async () => {
        const body = await response.json();
        if (typeof body.sessionId === "string" && /^[a-zA-Z0-9_-]+$/.test(body.sessionId)) loginSessions.set(`${url.pathname}/${body.sessionId}${cloud ? "/cancel" : ""}`, local ? "DELETE" : "POST");
      })().catch(() => {}));
    });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    try { await api.get("/api/companies"); }
    catch (authError) {
      if (!(authError instanceof ConnectionFailure) || !["api_status_401", "api_status_403"].includes(authError.message)) throw authError;
      if (!config.browser.headed) throw new ConnectionBlock("awaiting_user", "board_login_required");
      evidence.assisted = true;
      evidence.waits.push({ kind: "board_login", startedAt: new Date().toISOString() });
      await checkpoint("awaiting_board_login");
      console.log(`[provider-connections] Sign in to Paperclip at ${origin} in the QA browser; this test resumes automatically.`);
      const deadline = Date.now() + config.browser.loginTimeoutMs;
      let ready = false;
      while (Date.now() < deadline) { assertActive(); try { await api.get("/api/companies"); ready = true; break; } catch { await connectionDelay(1000); } }
      if (!ready) throw new ConnectionBlock("awaiting_user", "board_login_deadline_reached");
      evidence.waits.at(-1)!.finishedAt = new Date().toISOString();
    }
    const registry = new FixtureRegistry();
    const attachedCompany = config.target.mode === "attach" ? config.target.companyId : undefined;
    registry.register<Row>({ id: "connection-company", setup: async () => {
      if (attachedCompany) {
        const company = await api.get(`/api/companies/${attachedCompany}`);
        if (!company.name.startsWith("Connection QA") || (await api.get<Row[]>(`/api/companies/${company.id}/agents`)).some(agent => agent.status !== "terminated") || (await api.get(`/api/companies/${company.id}/ai-connections`)).connections.some((connection: Row) => connection.status !== "revoked")) throw new ConnectionBlock("blocked_target", "attach_requires_empty_dedicated_qa_company");
        return company;
      }
      return api.post("/api/companies", { name: `Connection QA ${nonce}`, description: "Disposable provider-connections QA fixture", budgetMonthlyCents: config.budgetCents });
    }, teardown: async company => {
      await Promise.all(loginObservers);
      for (const [route, method] of loginSessions) {
        try { await api.response(route, method); }
        catch (error) { if (!(error instanceof ConnectionFailure) || error.message !== "api_status_404") throw error; }
      }
      const agents = await api.get<Row[]>(`/api/companies/${company.id}/agents`);
      for (const agent of agents.filter(agent => agent.name === `Connection QA ${nonce}`)) {
        await api.patch(`/api/agents/${agent.id}`, { status: "paused" });
        const liveRuns = await api.get<Row[]>(`/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}&limit=100`);
        const active = liveRuns.filter(run => run.agentId === agent.id && ["queued", "running"].includes(run.status));
        for (const run of active) await api.post(`/api/heartbeat-runs/${run.id}/cancel`);
      }
      if (config.retainCompany) { evidence.cleanupRetained = true; return; }
      // The fixture verified the company was empty before running. Revoke all
      // newly created test connections even if a later UI assertion failed.
      const connections = (await api.get(`/api/companies/${company.id}/ai-connections`)).connections;
      for (const connection of connections.filter((connection: Row) => connection.status !== "revoked")) await api.delete(`/api/tool-connections/${connection.id}`);
      if ((await api.get(`/api/companies/${company.id}/ai-connections`)).connections.some((connection: Row) => connection.status !== "revoked")) throw new ConnectionFailure("connection_revocation_failed");
      if (!attachedCompany) { await api.post(`/api/companies/${company.id}/archive`); evidence.companyArchived = true; }
      else for (const agent of agents.filter(agent => agent.name === `Connection QA ${nonce}`)) await api.delete(`/api/agents/${agent.id}`);
    } });
    registry.register<Row>({ id: "connection-environment", dependencies: ["connection-company"], setup: async values => {
      const company = values.get("connection-company") as Row;
      const environments = await api.get<Row[]>(`/api/companies/${company.id}/environments`);
      const selectedId = config.target.mode === "attach" ? config.target.environmentId : undefined;
      const environment = selectedId ? environments.find(env => env.id === selectedId) : environments.find(env => env.status === "active" && (execution.environment.id === "local" ? env.driver === "local" : env.driver === "sandbox" && env.config?.provider === "daytona"));
      if (!environment || (execution.environment.id === "local" ? environment.driver !== "local" : environment.config?.provider !== "daytona")) throw new ConnectionBlock("blocked_target", "configured_execution_environment_required");
      if (execution.profile.generation === "native") {
        const experimental = await api.get("/api/instance/settings/experimental");
        if (!experimental.enableNativeRunner) {
          if (config.target.mode === "attach") throw new ConnectionBlock("blocked_target", "native_runner_disabled_on_target");
          await api.patch("/api/instance/settings/experimental", { enableNativeRunner: true });
        }
      }
      return environment;
    } });
    fixtures = await registry.setupAll();
    const company = fixtures.values.get("connection-company") as Row;
    evidence.companyId = company.id;
    const environment = fixtures.values.get("connection-environment") as Row;
    const observed = await runConnectionFlow({ page, api, execution, config, settings, company, environment, secret, nonce, privateDir, evidence, checkpoint, assertActive, observeRun: run => observedRuns.set(run.id, run) });
    Object.assign(result, observed);
    evidence.outcome = "passed";
    if (!connectionEvidencePasses(evidence)) throw new ConnectionFailure("connection_proof_incomplete");
    // Only the fixture's synthetic task is captured, after authentication.
    const expectedPath = `/${company.issuePrefix}/issues/${observed.issueIdentifier}`;
    const url = new URL(page.url());
    if (url.origin !== origin || url.pathname !== expectedPath) throw new ConnectionFailure("final_screenshot_route_mismatch");
    const screenshot = await page.screenshot({ path: path.join(privateDir, "final-state.png"), fullPage: true });
    result.screenshots = [{ id: "final-state", label: "Verified connection task and follow-up", file: "final-state.png", sha256: createHash("sha256").update(screenshot).digest("hex") }];
    result.status = "passed";
  } catch (caught) {
    const error = stopped ? new ConnectionBlock("blocked_target", stopped) : caught;
    if (error instanceof AggregateError) result.cleanup = "failed";
    evidence.outcome = error instanceof ConnectionBlock ? error.reason : "failed";
    result.failureClass = error instanceof ConnectionBlock ? "permanent_infrastructure" : classifyFailure(error);
    result.error = safeConnectionFailure(error, evidence.phase);
  } finally {
    clearTimeout(deadlineTimer);
    try { await fixtures?.teardown(); if (result.cleanup !== "failed") result.cleanup = "passed"; }
    catch (cleanupError) { result.cleanup = "failed"; result.status = "failed"; result.failureClass = "cleanup_failure"; result.error = `${result.error ? `${result.error}; ` : ""}fixture_cleanup_failed`;
      const causes = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      console.log(`[provider-connections] Cleanup: ${causes.map(cause => safeConnectionFailure(cause, "cleanup")).join(", ")}`); }
    // Project errors before a managed target removes its DB/logs.
    if (diagnosticApi && observedRuns.size) {
      evidence.runDiagnostics = [];
      for (const observed of observedRuns.values()) {
        let run = observed; let log: unknown;
        try { run = await diagnosticApi.get(`/api/heartbeat-runs/${observed.id}`); observedRuns.set(observed.id, run); } catch { /* Keep the last durable observation. */ }
        try { log = await diagnosticApi.get(`/api/heartbeat-runs/${observed.id}/log?limitBytes=2000000`); } catch { /* Mark missing log evidence explicitly. */ }
        evidence.runDiagnostics.push(connectionRunDiagnostic(run, log));
      }
    }
    try { await browser?.close(); }
    catch { result.cleanup = "failed"; result.status = "failed"; result.failureClass = "cleanup_failure"; result.error = "qa_browser_cleanup_failed"; }
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.parse(result.finishedAt) - Date.parse(startedAt);
    result.runIds = [...observedRuns.keys()];
    // Usage is projected to numeric billing below; opaque provider output is never retained.
    const usage = { runs: [...observedRuns.values()].map(run => ({ usage: run.usageJson })) };
    result.runtimeUsage = buildRuntimeUsage({ environmentId: execution.environment.id, runs: [...observedRuns.values()], fallbackFinishedAt: result.finishedAt });
    result.billing = summarizeExecutionBilling({ ...result, usage });
    // UI environment probes may incur cost without heartbeat usage receipts.
    result.billing.complete = false;
    result.billing.llm.costStatus = result.billing.llm.runsWithTokenUsage ? "partial" : "unavailable";
    result.matcherResults = gradeConnectionEvidence(evidence);
    await safeWrite(path.join(privateDir, "result.json"), result, secrets);
    const manifest = await packageEvidence({ privateDir, uploadDir: evidenceDir, secrets, expectPassScreenshot: false });
    if (manifest.leaks.length || manifest.missing.length) { result.status = "failed"; result.failureClass = "secret_leak"; result.error = "evidence_packaging_failed"; evidence.outcome = "failed"; }
    await safeWrite(path.join(evidenceDir, "result.json"), result, secrets);
    await safeWrite(path.join(evidenceDir, "evidence-manifest.json"), manifest, secrets);
    await safeWrite(path.join(summaryDir, "progress.json"), { executionId: execution.id, ...evidence }, secrets);
    await rm(privateDir, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  return result;
}

export async function runConnectionCampaign(input: { executions: readonly MatrixExecution[]; catalog: readonly MatrixExecution[]; configFile?: string; repositoryRoot: string }) {
  if (input.executions.some(e => e.task.flow !== "provider_connection")) throw new ConnectionFailure("Select provider-connections separately from other suites.");
  const config = await loadConnectionConfig(input.configFile);
  const campaignId = `connections-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const summaryDir = path.join(input.repositoryRoot, "tests/runner-e2e/results", campaignId);
  await mkdir(summaryDir, { recursive: true, mode: 0o700 });
  const results: RunnerE2EResult[] = [];
  const target = await startConnectionTarget(config, input.executions, input.repositoryRoot);
  try {
    console.log(`[provider-connections] ${input.executions.length} selected cells; target ${target.origin}; one browser/account at a time; max ${config.maxRuns} task runs and ${config.budgetCents} cents per fixture. UI probe spend may be unreported.`);
    for (const execution of input.executions) {
      console.log(`[provider-connections] Starting ${execution.id}`);
      const result = await connectionAttempt(execution, config, target.origin, summaryDir, input.repositoryRoot);
      results.push(result);
      console.log(`[provider-connections] ${result.providerConnection!.outcome}: ${execution.id}${result.error ? ` (${result.error})` : ""}`);
      // Every completed/blocked cell is durable before the next login begins.
      await writeConnectionCampaignReport(input, campaignId, summaryDir, results);
      if (result.error === "test_interrupted" || result.providerConnection!.outcome === "awaiting_user") break;
    }
  } finally { await target.stop(); }
  console.log(`[provider-connections] Report: ${path.join(summaryDir, "dashboard.html")}`);
  if (results.some(result => result.status !== "passed" || result.cleanup !== "passed")) process.exitCode = 1;
  return summaryDir;
}

export async function writeConnectionCampaignReport(input: { executions: readonly MatrixExecution[]; catalog: readonly MatrixExecution[] }, campaignId: string, summaryDir: string, results: RunnerE2EResult[]) {
  const generatedAt = new Date().toISOString();
  const expected = input.executions.map(e => e.id);
  const campaign = buildRunnerCampaign({ campaignId, generatedAt, expected, results });
  await safeWrite(path.join(summaryDir, "campaign.json"), campaign, []);
  await safeWrite(path.join(summaryDir, "normalized-results.json"), { ...campaign, results: results.map(result => ({ ...result, evidenceValid: result.failureClass !== "secret_leak", evidenceErrors: result.failureClass === "secret_leak" ? ["evidence_packaging_failed"] : [] })) }, []);
  await stageDashboardBrandAssets(summaryDir);
  await safeWrite(path.join(summaryDir, "connection-coverage.json"), {
    required: input.catalog.filter(e => e.suite.id === "provider-connections").length,
    selected: expected.length, attempted: results.length, passed: results.filter(r => r.status === "passed" && r.cleanup === "passed").length,
    blocked: results.filter(r => ["awaiting_user", "missing_credential", "blocked_target"].includes(r.providerConnection!.outcome)).length,
    targets: [...new Set(results.map(r => r.providerConnection!.target.origin))],
    gaps: [...connectionScopeGaps, ...connectionHarnesses.flatMap(h => connectionModes.filter(mode => !supportsConnection(h, mode)).map(mode => ({ adapter: h.adapter, mode, status: "unsupported" })))],
  }, []);
  const dashboard = renderRunnerE2EDashboard({ title: `Live provider connections · ${campaignId}`, generatedAt, expected, catalog: input.catalog, campaign,
    entries: results.map(result => ({ result, valid: result.failureClass !== "secret_leak", errors: result.failureClass === "secret_leak" ? ["evidence_packaging_failed"] : [], evidenceBaseHref: [result.suiteId, result.profileId, result.environmentId, result.caseId, "attempt-1"].join("/") })) });
  await writeFile(path.join(summaryDir, "dashboard.html"), dashboard, { mode: 0o600 });
}
