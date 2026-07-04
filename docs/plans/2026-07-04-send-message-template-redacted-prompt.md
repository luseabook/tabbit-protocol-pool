# Send Message Template Redacted Prompt Plan

**Goal:** Keep `probe template --operation sendMessage` useful for real fixture capture while avoiding any literal prompt text in generated template output.

**Architecture:** Change only the sendMessage default input body. The CLI template should continue to be valid input for `probe validate --operation sendMessage`, keep `stream:true`, and support `streamEvidence`, but use a placeholder message value instead of a real example message. `ProtocolProbeRunner` should use the same placeholder when `sendMessage` is dispatched without explicit input. Readiness gates, fixture audit semantics, and sanitizer behavior stay unchanged.

**Safety boundary:**
- Do not read or write real cookie/session/state fixture files.
- Do not print or persist real prompts, raw payloads, stream text, cookie/session/JWT/API key/Bearer values, or real user data.
- The placeholder message content is only a redacted input marker; operators must still review `<redacted-input.json>` before validation and probe execution.

## Task 1: RED Tests

- Update sendMessage template tests so `probe template --operation sendMessage --json` returns `messages:[{ role:"user", content:"<redacted-message-content>" }]`.
- Update streamEvidence template tests to use the same placeholder.
- Assert serialized template/validate output does not include the legacy literal `ping` prompt.
- Add a `ProtocolProbeRunner` test proving omitted sendMessage input dispatches `<redacted-message-content>` instead of `ping`.

Expected RED command:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sendMessage"
```

Expected before implementation: FAIL because the template still prints `content:"ping"`.

## Task 2: Implementation

- Replace the sendMessage template prompt value in `src/ops-cli.js` with `<redacted-message-content>`.
- Replace the default sendMessage dispatch value in `src/protocol-probe.js` with `<redacted-message-content>`.
- Do not change validation behavior; non-empty placeholder content remains valid and validation output must still omit message content.

## Task 3: Documentation

- Update README, API docs, test cases, implementation reference, real protocol acceptance docs, M08 ops docs, and this plan to state that sendMessage templates use placeholder message content and actual probe input must be reviewed before use.

## Task 4: Verification

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sendMessage"
node --test test\protocol-probe.test.js --test-name-pattern "redacted default sendMessage"
node --test test\ops-cli.test.js
node --test test\protocol-probe.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Then run readiness doctor/session/upstream aggregate audits, forbidden-path scan, and credential-shape scan.

## Execution Status

- RED verified:
  - `node --test test\ops-cli.test.js --test-name-pattern "sendMessage"` failed because `probe template --operation sendMessage --json` and `--stream-evidence error_frame` still emitted `content:"ping"`.
  - `node --test test\protocol-probe.test.js --test-name-pattern "redacted default sendMessage"` failed because omitted runner input still dispatched `content:"ping"`.
- GREEN implementation:
  - `src/ops-cli.js` now emits `messages:[{ role:"user", content:"<redacted-message-content>" }]` for sendMessage templates, including stream evidence templates.
  - `src/protocol-probe.js` now uses the same placeholder for default sendMessage dispatch when input is omitted.
  - README, API docs, test cases, implementation reference, real protocol acceptance docs, M08 ops docs, and related 2026-07-04 plan docs now describe the placeholder and the required review/validate/probe flow.
- Focused verification:
  - `node --test test\ops-cli.test.js --test-name-pattern "sendMessage"` -> 112/112 pass.
  - `node --test test\protocol-probe.test.js --test-name-pattern "redacted default sendMessage"` -> 31/31 pass.
  - `node bin\tabbit-pool.js probe template --operation sendMessage --json` -> emits `<redacted-message-content>`.
  - `node bin\tabbit-pool.js probe template --operation sendMessage --stream-evidence first_token_backpressure --json` -> emits `<redacted-message-content>` and `streamEvidence:{ mode:"first_token_backpressure", maxDeltas:2 }`.
- Regression verification before final safety scans:
  - `node --test test\ops-cli.test.js` -> 112/112 pass.
  - `node --test test\protocol-probe.test.js` -> 31/31 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `npm test` -> 423/423 pass.
- Aggregate/default-state checks:
  - `readiness doctor --json` with configured send/session paths -> `status=blocked`, `fixtureAudit=blocked`, `manualCookieMode=blocked` because the default stateDir still lacks real sanitized fixtures and E2E marks.
  - `fixtures audit --scope session --json` -> `status=blocked`; missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and backlog `automated_session_refresh_strategy`.
  - `fixtures audit --scope upstream --json` -> `status=blocked`; missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.
- Safety verification:
  - `git diff --check` -> exit 0; only LF-to-CRLF working-copy warnings.
  - Forbidden-path scan -> 41 changed/untracked paths, 0 hits.
  - Credential-shape scan -> 4662 added/untracked lines, 0 hits.
