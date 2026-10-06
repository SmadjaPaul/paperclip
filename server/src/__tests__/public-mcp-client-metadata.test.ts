import { describe, expect, it, vi } from "vitest";
import { createClientMetadataResolver } from "../services/public-mcp/client-metadata.js";
import { mcpInvitation, mcpSetupMarkdown } from "@paperclipai/shared";
import { renderMcpSetup } from "../services/public-mcp/setup.js";

const id = "https://assistant.example/client.json";
const document = { client_id: id, client_name: "Example", redirect_uris: ["http://127.0.0.1:1234/callback"] };
const response = (data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", ...headers } });
describe("public MCP client metadata", () => {
  it("validates the client identity and bounds cache reuse", async () => {
    const fetch = vi.fn(async () => response(document, { "cache-control": "max-age=300" }));
    const resolve = createClientMetadataResolver(fetch);
    expect((await resolve(id)).client_name).toBe("Example");
    await resolve(id); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL(id));
  });
  it.each([
    { ...document, client_id: "https://other.example/client.json" },
    { ...document, redirect_uris: ["https://name:secret@example.com/callback"] },
    { ...document, token_endpoint_auth_method: "client_secret_post" },
    { ...document, client_name: "x".repeat(33000) },
  ])("rejects mismatched or unsafe metadata", async data => {
    await expect(createClientMetadataResolver(async () => response(data))(id)).rejects.toThrow();
  });
  it("never follows redirects and honors no-store", async () => {
    await expect(createClientMetadataResolver(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }))(id)).rejects.toThrow();
    const fetch = vi.fn(async () => response(document, { "cache-control": "no-store" }));
    const resolve = createClientMetadataResolver(fetch); await resolve(id); await resolve(id);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["https://127.0.0.1/client.json", "https://169.254.169.254/client.json", "https://[::1]/client.json", "http://assistant.example/client.json"])("rejects private or insecure metadata URL %s", async url => {
    await expect(createClientMetadataResolver()(url)).rejects.toThrow();
  });
});
describe("assistant invitation content", () => {
  it("contains no credential and tells a cold client to verify actual access", () => {
    const resource = "https://paperclip.example/mcp/paperclip";
    const company = { id: "44444444-4444-4444-8444-444444444444", name: "Butter" };
    expect(mcpInvitation(resource, company)).toContain("company=" + company.id);
    const markdown = mcpSetupMarkdown(resource, company.id);
    expect(markdown).toContain("paperclip_connection");
    expect(markdown).toContain("restart");
    expect(markdown).not.toContain("paperclip_whoami");
    expect(markdown).not.toContain("pcmcp_at_");
    expect(renderMcpSetup(resource, company.id)).toContain("Instructions for assistants");
    expect(renderMcpSetup(resource, company.id)).not.toContain(company.name);
  });
});
