# Invite an assistant to Paperclip with one message

Date: 2026-10-05

## Outcome

From Butter → Connections → Assistant Connection (MCP), copy a message or URL,
paste it into an assistant, approve the identified client in Paperclip, and use
the organization's tools as the consenting human. Sharing an invitation grants
no access. Keep the existing experimental setting and simplified consent UI.

## Delivery

1. Shared, version-aware setup instructions, public HTML/Markdown setup page,
   invitation metadata, primary Copy invitation / secondary Copy link actions,
   and manual setup disclosure. Organization hints never confer authority.
2. Browser OAuth: CIMD alongside DCR, guarded bounded metadata retrieval,
   issuer identification, accurate resource scopes, existing PKCE and opaque
   revocable tokens.
3. Device OAuth: separate hashed pending codes, ten-minute expiry, five-second
   polling, shared throttling, atomic redemption, existing consent/grants/audit.
   Add CLI device login and a credential-protecting stdio bridge with serialized
   refresh and exact resource binding. No client-credentials or agent identity.
4. Tenant Cloud routing for setup/device endpoints, preserving host and identity
   boundaries. The central broker retains its existing advertised grants.
5. Stories, protocol/security tests, cold-start paid Product E2E cases (Mini,
   Haiku, then Sonnet), actual client checks, required repository checks, PRs,
   Butter deployment, and a real screenshot walkthrough including OpenCode.

## Acceptance

- Cold start: no Paperclip tools/configuration initially; the invitation starts
  setup and consent; verify the resulting account/company before work.
- Existing configuration, unavailable host setup, denied/expired consent,
  later-conversation reconnect, and required client restart are represented.
- Verify company/role isolation, disabled feature, CIMD SSRF and redirect
  rejection, audience binding, code replay, concurrent polling and refresh,
  token expiry/revocation, and absence of secrets from copied text and evidence.
- Browser connectors use host settings where required; do not promise automatic
  installation from chat. Device support uses a compatible client/CLI bridge.
- Retain eval failures, costs, model IDs, revisions, and independent state
  assertions. Verify real clients separately from model API evals.

## Progress

- Implementation started from PR #14933's isolated worktree at 07f638c1b.
- Existing browser OAuth, scoped grants, canonical endpoint, and Connections
  entry point are present. No new invitation authority or agent identity needed.
- Implemented invitation-first setup, public HTML/Markdown instructions, CIMD,
  issuer responses, device authorization/consent, protected CLI credentials and
  the stdio bridge. Added production-component Storybook device states.
- Added five cold-start cases to the explicit Product E2E public-mcp suite,
  including independent grant/configuration checks and calibrated negative cases.
- Typecheck, production build and UI token gates passed. Focused authentication,
  metadata and invitation UI checks: 65 passed. CLI credential checks: 7 passed.
  Eval catalog/model/grader checks: 118 passed. Full-suite verification is in
  progress; a large-file Git streaming test timed out outside this change.
- Mini passed all five invitation cases. Haiku and Sonnet qualification remains
  in progress; retain failed infrastructure attempts and paid billing evidence.
- Cloud routing PR: https://github.com/paperclipai/paperclip-cloud/pull/672.
  Cloud typecheck, 2,242 tests and fake-provider smoke passed; rebased focused
  gateway checks passed 218 tests. Staging routing deployment has been requested.
- Remaining: real client qualification, final paid results, PR checks/review,
  Butter application deployment and the complete screenshot gallery. Butter's
  persistent human grant has not been approved; do not claim a live Butter MCP
  read or delegation before that consent occurs.
