# Readiness Doctor Plain Backlog Visibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `readiness doctor` plain-text output show calibration backlog status so a core-ready gateway is not mistaken for complete real-protocol calibration.

**Architecture:** Keep `buildReadinessDoctorReport()` and the `--json` output shape unchanged. Extend only the non-JSON `readiness doctor` renderer to print the aggregate `calibrationBacklog` status plus per-scope backlog statuses and missing counts from the already-built report. Do not add fixture reads beyond the existing doctor path, do not run probes, and do not change the top-level readiness gate semantics.

**Tech Stack:** Node.js ESM, native `node:test`, `src/ops-cli.js`, `test/ops-cli.test.js`, existing `buildReadinessDoctorReport()` output.

---

### Task 1: RED test for doctor plain output

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a test named `readiness doctor prints calibration backlog in plain output`.

Use injected fixtures and readiness state that make core readiness `ready` and `remainingWork` empty while auth, benefits, and session backlog remain blocked. Assert that the command:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "doctor prints calibration backlog"
```

fails until plain output includes:

```text
calibration_backlog    blocked    missing=7
auth_backlog           blocked    missing=2
benefits_backlog       blocked    missing=4
session_backlog        blocked    missing=1
```

The test must also assert no account verifier, protocol probe, raw email, cookie, session, token, tool name, or fixture payload text is printed.

### Task 2: GREEN implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1: Update doctor plain renderer**

In `handleReadinessDoctor()`, keep existing lines and append backlog summary lines from `report.calibrationBacklog`.

Use missing counts computed from the arrays already on the report:

```js
const backlog = report.calibrationBacklog || {};
const scopes = backlog.scopes || {};
```

Expected behavior:
- if backlog is absent, print empty status and `missing=0`;
- if a scope is absent, print empty status and `missing=0`;
- no raw fixture content is serialized.

**Step 2: Re-run focused test**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "doctor prints calibration backlog"
```

Expected: PASS.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/04-开发追踪.md`

Document that both JSON and plain `readiness doctor` output distinguish core readiness from calibration backlog, and that a plain `status ready` must be read together with `calibration_backlog`.

### Task 4: Verification

Run:

```powershell
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
node bin\tabbit-pool.js readiness doctor
git diff --check
```

Expected: all tests pass; plain doctor shows backlog summary without raw secrets.
