import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const workflowPath = new URL("../../workflows/commitperclip-review.yml", import.meta.url);
const workflow = await readFile(workflowPath, "utf8");

test("keeps Dependency Review enabled for the upstream repository", () => {
  assert.match(workflow, /review:\n    if: github\.repository == 'paperclipai\/paperclip'/);
  assert.match(workflow, /if: github\.repository == 'paperclipai\/paperclip'[\s\S]*?uses: actions\/dependency-review-action@/);
  assert.match(workflow, /base-ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /head-ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
});

test("documents, without granting extra permissions, the unavailable fork capability", () => {
  assert.match(workflow, /fork-review:\n    name: "review \(fork: neutral\/skipped\)"/);
  assert.match(workflow, /if: github\.repository != 'paperclipai\/paperclip'[\s\S]*?SKIPPED \(neutral\)/);
  assert.match(workflow, /review:\n    if: github\.repository == 'paperclipai\/paperclip'[\s\S]*?permissions:\n      pull-requests: write\n      checks: write\n      contents: read/);
  assert.match(workflow, /fork-review:[\s\S]*?permissions: \{\}/);
  assert.match(workflow, /Required result: neutral only; this is not a security PASS/);
  assert.doesNotMatch(workflow, /security-events:\s*write/);
});
