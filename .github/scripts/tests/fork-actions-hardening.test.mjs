import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("PR CI is fork-controlled", async () => {
  const workflow = await read("workflows/pr.yml");
  assert.match(workflow, /uses: \.\/\.github\/workflows\/pr-trusted\.yml/);
  assert.doesNotMatch(workflow, /paperclipai\/paperclip\/\.github\/workflows/);
});

test("publication jobs are canonical-upstream only", async () => {
  const [release, docker, runtime, cloud] = await Promise.all([
    read("workflows/release.yml"),
    read("workflows/docker.yml"),
    read("workflows/agent-runtime-images.yml"),
    read("workflows/cloud-migrator-artifacts.yml")
  ]);
  assert.match(release, /publish_canary:\n    if: github\.repository == 'paperclipai\/paperclip'/);
  assert.match(release, /publish_stable:\n    if: github\.repository == 'paperclipai\/paperclip'/);
  assert.match(docker, /build-and-push:\n    if: github\.repository == 'paperclipai\/paperclip'/);
  assert.match(docker, /ghcr\.io\/paperclipai\/paperclip/);
  assert.doesNotMatch(docker, /ghcr\.io\/smadjapaul\/paperclip/);
  assert.match(runtime, /build-and-sign:\n    if: github\.repository == 'paperclipai\/paperclip'/);
  assert.match(cloud, /if: github\.repository == 'paperclipai\/paperclip'/);
});

test("fork scheduled paid campaigns are gated while dispatch remains", async () => {
  for (const path of ["workflows/runner-live-evals.yml", "workflows/runner-protocol-live-evals.yml", "workflows/runner-full-stack-e2e.yml", "workflows/runner-chaos-evals.yml"]) {
    const workflow = await read(path);
    assert.match(workflow, /github\.event_name == 'workflow_dispatch'/, path);
    assert.match(workflow, /github\.repository == 'paperclipai\/paperclip'/, path);
  }
});

test("changed third-party actions use immutable SHAs", async () => {
  const changedWorkflows = [
    "workflows/agent-runtime-images.yml",
    "workflows/commitperclip-review.yml",
    "workflows/docker.yml",
    "workflows/pr.yml",
    "workflows/release.yml",
    "workflows/runner-chaos-evals.yml",
    "workflows/runner-full-stack-e2e.yml",
    "workflows/runner-live-evals.yml",
    "workflows/runner-protocol-live-evals.yml"
  ];
  for (const path of changedWorkflows) {
    const workflow = await read(path);
    for (const match of workflow.matchAll(/uses:\s+([^\s]+)@(v[^\s#]+)/g)) {
      assert.fail(`${path} contains mutable action ref ${match[0]}`);
    }
  }
});
