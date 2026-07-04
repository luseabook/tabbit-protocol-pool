# Readiness Doctor Validate Capture Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Include `probe validate` preflight commands in readiness doctor calibration capture hints, so operators can validate redacted input files before running side-effect protocol probes.

**Architecture:** Extend the existing `calibrationBacklog.captureCommands` objects produced by `buildReadinessDoctorReport()` with a placeholder-only `validateCommand` next to `templateCommand` and `probeCommand`. Keep readiness semantics unchanged, keep uncalibrated items with `operation:null` non-executable, and update the plain renderer to show the validation step without exposing raw payloads or local fixture contents.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildReadinessDoctorReport()`, `runProtocolPoolCli()`, and docs.

---

### Task 1: RED Test for JSON Capture Commands

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Extend `buildReadinessDoctorReport includes safe calibration capture commands` to assert:

```js
assert.match(send.validateCommand, /probe validate --operation sendVerificationCode --input-file <redacted-input\.json> --json/);
assert.equal(refresh.validateCommand, null);
```

The test must also assert the command does not contain email, code, cookie, session, token, raw payload, or a real file path.

**Step 2: Run RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands|buildReadinessDoctorReport"
```

Expected: FAIL because `validateCommand` does not exist yet.

### Task 2: GREEN Implementation for JSON

**Files:**
- Modify: `src/observability.js`

**Step 1: Add command builder**

Add:

```js
function probeValidateCommand(operation) {
  if (!operation) return null;
  return "node bin\\tabbit-pool.js probe validate --operation "
    + operation
    + " --input-file <redacted-input.json> --json";
}
```

**Step 2: Include `validateCommand`**

In `captureCommandForMissing()`, add:

```js
validateCommand: probeValidateCommand(spec.operation),
```

**Step 3: Run focused test**

Run the same observability focused command. Expected: PASS.

### Task 3: RED/GREEN for Plain Doctor Output

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `src/ops-cli.js`

**Step 1: Write RED test**

Extend `readiness doctor prints calibration backlog in plain output` so the auth send command line must include:

```text
validate=node bin\tabbit-pool.js probe validate --operation sendVerificationCode --input-file <redacted-input.json> --json
```

For `successful_reset_coupon_consumption_fixture` and `automated_session_refresh_strategy`, assert `validate=` is empty just like `template=` and `probe=`.

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor prints calibration backlog in plain output"
```

Expected: FAIL until the plain formatter prints `validate=`.

**Step 2: Implement plain renderer**

Update `plainCaptureCommandLines()` to include:

```js
"validate=" + (item.validateCommand || ""),
```

between `template=` and `probe=`.

Run the focused test again. Expected: PASS.

### Task 4: Documentation Update

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Update capture command docs**

State that `captureCommands` and plain `capture_command` rows include template, validate, and probe steps.

**Step 2: Preserve safety wording**

State that `validateCommand` is placeholder-only, read-only, and does not prove the real endpoint/body is calibrated.

### Task 5: Verification

**Files:**
- Test: `test/observability.test.js`
- Test: `test/ops-cli.test.js`
- Test: `test/protocol-tabbit-client.test.js`

**Step 1: Run required tests**

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands|buildReadinessDoctorReport"
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

**Step 2: Run safety checks**

```powershell
git diff --check
git status --short --untracked-files=all
```

Confirm no forbidden local state path was touched and added lines contain no real cookie, session, JWT, API key, Bearer token, raw payload, prompt, or real user data.
