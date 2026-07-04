# Readiness Doctor Confirmed Side Effect Capture Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `confirm_validate` step to readiness doctor capture hints so side-effect evidence capture has an explicit offline `confirmSideEffect:true` gate before `probe protocol --write-fixture`.

**Architecture:** Keep the existing placeholder-only `captureCommands` contract and add one optional field: `confirmedValidateCommand`. The field exists only for calibrated side-effect operations and uses `probe validate --require-confirmed-side-effect`; read-only operations and uncalibrated missing items keep it `null`. Plain `readiness doctor` output prints the same step as `confirm_validate=` without changing readiness or fixture audit semantics.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildReadinessDoctorReport()`, `runProtocolPoolCli()`, and Markdown docs.

---

### Task 1: RED Test for JSON Capture Commands

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Extend the existing safe capture command test**

In `buildReadinessDoctorReport includes safe calibration capture commands`, assert:

```js
assert.match(
  byMissing.successful_sendVerificationCode_fixture.confirmedValidateCommand,
  /probe validate --operation sendVerificationCode --input-file <redacted-input\.json> --require-confirmed-side-effect --json/,
);
assert.equal(byMissing.automated_session_refresh_strategy.confirmedValidateCommand, null);
```

Also assert read-only `verifySession` entries, when present in a missing-state test, have `confirmedValidateCommand === null`.

**Step 2: Verify RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands|buildReadinessDoctorReport"
```

Expected: FAIL because `confirmedValidateCommand` is not present.

### Task 2: GREEN Implementation for JSON

**Files:**
- Modify: `src/observability.js`

**Step 1: Add command builder**

Add:

```js
function probeConfirmedSideEffectValidateCommand(operation, sideEffect) {
  if (!operation || !sideEffect) return null;
  return "node bin\\tabbit-pool.js probe validate --operation "
    + operation
    + " --input-file <redacted-input.json> --require-confirmed-side-effect --json";
}
```

**Step 2: Include field in capture entries**

In `captureCommandForMissing()`, add:

```js
confirmedValidateCommand: probeConfirmedSideEffectValidateCommand(spec.operation, spec.sideEffect),
```

**Step 3: Run focused test**

Run the same observability command. Expected: PASS.

### Task 3: RED/GREEN for Plain Doctor Output

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `src/ops-cli.js`

**Step 1: Extend plain output test**

In `readiness doctor prints calibration backlog in plain output`, assert the send-code capture row contains:

```text
confirm_validate=node bin\tabbit-pool.js probe validate --operation sendVerificationCode --input-file <redacted-input.json> --require-confirmed-side-effect --json
```

For `automated_session_refresh_strategy`, assert `confirm_validate=` is empty.

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor prints calibration backlog in plain output"
```

Expected: FAIL until the plain renderer includes the new field.

**Step 2: Implement plain renderer**

Update `plainCaptureCommandLines()` to include:

```js
"confirm_validate=" + (item.confirmedValidateCommand || ""),
```

between `validate=` and `probe=`.

Run the focused CLI test. Expected: PASS.

### Task 4: Documentation Update

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/04-开发追踪.md`

**Step 1: Document the four-step capture flow**

State that doctor capture hints now use `template -> validate -> confirm_validate -> probe` for calibrated side-effect operations.

**Step 2: Preserve safety wording**

State that `confirm_validate` is still read-only and only verifies `confirmSideEffect:true`; it does not prove endpoint/body success semantics.

### Task 5: Verification

**Files:**
- Test: `test/observability.test.js`
- Test: `test/ops-cli.test.js`
- Test: `test/protocol-tabbit-client.test.js`

**Step 1: Run required tests**

```powershell
node --test test\observability.test.js --test-name-pattern "safe calibration capture commands|buildReadinessDoctorReport"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor prints calibration backlog in plain output"
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
