# Upstream Capture Command Stream Modes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `readiness doctor` upstream capture commands name the exact safe `sendMessage.streamEvidence` mode required for each real upstream boundary fixture.

**Architecture:** Keep `probe template --operation sendMessage` generic and keep protocol probes opt-in. Add marker-only capture metadata to `buildCalibrationCaptureCommands()` so missing upstream error-frame, cancellation, and backpressure evidence each include a recommended `streamEvidence` object. Plain doctor output should include the mode and max delta count without endpoint values, prompts, payloads, cookies, sessions, tokens, or real user data.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildReadinessDoctorReport()`, `readiness doctor --json`, and `readiness doctor` plain output.

---

### Task 1: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Extend `buildReadinessDoctorReport includes safe calibration capture commands` so upstream capture command entries assert:
- `real_upstream_error_frame_fixture.recommendedInput.streamEvidence` is `{ mode:"error_frame", maxDeltas:2 }`;
- `real_upstream_cancellation_fixture.recommendedInput.streamEvidence` is `{ mode:"cancel_after_first_delta", maxDeltas:2 }`;
- `real_upstream_backpressure_fixture.recommendedInput.streamEvidence` is `{ mode:"first_token_backpressure", maxDeltas:2 }`;
- serialized report does not include raw prompt, cookie, session, token, bearer credential, endpoint value, or real user data.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands"
```

Expected before implementation: FAIL because capture command entries do not expose `recommendedInput.streamEvidence`.

### Task 2: RED Plain Doctor Output Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Extend `readiness doctor prints calibration backlog in plain output` or the existing capture-command plain test so upstream lines include:
- `stream_evidence=error_frame:2`
- `stream_evidence=cancel_after_first_delta:2`
- `stream_evidence=first_token_backpressure:2`

Also assert no raw prompt/session/cookie/token-like value is printed.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "capture_command"
```

Expected before implementation: FAIL because plain capture command lines do not include stream evidence hints.

### Task 3: Minimal Implementation

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1: Add upstream stream evidence metadata**

Add per-missing-name metadata in `CALIBRATION_CAPTURE_SPECS`:
- error-frame -> `{ mode:"error_frame", maxDeltas:2 }`
- cancellation -> `{ mode:"cancel_after_first_delta", maxDeltas:2 }`
- backpressure -> `{ mode:"first_token_backpressure", maxDeltas:2 }`

`captureCommandForMissing()` should include `recommendedInput:{ stream:true, streamEvidence:{...} }` only when the spec declares it.

**Step 2: Print plain safe hint**

`plainCaptureCommandLines()` should append `stream_evidence=<mode>:<maxDeltas>` when the command entry has recommended stream evidence. It must not print message content, endpoint path values, account ids, raw payloads, cookies, sessions, tokens, or real user data.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/plans/2026-07-04-upstream-capture-command-stream-modes.md`

**Step 1: Document capture command hints**

State that upstream `captureCommands` include only a safe recommended stream evidence mode and max delta count; operators still need a redacted input file and must not store raw stream data.

### Task 5: Verification

**Focused checks:**

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands"
node --test test\ops-cli.test.js --test-name-pattern "capture_command"
```

**Required checks:**

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Safety checks:**

Run forbidden-path and credential-shape scans including untracked plan files. Expected: no sensitive path edits and no raw credential-shaped values in added lines.

## Execution Status - 2026-07-04

- RED verified:
  - `node --test test\observability.test.js --test-name-pattern "safe calibration capture commands"` failed because upstream capture command entries had no `recommendedInput`.
  - `node --test test\ops-cli.test.js --test-name-pattern "calibration backlog in plain output|capture_command"` failed because plain `capture_command` lines had no `stream_evidence=<mode>:<maxDeltas>` field.
- GREEN implementation:
  - `src/observability.js` now adds `recommendedInput:{ stream:true, streamEvidence:{ mode, maxDeltas:2 } }` for `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.
  - `src/ops-cli.js` now prints `stream_evidence=error_frame:2`, `stream_evidence=cancel_after_first_delta:2`, or `stream_evidence=first_token_backpressure:2` only for upstream capture command lines.
- Focused verification:
  - `node --test test\observability.test.js --test-name-pattern "safe calibration capture commands"` -> 39/39 pass.
  - `node --test test\ops-cli.test.js --test-name-pattern "calibration backlog in plain output|capture_command"` -> 106/106 pass.

Full regression, aggregate startup checks, diff, forbidden-path scan, and credential-shape scan are tracked in the final turn summary for this increment.
