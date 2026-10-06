import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialPath, mcpAccessToken, mcpResource, mcpRpc, withMcpCredentialLock } from "../client/mcp-auth.js";

const resource = "https://paperclip.example/mcp/paperclip";
let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-credentials-")); vi.stubEnv("PAPERCLIP_HOME", home); });
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });
async function seed(value: unknown, mode = 0o600) {
  const file = credentialPath(resource);
  await fs.mkdir(path.dirname(file), { mode: 0o700 });
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value), { mode });
  return file;
}
const stored = () => ({ resource, issuer: "https://paperclip.example", clientId: "client", companyId: "company", accessToken: "private-access", refreshToken: "private-refresh", expiresAt: 0 });
describe("MCP protected credential transport", () => {
  it("rejects noncanonical resources and isolates credential files by resource", () => {
    for (const url of ["http://evil.example/mcp/paperclip", resource + "?token=secret", resource + "#x", "https://u:p@paperclip.example/mcp/paperclip", "https://paperclip.example/other"]) expect(() => mcpResource(url)).toThrow();
    expect(mcpResource("http://127.0.0.1:3100/mcp/paperclip")).toContain("127.0.0.1");
    expect(credentialPath(resource)).not.toBe(credentialPath("https://other.example/mcp/paperclip"));
  });
  it("serializes rotating refreshes and persists only the replacement token privately", async () => {
    const file = await seed(stored()); let refreshes = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      if (url.includes("oauth-protected-resource")) return Response.json({ resource, authorization_servers: ["https://paperclip.example"] });
      if (url.includes("oauth-authorization-server")) return Response.json({ issuer: "https://paperclip.example", token_endpoint: "https://paperclip.example/mcp/oauth/token", device_authorization_endpoint: "https://paperclip.example/mcp/oauth/device_authorization", registration_endpoint: "https://paperclip.example/mcp/oauth/register" });
      expect(url).toBe("https://paperclip.example/mcp/oauth/token");
      expect(JSON.parse(init!.body as string).refresh_token).toBe("private-refresh"); refreshes++;
      return Response.json({ access_token: "replacement-access", refresh_token: "replacement-refresh", token_type: "Bearer", expires_in: 900 });
    }));
    expect(await Promise.all([mcpAccessToken(resource), mcpAccessToken(resource)])).toEqual(["replacement-access", "replacement-access"]);
    expect(refreshes).toBe(1);
    expect((await fs.stat(file)).mode & 0o077).toBe(0);
    expect(await fs.readFile(file, "utf8")).not.toContain("private-refresh");
  });
  it("never sends a stored credential to another issuer", async () => {
    await seed({ ...stored(), issuer: "https://evil.example" }); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(mcpAccessToken(resource)).rejects.toThrow("Connect first"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed when discovery changes without sending refresh credentials", async () => {
    await seed(stored()); const fetcher = vi.fn(async () => Response.json({ resource, authorization_servers: ["https://evil.example"] })); vi.stubGlobal("fetch", fetcher);
    await expect(mcpAccessToken(resource)).rejects.toThrow("does not match"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects readable or malformed credential files without echoing secrets", async () => {
    const file = await seed(stored(), 0o644);
    await expect(mcpAccessToken(resource)).rejects.toThrow("private");
    await fs.chmod(file, 0o600); await fs.writeFile(file, '{private-secret');
    await expect(mcpAccessToken(resource)).rejects.toThrow("Invalid MCP credential file. Sign in again.");
  });
  it("does not expose upstream response text in protocol errors or retry writes", async () => {
    const fetcher = vi.fn(async () => new Response("private-upstream-token", { status: 200 })); vi.stubGlobal("fetch", fetcher);
    await expect(mcpRpc(resource, "private-access", "tools/call", { name: "paperclip_create_task" })).rejects.toThrow("invalid response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("releases the refresh mutex after failed work", async () => {
    const file = credentialPath(resource);
    await expect(withMcpCredentialLock(file, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(withMcpCredentialLock(file, async () => "recovered")).resolves.toBe("recovered");
  });
});
