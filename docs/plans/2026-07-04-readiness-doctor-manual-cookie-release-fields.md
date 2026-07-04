# Readiness Doctor Manual Cookie Release Fields Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align top-level `readiness doctor` manual-cookie output with session scoped audit by separating current-release blockers from automated-refresh backlog.

**Architecture:** Keep all existing readiness and fixture evidence gates unchanged. `manualCookieMode.missing` remains the current-release missing list for compatibility. Add explicit `blockingMissing` and `backlogMissing` fields to the doctor-level `manualCookieMode`, and mirror them in plain output. `automated_session_refresh_strategy` must stay visible as backlog and inside session scope, but must not be presented as a manual-cookie release blocker.

**Tech Stack:** Node.js ESM, native `node:test`, `src/observability.js`, `src/ops-cli.js`, Markdown docs.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

**Step 1: JSON doctor fields**

Extend doctor manual-cookie tests to assert:

```js
assert.deepEqual(report.manualCookieMode.blockingMissing, ["expired_verifySession_fixture"]);
assert.deepEqual(report.manualCookieMode.backlogMissing, ["automated_session_refresh_strategy"]);
```

For the manual-cookie ready case:

```js
assert.deepEqual(report.manualCookieMode.blockingMissing, []);
assert.deepEqual(report.manualCookieMode.backlogMissing, ["automated_session_refresh_strategy"]);
```

**Step 2: Plain doctor fields**

Extend `readiness doctor prints calibration backlog in plain output` to expect:

```text
manual_cookie_mode	blocked	mode=manual_reimport_then_probe	automated_refresh=backlog	missing=expired_verifySession_fixture	release_blocking_missing=expired_verifySession_fixture	backlog_missing=automated_session_refresh_strategy
```

Expected RED command:

```powershell
node --test test\observability.test.js --test-name-pattern "manual cookie"
node --test test\ops-cli.test.js --test-name-pattern "calibration backlog"
```

Expected before implementation: FAIL because doctor-level `manualCookieMode.blockingMissing` / `backlogMissing` and plain doctor release/backlog columns are absent.

### Task 2: Minimal Implementation

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1:** Add `blockingMissing:[...missing]` and `backlogMissing` to `buildManualCookieMode()`.

**Step 2:** Extend readiness doctor plain `manual_cookie_mode` line with:

```text
release_blocking_missing=<csv>
backlog_missing=<csv>
```

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: this plan

Document that doctor-level `manualCookieMode.blockingMissing` / plain `release_blocking_missing` represent current manual-cookie release blockers, while `manualCookieMode.backlogMissing` / plain `backlog_missing` represent later automated session recovery enhancements.

### Task 4: Verification

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "manual cookie"
node --test test\ops-cli.test.js --test-name-pattern "calibration backlog"
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope session --json
node bin\tabbit-pool.js fixtures audit --scope upstream --json
```

Then run forbidden-path and strict credential-shape diff scans without printing raw matched content.

---

## Execution Status

- Task 1 RED tests completed. Expected failures were observed for missing doctor-level `manualCookieMode.blockingMissing` / `backlogMissing` and missing plain `release_blocking_missing` / `backlog_missing` fields.
- Task 2 implementation completed in `src/observability.js` and `src/ops-cli.js`.
- Task 3 documentation completed in `README.md`, `docs/07-API文档.md`, `docs/13-真实协议校准与端到端验收.md`, and `docs/modules/M08-观测运维/_M08-观测运维.md`.
- Focused GREEN verification completed:
  - `node --test test\observability.test.js --test-name-pattern "manual cookie"` -> 46/46 pass.
  - `node --test test\ops-cli.test.js --test-name-pattern "calibration backlog"` -> 114/114 pass.
- Full verification completed:
  - `node --test test\observability.test.js` -> 46/46 pass.
  - `node --test test\ops-cli.test.js` -> 114/114 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `npm test` -> 425/425 pass.
  - `git diff --check` -> exit 0; only LF/CRLF working-copy warnings.
- Aggregate default-state audit remains expected `blocked` because the default stateDir has no real sanitized fixture set:
  - `readiness doctor --json` aggregate summary: `status=blocked`, `manual_cookie=blocked`, `manual_release_blocking=8`, `manual_backlog=1`, `calibration_backlog=blocked`.
  - `fixtures audit --scope session --json` aggregate summary: `status=blocked`, release blockers `successful_verifySession_fixture,expired_verifySession_fixture`, backlog `automated_session_refresh_strategy`.
  - `fixtures audit --scope upstream --json` aggregate summary: `status=blocked`, missing `real_upstream_error_frame_fixture,real_upstream_cancellation_fixture,real_upstream_backpressure_fixture`.
- Safety scans completed:
  - Forbidden path scan -> 46 changed/untracked paths, 0 hits.
  - Strict credential-shape scan -> 5713 added/untracked lines, 0 hits after converting one documented Bearer-shaped placeholder to an angle-bracket placeholder.
