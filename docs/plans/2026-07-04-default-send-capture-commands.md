# Default Send Capture Commands Plan

**Goal:** Make `readiness doctor` surface safe capture commands for the default fixture-audit gaps that already block the manual-cookie release target: `successful_sendMessage_fixture`, `streaming_text_fixture`, and `tool_call_fixture`.

**Architecture:** Keep all readiness and fixture audit gates unchanged. Add capture specs for the default send-related missing names and continue building doctor capture commands from the union of calibration backlog missing names and default fixture-audit missing names. These commands are operator guidance only; they must not imply evidence exists.

**Safety boundary:**
- Commands must use `<account-id>` / `<redacted-input.json>` placeholders only.
- Commands must not include cookie, session, JWT, API key, Bearer, endpoint values, raw payloads, prompts, raw fixture content, or real user data.
- `readiness doctor` must remain read-only: no verifier call, no protocol probe, no fixture write, no `readiness.json` write.
- `tool_call_fixture` may be satisfied either by real sanitized tool-call evidence or by an explicit sanitized unsupported-native-tool fixture. The command must not imply Tabbit native tool fields are supported.
- Missing fixtures must continue to keep default audit and `manualCookieMode` blocked until real sanitized evidence exists.

## Task 1: RED Tests

- Add an observability test that a doctor report with missing default send evidence includes capture commands for successful send, streaming text, and tool/unsupported evidence.
- Add an ops CLI plain-output test that prints corresponding `capture_command` lines without invoking verifier or protocol probe dependencies.

## Task 2: Implementation

- Add `successful_sendMessage_fixture`, `streaming_text_fixture`, and `tool_call_fixture` to `CALIBRATION_CAPTURE_SPECS`.
- Use `sendMessage` as the operation and require `TABBIT_POOL_PROTOCOL_SEND_PATH`.
- Use a stream template for `streaming_text_fixture`.
- For `tool_call_fixture`, explain that the evidence can be a sanitized tool-call fixture or a sanitized unsupported-native-tool fixture.

## Task 3: Documentation

- Update README, M08 docs, and real protocol acceptance docs to state that default send capture commands are guidance only and do not satisfy readiness without real sanitized fixtures.
- Update this plan with RED/GREEN and verification evidence.

## Task 4: Verification

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "default send capture commands"
node --test test\ops-cli.test.js --test-name-pattern "default send capture commands"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Then rerun readiness doctor, session/upstream audits, forbidden-path scan, and credential-shape scan.

## Execution Evidence

RED:
- Added focused coverage in `test/observability.test.js` and `test/ops-cli.test.js` before the implementation.
- `node --test test\observability.test.js --test-name-pattern "default send capture commands"` failed because `successful_sendMessage_fixture`, `streaming_text_fixture`, and `tool_call_fixture` were absent from doctor `captureCommands`.
- `node --test test\ops-cli.test.js --test-name-pattern "default send capture commands"` failed because plain `readiness doctor` did not print the three default send `capture_command` lines.

GREEN:
- Added `successful_sendMessage_fixture`, `streaming_text_fixture`, and `tool_call_fixture` capture specs in `src/observability.js`.
- All three use operation `sendMessage`, `sideEffect:false`, `TABBIT_POOL_PROTOCOL_SEND_PATH` prerequisite status, and placeholder-only template/validate/probe commands.
- `streaming_text_fixture` recommends `stream:true`; `tool_call_fixture` states that either sanitized tool-call evidence or sanitized unsupported-native-tool evidence can satisfy the audit. This does not claim Tabbit native tool fields are supported.
- Updated README, M08 ops docs, and real protocol acceptance docs to state that these commands are guidance only and do not satisfy readiness without real sanitized fixtures.

Verification on 2026-07-04:
- `node --test test\observability.test.js --test-name-pattern "default send capture commands"` -> 45/45 pass.
- `node --test test\ops-cli.test.js --test-name-pattern "default send capture commands"` -> 111/111 pass.
- `node --test test\ops-cli.test.js` -> 111/111 pass.
- `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
- `npm test` -> 420/420 pass.
- `git diff --check` -> exit 0; LF/CRLF warnings only.
- With `TABBIT_POOL_PROTOCOL_SEND_PATH=/api/v1/chat/completion` and `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH=/api/v0/user/base-info`, `readiness doctor --json` remains `blocked` because default stateDir has no real sanitized verify/send/stream/tool/403 fixtures. The report now includes `successful_sendMessage_fixture`, `streaming_text_fixture`, and `tool_call_fixture` capture commands with `scope:"protocol"`, `operation:"sendMessage"`, `sideEffect:false`, and configured send-path prerequisite.
- `fixtures audit --scope session --json` remains `blocked` with missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and backlog `automated_session_refresh_strategy`.
- `fixtures audit --scope upstream --json` remains `blocked` with missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.
- Forbidden path scan -> 38 changed/untracked paths, 0 hits.
- Strict credential-shape diff scan -> 31 scanned files, 4367 added/untracked lines, 0 non-placeholder hits.
