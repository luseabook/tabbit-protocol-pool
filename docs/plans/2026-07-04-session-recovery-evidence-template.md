# Session Recovery Evidence Template Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a safe offline `recoverSession` evidence template and validator so operators can prepare sanitized session recovery strategy evidence without guessing a network refresh endpoint.

**Architecture:** Treat `recoverSession` as an offline evidence operation, not as a protocol probe dispatch target. Reuse the existing `probe template` / `probe validate` flow to produce and preflight a `session_recovery_strategy` JSON object, then update readiness doctor capture commands to point at template and validate only while keeping `probeCommand:null`.

**Tech Stack:** Node.js ESM, native `node:test`, `tabbit-pool probe template`, `tabbit-pool probe validate`, readiness doctor capture commands, and Markdown docs.

---

### Task 1: RED CLI Template Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add failing template test**

Add `probe template --operation recoverSession prints safe session recovery evidence input`.

Expected JSON:

```json
{
  "kind": "session_recovery_strategy",
  "operation": "recoverSession",
  "status": "success",
  "evidence": {
    "strategy": "automated_reauth",
    "automatedRefresh": "calibrated_reauth_probe",
    "safe": true,
    "sanitized": true,
    "rawPayload": false
  }
}
```

Also assert serialized output does not contain cookie, bearer, JWT, API key, prompt, or real user data shapes.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "recoverSession"
```

Expected: FAIL because `recoverSession` is not listed in `PROBE_INPUT_TEMPLATES`.

### Task 2: RED Offline Validation Tests

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add safe validation test**

Create a temp input file with canonical `session_recovery_strategy` evidence plus extra ignored raw-looking fields under unrelated keys. Run:

```powershell
node bin\tabbit-pool.js probe validate --operation recoverSession --input-file <temp-file> --json
```

Expected:
- exitCode 0;
- no account, secret, fixture, or protocol probe dependency is touched;
- preview has `operation:"recoverSession"`, `sideEffect:false`, `fields.evidence:"object"`, and `evidenceKeys` with only key names;
- stdout does not leak the raw-looking ignored values.

**Step 2: Add unsafe validation test**

Use `rawPayload:true` or `sanitized:false`.

Expected:
- exitCode 2;
- no dependency is touched;
- stderr explains the required safe/sanitized/rawPayload contract without echoing input values.

**Step 3: Add protocol dispatch guard test**

Run `probe protocol --account acct --operation recoverSession --input-json <safe-json> --json`.

Expected:
- exitCode 2;
- runner is not called;
- stderr says the operation is offline evidence only.

### Task 3: RED Doctor Capture Command Tests

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

**Step 1: Update capture command expectations**

For `automated_session_refresh_strategy`, expected capture command becomes:
- `operation:"recoverSession"`;
- `templateCommand` points to `probe template --operation recoverSession --json`;
- `validateCommand` points to `probe validate --operation recoverSession --input-file <redacted-input.json> --json`;
- `confirmedValidateCommand:null`;
- `probeCommand:null`;
- no prerequisites.

Plain doctor output should show template and validate commands but keep confirm/probe columns empty.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "capture commands"
node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"
```

Expected: FAIL because the capture spec currently has `operation:null`.

### Task 4: Minimal Implementation

**Files:**
- Modify: `src/ops-cli.js`
- Modify: `src/observability.js`

**Step 1: Add offline template and schema validation**

In `src/ops-cli.js`:
- add `recoverSession` to `PROBE_INPUT_TEMPLATES`;
- add narrow validation for `kind`, `operation`, `status`, and `evidence`;
- require `safe:true`, `sanitized:true`, and `rawPayload:false`;
- require strategy/mode values already accepted by session audit;
- include only aggregate field states and evidence key names in validation preview.

**Step 2: Block protocol dispatch**

Add an offline-only operation set and reject `probe protocol --operation recoverSession` after input validation and before calling the runner.

**Step 3: Add template/validate-only doctor command**

In `src/observability.js`, set `automated_session_refresh_strategy.operation` to `recoverSession`, add a `protocolProbe:false` flag, and make `captureCommandForMissing()` return `probeCommand:null` when that flag is false.

### Task 5: Documentation

**Files:**
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document offline recoverSession evidence flow**

