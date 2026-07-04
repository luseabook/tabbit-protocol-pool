# Forbidden 403 Capture Command Plan

**Goal:** Make `readiness doctor` surface a safe capture command for the core `forbidden_403_fixture` gap, so operators can persist a sanitized 403/sign-key/forbidden probe only when an actual 403 is observed.

**Architecture:** Keep readiness gates unchanged. Add a capture spec for `forbidden_403_fixture` and build doctor capture commands from both the current calibration backlog and the default fixture audit missing list. Unsupported core missing names remain ignored unless a safe spec exists.

**Safety boundary:**
- The command must use placeholders only.
- The command must not include cookie, session, JWT, API key, Bearer, endpoint values, raw payloads, prompts, raw fixture content, or real user data.
- The command only documents the next safe `probe protocol --write-fixture` path; `readiness doctor` must not run the probe or write state.
- A failed or forbidden fixture must still be counted only by existing fixture audit rules; this change must not make readiness ready without real sanitized evidence.

## Task 1: RED Tests

- Add an observability test that a doctor report with a missing `forbidden_403_fixture` includes a `forbidden_403_fixture` capture command using `verifySession`.
- Add an ops CLI plain-output test that prints a `capture_command	forbidden_403_fixture	...` line without invoking verifier or protocol probe dependencies.

## Task 2: Implementation

- Add `forbidden_403_fixture` to `CALIBRATION_CAPTURE_SPECS`.
- Build `calibrationBacklog.captureCommands` from calibration backlog missing names plus default fixture-audit missing names, deduped by missing name.

## Task 3: Documentation

- Update README and M08 docs to state that 403 capture commands are guidance only and do not satisfy readiness until a real sanitized 403 fixture exists.
- Update this plan with RED/GREEN and verification evidence.

## Task 4: Verification

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "forbidden 403 capture command"
node --test test\ops-cli.test.js --test-name-pattern "forbidden 403 capture command"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Then rerun readiness doctor, session/upstream audits, forbidden-path scan, and credential-shape scan.

## Execution Evidence

RED:
- Added focused coverage in `test/observability.test.js` and `test/ops-cli.test.js` before the implementation.
- The focused tests failed before the code change because `forbidden_403_fixture` was not present in doctor `captureCommands` / plain `capture_command` output.

GREEN:
- Added a `forbidden_403_fixture` capture spec using read-only `verifySession`.
- Built doctor capture commands from the union of extension backlog missing names and default fixture-audit missing names, so default 403 coverage gaps can surface a safe command without changing readiness gates.
- Updated README, M08 ops docs, and real protocol acceptance docs to state that the command is guidance only. It does not satisfy 403 readiness until a real sanitized 403/forbidden fixture exists.

Verification on 2026-07-04:
- `node --test test\observability.test.js --test-name-pattern "forbidden 403 capture command"` -> 44/44 pass.
- `node --test test\ops-cli.test.js --test-name-pattern "forbidden 403 capture command"` -> 110/110 pass.
- `node --test test\ops-cli.test.js` -> 110/110 pass.
- `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
- `npm test` -> 418/418 pass.
- `git diff --check` -> exit 0; LF/CRLF warnings only.
- Forbidden path scan -> 37 changed/untracked paths, 0 hits.
- Strict credential-shape diff scan -> 30 scanned files, 4133 added/untracked lines, 0 non-placeholder hits.
- With `TABBIT_POOL_PROTOCOL_SEND_PATH=/api/v1/chat/completion` and `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH=/api/v0/user/base-info`, `readiness doctor --json` remains `blocked` because default stateDir has no real sanitized verify/send/stream/tool/403 fixtures; the report includes a `forbidden_403_fixture` capture command with `scope:"protocol"`, `operation:"verifySession"`, `sideEffect:false`, and configured session-verify prerequisite.
- `fixtures audit --scope session --json` remains `blocked` with missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and backlog `automated_session_refresh_strategy`.
- `fixtures audit --scope upstream --json` remains `blocked` with missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.
