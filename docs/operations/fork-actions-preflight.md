# Paperclip fork Actions preflight

Baseline: `373e536aaa6648070a5774490dde2b01a480099b` (Paperclip PR #5 fork
head). This document describes the fork policy. It does not enable Actions,
change repository settings, or grant secrets.

| Workflow or capability | Trigger | Permissions | Secrets | Side effects | Applies to fork | Cost risk | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pr.yml` / `pr-trusted.yml` | `pull_request` | `actions:read`, `contents:read`, `pull-requests:read` | none | tests, artifacts | yes | low | local reusable workflow; pass when checks pass |
| Commitperclip | `pull_request_target` | PR/check write, contents read | `COMMITPERCLIP_KEY` only upstream | PR review comment/check | neutral only | low | fork `SKIPPED`; never `SECURITY_PASS` |
| Dependency Review | PR review job | inherited read | none | dependency gate | only where graph exists | low | upstream only; fork unavailable is neutral |
| Docker / agent runtime images | push, dispatch, tag | contents read; packages write upstream | `GITHUB_TOKEN` upstream | GHCR publication | no | medium | job guard requires canonical upstream repo |
| npm/cloud release | push, dispatch | write/id-token upstream | trusted publisher/AWS upstream | npm, image, cloud publication | no | high | publish jobs require canonical upstream repo |
| Runner live/protocol/full-stack/chaos | schedule, dispatch | contents read; paid environment upstream | provider secrets upstream | paid/provider calls | manual only | high | fork schedules skip; `workflow_dispatch` remains available |
| GHCR owner | build metadata | packages write upstream | `GITHUB_TOKEN` upstream | `ghcr.io/paperclipai/*` | no publication | medium | owner is explicit and guarded |

The fork must not use an upstream reusable workflow reference for its primary
PR gate. Third-party Actions in fork-controlled workflows are pinned to full
commit SHAs. A skipped or unavailable security capability is an explicit
neutral result and is never converted into a security pass.

### Review rules

- Do not add `COMMITPERCLIP_KEY` to fork jobs or environments.
- Do not enable Actions administratively as part of this change.
- Keep manual qualification workflows available for an operator who knowingly
  starts them.
- Treat any unexecuted check as `not-executed` with its reason, risk, and CI
  treatment in the handoff record.
