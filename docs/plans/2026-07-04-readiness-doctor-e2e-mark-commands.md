# Readiness Doctor E2E Mark Commands Plan

**Goal:** Make `readiness doctor` surface safe commands for the manual Codex / Claude Code E2E verification marks that still block `manualCookieMode`, without running the validation or writing state during doctor.

**Architecture:** Extend `readinessDoctorCommands()` with explicit mark commands. Plain doctor output should show the commands on separate `mark_command` lines. The commands remain operator guidance only and are valid only after a real manual E2E run has been completed and documented.

**Safety boundary:**
- Doctor must stay read-only: no `readiness.json` write, no gateway start, no verifier, no protocol probe.
- Mark commands must not include API keys, model names, base URLs, prompts, payloads, cookies, sessions, tokens, or user data.
- Mark commands must not satisfy `codex_e2e_verified` or `claude_code_e2e_verified` by themselves. They only tell an operator how to persist a completed manual verification result.
- Existing readiness and manual-cookie gates must remain unchanged.

## Task 1: RED Tests

- Add an observability test that doctor JSON exposes safe `commands.codexE2EMark`, `commands.claudeE2EMark`, and `commands.combinedE2EMark`.
- Add an ops CLI plain-output test that prints `mark_command` lines and proves doctor still does not write readiness state.

## Task 2: Implementation

- Add the three mark commands to `readinessDoctorCommands()`.
- Print plain `mark_command` lines from `readiness doctor`.

## Task 3: Documentation

- Update README, M08 ops docs, and real protocol acceptance docs to clarify that mark commands are post-validation persistence hints only.
- Update this plan with RED/GREEN and verification evidence.

## Task 4: Verification

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "E2E mark commands"
node --test test\ops-cli.test.js --test-name-pattern "E2E mark commands"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Then rerun readiness doctor, session/upstream audits, forbidden-path scan, and credential-shape scan.

## Execution Status

- RED coverage added:
  - `test/observability.test.js` asserts doctor JSON exposes `commands.codexE2EMark`, `commands.claudeE2EMark`, and `commands.combinedE2EMark`.
  - `test/ops-cli.test.js` asserts plain `readiness doctor` prints `mark_command` lines and remains read-only.
- GREEN implementation:
  - `src/observability.js` now exposes safe post-validation E2E mark commands through `readinessDoctorCommands()`.
  - `src/ops-cli.js` now prints `mark_command	codex_e2e`, `mark_command	claude_code_e2e`, and `mark_command	combined_e2e` in plain doctor output.
  - README, M08 ops docs, and real protocol acceptance docs clarify that mark commands are persistence hints only after real manual E2E validation.
- Focused verification:
  - `node --test test\observability.test.js --test-name-pattern "E2E mark commands"` -> 46/46 pass.
  - `node --test test\ops-cli.test.js --test-name-pattern "E2E mark commands"` -> 112/112 pass.
- Required verification:
  - `node --test test\ops-cli.test.js` -> 112/112 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `npm test` -> 422/422 pass.
  - `git diff --check` -> exit 0; only LF-to-CRLF working-copy warnings.
- Default stateDir aggregate checks with `TABBIT_POOL_PROTOCOL_SEND_PATH=/api/v1/chat/completion` and `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH=/api/v0/user/base-info`:
  - `node bin\tabbit-pool.js readiness doctor --json` -> `status=blocked`, `fixtureAudit.status=blocked`, `manualCookieMode.status=blocked`; missing sanitized evidence includes successful verifySession/sendMessage, streaming/tool, 403, expired verifySession, and Codex/Claude E2E marks.
  - `node bin\tabbit-pool.js fixtures audit --json` -> `status=blocked`; missing `successful_verifySession_fixture`, `successful_sendMessage_fixture`, `streaming_text_fixture`, `tool_call_fixture`, `forbidden_403_fixture`.
  - `node bin\tabbit-pool.js fixtures audit --scope session --json` -> `status=blocked`; missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, `automated_session_refresh_strategy`. The automated refresh gap remains backlog and does not block the manual-cookie release target by itself.
  - `node bin\tabbit-pool.js fixtures audit --scope upstream --json` -> `status=blocked`; missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, `real_upstream_backpressure_fixture`.
