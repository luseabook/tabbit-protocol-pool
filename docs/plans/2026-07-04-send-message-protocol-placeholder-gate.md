# Send Message Protocol Placeholder Gate Plan

**Status:** Implemented and verified on 2026-07-04.

**Goal:** Prevent `probe protocol --operation sendMessage` from dispatching generated placeholder message content to Tabbit or writing placeholder-based fixtures.

**Architecture:** Keep `probe template` and `probe validate` unchanged so operators can generate and preflight the redacted input shape. Add a stricter gate only in the real `probe protocol` path: sendMessage requires explicit `messages` with at least one non-placeholder content string. This gate runs before `ProtocolProbeRunner.probeAccount()`, so it does not read account secret material or call the protocol client.

**Safety boundary:**
- Do not touch real cookie/session/state fixture files.
- Do not print raw prompt, payload, cookie, session, JWT, API key, Bearer token, or real user data.
- Error output must not echo the placeholder body or model value.

## Task 1: RED Tests

- Add an ops CLI test proving `probe validate --operation sendMessage` accepts the generated placeholder template.
- Add an ops CLI test proving `probe protocol --operation sendMessage` rejects omitted input or `<redacted-message-content>` input before calling the injected runner.
- Assert stdout is empty, exit code is 2, stderr explains the replacement requirement, and no prompt/model/session text is printed.

Expected RED command:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "placeholder"
```

Expected before implementation: FAIL because `probe protocol` currently dispatches omitted input or placeholder template content.

## Task 2: Implementation

- Add a `assertProbeInputReadyForProtocol()` helper in `src/ops-cli.js`.
- Call it from `handleProbeProtocol()` after schema validation and before `assertProtocolProbeOperationDispatchable()`.
- For sendMessage only, require `input.messages` to be a non-empty array and at least one message content string different from `<redacted-message-content>`.

## Task 3: Documentation

- Update README, API docs, real protocol acceptance docs, M08 ops docs, and this plan to document the split:
  - `probe validate` accepts placeholder templates for shape review.
  - `probe protocol` requires reviewed, non-placeholder message content.

## Task 4: Verification

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "placeholder"
node --test test\ops-cli.test.js
node --test test\protocol-probe.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Then run readiness doctor/session/upstream aggregate audits, forbidden-path scan, and credential-shape scan.

## Execution Evidence

- RED coverage added in `test/ops-cli.test.js`:
  - `probe validate accepts sendMessage placeholder templates but protocol rejects them before dispatch`
  - `probe protocol rejects omitted sendMessage input before dispatch`
- GREEN implementation:
  - `src/ops-cli.js` now has `assertProbeInputReadyForProtocol()` and `messageContentStrings()`.
  - `handleProbeProtocol()` calls the gate after schema validation and before runner dispatch.
  - The gate is sendMessage-only: `probe validate` still accepts generated placeholder templates, while `probe protocol` rejects omitted messages or unreplaced `<redacted-message-content>` before reading account secret material or calling the protocol runner.
- Documentation updated:
  - README, API docs, implementation reference, real protocol acceptance docs, M08 ops docs, and this plan now document the validate/protocol split.
  - M08 protocol examples use a reviewed input file flow instead of sending `<redacted-message-content>` directly.

Verification results:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "placeholder"
# pass: 114/114

node --test test\ops-cli.test.js
# pass: 114/114

node --test test\protocol-probe.test.js
# pass: 31/31

node --test test\protocol-tabbit-client.test.js
# pass: 61/61

npm test
# pass: 425/425

git diff --check
# exit 0; only LF/CRLF working-copy warnings
```

Default stateDir aggregate checks with `TABBIT_POOL_PROTOCOL_SEND_PATH=/api/v1/chat/completion` and `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH=/api/v0/user/base-info`:

- `node bin\tabbit-pool.js readiness doctor --json` -> `status=blocked`, `fixtureAudit=blocked`, `manualCookieMode=blocked`; expected because the default stateDir has no real sanitized fixtures or E2E marks.
- `node bin\tabbit-pool.js fixtures audit --scope session --json` -> `status=blocked`; missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and backlog `automated_session_refresh_strategy`.
- `node bin\tabbit-pool.js fixtures audit --scope upstream --json` -> `status=blocked`; missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.

Safety scans:

- Forbidden path scan -> 42 changed/untracked paths, 0 hits.
- Initial broad credential-shape scan reported 17 structural false positives from field names such as session path/mode/ref keys and synthetic tests; no raw values were printed.
- Strict credential-shape diff scan -> 42 scanned paths, 4859 added/untracked lines, 0 hits.
