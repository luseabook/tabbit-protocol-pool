# Readiness Doctor Probe Path Prerequisites Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `readiness doctor` capture command hints show missing/configured prerequisite paths for benefits and session probes before operators attempt real fixture capture.

**Architecture:** Reuse the existing `calibrationBacklog.captureCommands` metadata contract. Add sanitized prerequisite specs for calibrated operations that require explicit `TABBIT_POOL_PROTOCOL_*` paths, and report only env var names plus `configured` / `missing` status. Do not change fixture audit gates, do not infer endpoint values, and do not execute any probe.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildReadinessDoctorReport()`, `plainCaptureCommandLines()`, `runProtocolPoolCli()`, and Markdown docs.

---

### Task 1: RED Tests for Benefits and Session Capture Prerequisites

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

**Step 1: Extend JSON doctor helper test**

In `buildReadinessDoctorReport includes safe calibration capture commands`, assert that a report without benefits/session paths marks these commands blocked:

```js
assert.equal(byMissing.successful_daily_sign_in_fixture.prerequisitesStatus, "blocked");
assert.deepEqual(byMissing.successful_daily_sign_in_fixture.prerequisites, [{
  name: "daily_sign_in_endpoint",
  env: "TABBIT_POOL_PROTOCOL_SIGN_IN_PATH",
  status: "missing",
}]);
assert.equal(byMissing.successful_pro_activity_fixture.prerequisitesStatus, "blocked");
assert.deepEqual(byMissing.successful_pro_activity_fixture.prerequisites, [{
  name: "activity_participate_endpoint",
  env: "TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH",
  status: "missing",
}]);
assert.equal(byMissing.successful_lottery_draw_fixture.prerequisitesStatus, "blocked");
assert.deepEqual(byMissing.successful_lottery_draw_fixture.prerequisites, [{
  name: "lottery_draw_endpoint",
  env: "TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH",
  status: "missing",
}]);
assert.equal(byMissing.expired_verifySession_fixture.prerequisitesStatus, "ready");
```

The existing fixture set includes a successful `verifySession`, so `successful_verifySession_fixture` is not missing in this test. `expired_verifySession_fixture` still needs the same configured session verify path and should report ready because this test config has `sessionVerifyPath`.

**Step 2: Extend CLI JSON test**

In `readiness doctor --json includes auth and benefits backlog without running probes`, use the existing configured protocol paths in the test config and assert:

```js
const proCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "successful_pro_activity_fixture");
assert.equal(proCapture.prerequisitesStatus, "ready");
assert.deepEqual(proCapture.prerequisites, [{
  name: "activity_participate_endpoint",
  env: "TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH",
  status: "configured",
}]);
```

Add equivalent assertions for `successful_daily_sign_in_fixture`, `successful_lottery_draw_fixture`, and `expired_verifySession_fixture`.

**Step 3: Extend plain doctor test**

In `readiness doctor prints calibration backlog in plain output`, assert rows include:

```text
prereq=TABBIT_POOL_PROTOCOL_SIGN_IN_PATH:configured
prereq=TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH:configured
prereq=TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH:configured
prereq=TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH:configured
```

**Step 4: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "capture commands"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: FAIL because these capture commands currently have empty prerequisites and report `ready`.

### Task 2: Implement Minimal Path Prerequisites

**Files:**
- Modify: `src/observability.js`

**Step 1: Add prerequisite specs**

Add `prerequisites` to `CALIBRATION_CAPTURE_SPECS`:

```js
successful_daily_sign_in_fixture: [{
  name: "daily_sign_in_endpoint",
  env: "TABBIT_POOL_PROTOCOL_SIGN_IN_PATH",
  protocolKey: "signInPath",
}]
successful_pro_activity_fixture: [{
  name: "activity_participate_endpoint",
  env: "TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH",
  protocolKey: "activityParticipatePath",
}]
successful_lottery_draw_fixture: [{
  name: "lottery_draw_endpoint",
  env: "TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH",
  protocolKey: "lotteryDrawPath",
}]
successful_verifySession_fixture and expired_verifySession_fixture: [{
  name: "session_verify_endpoint",
  env: "TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH",
  protocolKey: "sessionVerifyPath",
}]
```

Do not add a fake prerequisite for `successful_reset_coupon_consumption_fixture` or `automated_session_refresh_strategy`; those remain uncalibrated and commandless.

**Step 2: Run GREEN**

```powershell
node --test test\observability.test.js --test-name-pattern "capture commands"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: PASS.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/modules/M05-权益额度维护/活动Pro领取.md`

**Step 1: Document JSON prerequisites**

State that benefits/session capture command prerequisites now include only required env var names and configured/missing status.

**Step 2: Document plain prerequisites**

State that plain `capture_command` rows show `prereq=TABBIT_POOL_PROTOCOL_SIGN_IN_PATH:...`, `TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH:...`, `TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH:...`, or `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH:...`.

**Step 3: Preserve safety boundary**

Clarify that configured prerequisites do not prove endpoint body, side-effect safety, success semantics, or fixture readiness. Real probes still require `probe validate`, confirmed side-effect review, and sanitized fixture audit.

### Task 4: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused verification**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

**Step 2: Full verification**

```powershell
npm test
git diff --check
```

**Step 3: State and boundary checks**

Run aggregate-only external state checks and forbidden path / credential-shape scans. Expected: no raw fixture output, no sensitive file edits, and external state reports missing benefits/auth capture prerequisites when those paths are not configured.

### Execution Status

- [x] Task 1: RED tests for benefits and session capture prerequisites.
- [x] Task 2: Minimal path prerequisite metadata in `src/observability.js`.
- [x] Task 3: README, M08, and M05 Pro activity documentation.
- [x] Task 4: Focused, full, external aggregate, forbidden path, and credential-shape verification.

### Verification Evidence

- RED: `node --test test\observability.test.js --test-name-pattern "capture commands"` failed because daily sign-in prerequisite status was still `ready`; `node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"` failed because benefits capture commands had empty `prerequisites` / `prereq=`.
- GREEN: both RED commands passed after adding `signInPath`, `activityParticipatePath`, `lotteryDrawPath`, and `sessionVerifyPath` prerequisite specs.
- Focused: `node --test test\observability.test.js`, `node --test test\ops-cli.test.js`, and `node --test test\protocol-tabbit-client.test.js` passed.
- Full: `npm test` passed with 354/354 tests; `git diff --check` exited 0 with existing CRLF warnings only.
- External state: aggregate-only checks reported core doctor/readiness/default fixture audit ready, auth and benefits audit blocked, auth endpoints not configured, and no raw fixture output.
- Boundary: forbidden status path scan and refined credential-shape diff scan were clean.
