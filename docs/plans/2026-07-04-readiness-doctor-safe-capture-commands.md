# Readiness Doctor Safe Capture Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe, copyable calibration capture command hints to `readiness doctor --json` so operators can move from backlog items to sanitized probe fixtures without guessing CLI syntax.

**Architecture:** Keep readiness and fixture audit semantics unchanged. Add a `calibrationBacklog.captureCommands` array built from existing missing item names, where each entry contains scope, missing item, operation, side-effect flag, a safe `probe template` command, and a `probe protocol` command with placeholder account/input-file values. Commands must never contain raw cookie, session, JWT, API key, code, email, prompt, payload, real user data, or local fixture contents.

**Tech Stack:** Node.js ESM, native `node:test`, `src/observability.js`, `test/observability.test.js`, `test/ops-cli.test.js`, README/M08/real-protocol docs.

---

### Task 1: RED test for doctor capture commands

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add `buildReadinessDoctorReport includes safe calibration capture commands`.

Use a report with:
- core readiness ready;
- auth missing send/submit evidence;
- benefits missing daily sign-in, Pro, reset coupon, and lottery evidence;
- session missing refresh strategy.

Assert:
- `report.calibrationBacklog.captureCommands` is an array;
- auth send entry includes `operation:"sendVerificationCode"`, `sideEffect:true`, a `templateCommand` for `probe template`, and a `probeCommand` with `<account-id>` and `<redacted-input.json>`;
- benefits entries include `dailySignIn`, `participateActivity`, `drawLottery`;
- `automated_session_refresh_strategy` entry has `probeCommand:null` and a reason that says no calibrated refresh probe exists;
- serialized report does not include raw email, cookie, session, JWT, Bearer token, API key, prompt, or raw fixture body.

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands"
```

Expected: FAIL until `captureCommands` exists.

### Task 2: GREEN implementation

**Files:**
- Modify: `src/observability.js`

**Step 1: Add safe command builders**

Add helpers:
- `probeTemplateCommand(operation)`
- `probeProtocolCommand(operation)`
- `captureCommandForMissing(missingName)`
- `buildCalibrationCaptureCommands(missingNames)`

Each command uses placeholders only:

```text
node bin\tabbit-pool.js probe template --operation <operation> --json
node bin\tabbit-pool.js probe protocol --account <account-id> --operation <operation> --input-file <redacted-input.json> --write-fixture --json
```

For uncalibrated refresh strategy, use `probeCommand:null` and a safe reason.

**Step 2: Wire into doctor report**

Add:

```js
captureCommands: buildCalibrationCaptureCommands(calibrationBacklogMissing)
```

inside `calibrationBacklog`.

### Task 3: CLI regression

**Files:**
- Modify: `test/ops-cli.test.js`

Add an assertion to the existing `readiness doctor --json includes auth and benefits backlog without running probes` test that JSON output includes `calibrationBacklog.captureCommands` and still does not include raw fixture secrets or tool names.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`

Document that capture commands are command hints only. They use placeholders, keep side-effect probes explicitly confirmed in the input file, and do not replace manual safety review before real auth/benefits/session probes.

### Task 5: Verification

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands|ReadinessDoctor"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
node --test test\protocol-tabbit-client.test.js
npm test
node bin\tabbit-pool.js readiness doctor --json
git diff --check
```

Expected: all tests pass; doctor JSON contains only placeholder capture commands and no raw secrets.
