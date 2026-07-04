# Readiness Doctor Read-Only Preflight Command Plan

**Goal:** Make `readiness doctor` surface the safe live preflight command for manual-cookie operations so operators can check the current imported cookie/session without mutating account state or writing fixtures.

**Architecture:** Keep `readiness doctor` read-only. Add a static command string under `commands.accountPreflightReadOnly`, and print a plain `preflight_command` line. The command must use placeholders only:

```powershell
node bin\tabbit-pool.js accounts probe <account-id> --read-only --json
```

This does not call the verifier from doctor; it only documents the next safe command.

## Task 1: RED Tests

- Extend `buildReadinessDoctorReport includes safe calibration capture commands` to assert `report.commands.accountPreflightReadOnly`.
- Extend `readiness doctor prints calibration backlog in plain output` to assert a `preflight_command` line.
- Confirm doctor still does not call `accountVerifier.verifyAccount()` or `protocolProbeRunner.probeAccount()`.

## Task 2: Implementation

- Add `accountPreflightReadOnly` to `readinessDoctorCommands()`.
- Add a plain output line in `handleReadinessDoctor()`.

## Task 3: Documentation

- Update README and M08 ops docs to state that doctor exposes a read-only account preflight command.
- Update this plan with RED/GREEN and verification evidence.

## Task 4: Verification

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "capture commands"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor prints calibration backlog"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

Then rerun session/upstream audits plus forbidden-path and credential-shape scans.

## Execution Status

- RED verified:
  - `node --test test\observability.test.js --test-name-pattern "capture commands"` failed because `report.commands.accountPreflightReadOnly` was `undefined`.
  - `node --test test\ops-cli.test.js --test-name-pattern "readiness doctor prints calibration backlog"` failed because plain output did not include `preflight_command	account_read_only`.
- GREEN implemented:
  - Added static `commands.accountPreflightReadOnly` in `readinessDoctorCommands()`.
  - Added plain `preflight_command	account_read_only	...` output in `handleReadinessDoctor()`.
  - Updated README and M08 docs to state that doctor only surfaces the safe read-only account preflight command and does not run verifier/probe or write state.
- Focused GREEN verified:
  - `node --test test\observability.test.js --test-name-pattern "capture commands"`: 43/43 pass.
  - `node --test test\ops-cli.test.js --test-name-pattern "readiness doctor prints calibration backlog"`: 109/109 pass.
- Full verification:
  - `node --test test\ops-cli.test.js`: 109/109 pass.
  - `node --test test\protocol-tabbit-client.test.js`: 61/61 pass.
  - `npm test`: 416/416 pass.
  - `git diff --check`: exit 0; only LF/CRLF warnings.
  - `node bin\tabbit-pool.js readiness doctor --json`: default stateDir remains `blocked` because no real sanitized fixtures are present; `commands.accountPreflightReadOnly` is present.
  - `node bin\tabbit-pool.js fixtures audit --scope session --json`: `blocked`; missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and backlog `automated_session_refresh_strategy`.
  - `node bin\tabbit-pool.js fixtures audit --scope upstream --json`: `blocked`; missing real upstream error-frame/cancellation/backpressure fixtures.
  - Forbidden path scan: 36 changed/untracked paths checked, 0 hits.
  - Strict credential-shape scan: 4084 added/untracked lines checked, 0 non-placeholder hits; 4 broad placeholder hits were synthetic test/doc markers and no raw values were printed.
