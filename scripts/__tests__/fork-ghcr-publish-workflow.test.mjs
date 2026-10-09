import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const workflow = readFileSync(
  path.join(repoRoot, ".github/workflows/fork-ghcr-publish.yml"),
  "utf8",
);

test("fork publication is manual and restricted to exact fork master source", () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/m);
  assert.match(workflow, /test "\$\{REPOSITORY,,\}" = "smadjapaul\/paperclip"/);
  assert.match(workflow, /test "\$REF" = "refs\/heads\/master"/);
  assert.match(workflow, /\[\[ "\$REQUESTED_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(workflow, /test "\$checked_out_sha" = "\$REQUESTED_SHA"/);
  assert.match(workflow, /test "\$remote_master_sha" = "\$REQUESTED_SHA"/);
});

test("fork publication grants registry write only to the publishing job", () => {
  const verifyJob = workflow.split("  build-and-publish:")[0];
  const publishJob = workflow.split("  build-and-publish:")[1];
  assert.doesNotMatch(verifyJob, /packages:\s*write/);
  assert.match(publishJob, /packages:\s*write/);
  assert.equal((workflow.match(/packages:\s*write/g) ?? []).length, 1);
  assert.match(workflow, /permissions: \{\}/);
});

test("fork publication is amd64-only and has supply-chain and migration gates", () => {
  assert.match(workflow, /tags: ghcr\.io\/smadjapaul\/paperclip:sha-\$\{\{ needs\.verify-source\.outputs\.source_sha \}\}/);
  assert.match(workflow, /platforms: linux\/amd64/);
  assert.doesNotMatch(workflow, /platforms:\s*linux\/arm64/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.match(workflow, /uses: actions\/attest@[0-9a-f]{40}/);
  assert.match(workflow, /docker buildx imagetools inspect "\$IMAGE"/);
  assert.match(workflow, /\/app\/packages\/db\/src\/migrations/);
  assert.match(workflow, /missing latest migration/);
  assert.match(workflow, /missing migration journal/);
  assert.match(workflow, /migration count \$\{files\.length\} != \$\{expected\}/);
});

test("all actions in the fork publication workflow are immutable references", () => {
  for (const match of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
    assert.match(match[1], /@[0-9a-f]{40}$/);
  }
});
