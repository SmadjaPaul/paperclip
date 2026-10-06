import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTaskThroughUi } from "../runner-e2e/user-actions.js";

for (const workMode of ["standard", "planning", "ask"] as const) {
  test(`runner fixture creates a prompt-only ${workMode} task without starting a provider`, async ({ page, request }) => {
    const companyResponse = await request.post("/api/companies", { data: { name: `Runner composer ${randomUUID()}` } });
    expect(companyResponse.ok()).toBe(true);
    const company = await companyResponse.json();
    const agentResponse = await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Paused composer fixture", role: "engineer", adapterType: "codex_local",
      runtimeConfig: { heartbeat: { enabled: false } },
    } });
    expect(agentResponse.ok()).toBe(true);
    const agent = await agentResponse.json();
    expect((await request.post(`/api/agents/${agent.id}/pause`)).ok()).toBe(true);
    const projectResponse = await request.post(`/api/companies/${company.id}/projects`, { data: { name: "Composer project" } });
    expect(projectResponse.ok()).toBe(true);
    const project = await projectResponse.json();
    const prompt = `Preserve this exact prompt for ${workMode}.`;
    const created = await createTaskThroughUi({ page, issuePrefix: company.issuePrefix, agentName: agent.name,
      title: "Fixture label distinct from the generated title", prompt, workMode, projectName: project.name });
    const issue = await (await request.get(`/api/issues/${created.issueId}`)).json();
    expect(issue).toMatchObject({ id: created.issueId, companyId: company.id, assigneeAgentId: agent.id,
      projectId: project.id, description: prompt, workMode });
    expect(issue.title).not.toBe("Fixture label distinct from the generated title");
    expect(created.submittedAtMs).toBeGreaterThan(0);
    expect(await (await request.get(`/api/companies/${company.id}/heartbeat-runs`)).json()).toEqual([]);
  });
}