State that:
- `probe template --operation recoverSession` and `probe validate --operation recoverSession` are offline-only;
- they do not read accounts, secrets, fixtures, or network;
- `probe protocol --operation recoverSession` is intentionally rejected;
- doctor capture commands for `automated_session_refresh_strategy` provide template/validate only and still do not prove automation until a sanitized fixture is stored and audit passes.

### Task 6: Verification

**Step 1: Focused tests**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "recoverSession"
node --test test\observability.test.js --test-name-pattern "capture commands"
```

**Step 2: Required regression checks**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-probe.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
```

**Step 3: Aggregate and safety checks**

Run the external aggregate-only readiness/audit checks, forbidden-path scan, and credential-shape diff scan. Expected: no sensitive file edits, no raw fixture output, and calibration backlog remains blocked until real sanitized evidence exists for the remaining scopes.

---

## Execution Status - 2026-07-04

Completed for this increment.

### RED Evidence

- `node --test test\ops-cli.test.js --test-name-pattern "recoverSession"` failed before implementation because `probe template --operation recoverSession` returned exitCode 2, recoverSession validation had no evidence-specific schema, unsafe evidence was accepted, and `probe protocol --operation recoverSession` reached the injected runner.
- `node --test test\observability.test.js --test-name-pattern "capture commands"` failed before implementation because `automated_session_refresh_strategy.operation` was still `null`.
- `node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"` failed before implementation because plain/JSON doctor output kept template and validate empty for `automated_session_refresh_strategy`.
- Additional boundary RED: `probe validate --operation recoverSession --json` without input failed after adding the test because empty input was still treated as valid.

### GREEN Implementation

- `src/ops-cli.js` now exposes a safe `recoverSession` template for `session_recovery_strategy` evidence.
- `probe validate --operation recoverSession` requires explicit evidence input with `kind:"session_recovery_strategy"`, `operation:"recoverSession"`, `status:"success"`, allowed recovery strategy/mode, `safe:true`, `sanitized:true`, and `rawPayload:false`.
- `probe validate` preview includes only field states, key names, and finite recovery evidence values; it does not echo ignored raw-looking fields.
- `probe protocol --operation recoverSession` is rejected as offline evidence only before calling the runner.
- `src/observability.js` now emits template/validate-only capture commands for `automated_session_refresh_strategy`; `probeCommand` remains `null`.

### Focused Verification

- `node --test test\ops-cli.test.js --test-name-pattern "recoverSession"`: 89/89 pass.
- `node --test test\observability.test.js --test-name-pattern "capture commands"`: 35/35 pass.
- `node --test test\ops-cli.test.js --test-name-pattern "readiness doctor"`: 89/89 pass.

### Full Verification Evidence

- `node --test test\observability.test.js`: 35/35 pass.
- `node --test test\ops-cli.test.js`: 89/89 pass.
- `node --test test\protocol-probe.test.js`: 13/13 pass.
- `node --test test\protocol-tabbit-client.test.js`: 57/57 pass.
- `npm test`: 366/366 pass.
- `git diff --check`: exit 0; only existing LF/CRLF working-copy warnings.
- Forbidden path scan: clean.
- Credential-shape diff scan: clean.

### External Aggregate State

Checked with `TABBIT_POOL_STATE_DIR=E:\tabbit2api\output\tabbit-live-state` and protocol env configured. Only aggregate status was printed.

- doctor: ready.
- readiness: ready.
- default fixture audit: ready.
- calibration backlog: blocked.
- core remaining work count: 0.
- auth remains blocked: missing send-code and submit-code success evidence.
- benefits remains blocked: missing daily sign-in, Pro activity success, reset coupon consumption, and lottery draw success evidence.
- session remains blocked: `recoveryStrategy.status=blocked`, `counts.recoveryStrategyEvidence=0`, missing `automated_session_refresh_strategy`.
- upstream remains blocked: missing real upstream error-frame, cancellation, and backpressure evidence.
- doctor now emits `automated_session_refresh_strategy` capture commands with `operation:"recoverSession"`, template/validate commands present, and `probeCommand:null`.

### Sensitive File Status

No forbidden path was touched or listed by the scan: `tabbit-cookie.txt`, `output/`, browser profile/state fixture directories, `.agents/`, `.codex/`, and `.omx/` remain untouched by this increment.
