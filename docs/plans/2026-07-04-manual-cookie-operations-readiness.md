# Manual Cookie Operations Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reframe session automation gaps so the current release target is a manual cookie operations version, while keeping automated session refresh as a visible backlog item.

**Architecture:** Keep the existing strict evidence gates for core readiness and scoped fixture audits. Add a separate manual-cookie operations status that depends on current core readiness plus sanitized `verifySession` success and 401/login_required expiry evidence, but does not require `automated_session_refresh_strategy`; keep the automated refresh gap in session/backlog output as a future enhancement.

**Tech Stack:** Node.js ESM, native `node:test`, `src/observability.js`, `src/ops-cli.js`, Markdown docs.

---

### Task 1: RED Observability Tests

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Add failing manual-cookie doctor assertions**

Extend the core-ready/backlog test so a report with core readiness ready but missing expired session evidence exposes:

```js
assert.equal(report.manualCookieMode.status, "blocked");
assert.deepEqual(report.manualCookieMode.missing, ["expired_verifySession_fixture"]);
assert.equal(report.manualCookieMode.automatedSessionRefresh.requiredForCurrentRelease, false);
assert.equal(report.manualCookieMode.automatedSessionRefresh.status, "backlog");
```

Add a second fixture set with successful `verifySession`, expired 401/login_required `verifySession`, successful send/stream/tool-unsupported/403 and Codex/Claude marks. Expected:

```js
assert.equal(report.status, "ready");
assert.equal(report.manualCookieMode.status, "ready");
assert.deepEqual(report.manualCookieMode.missing, []);
assert.ok(report.calibrationBacklog.missing.includes("automated_session_refresh_strategy"));
```

**Step 2: Add failing session audit assertions**

In `fixtures audit --scope session reports session lifecycle evidence`, expect:

```js
assert.equal(body.manualCookieOperations.status, "ready");
assert.equal(body.manualCookieOperations.automatedRefreshRequired, false);
assert.deepEqual(body.manualCookieOperations.missing, []);
```

### Task 2: RED CLI Plain Output Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Add failing plain doctor assertion**

In `readiness doctor prints calibration backlog in plain output`, expect a safe aggregate line:

```text
manual_cookie_mode	blocked	mode=manual_reimport_then_probe	automated_refresh=backlog	missing=expired_verifySession_fixture
```

**Step 2: Add failing session plain assertion**

In `fixtures audit --scope session prints refresh strategy gap in plain output`, expect:

```text
manual_cookie_mode	ready	mode=manual_reimport_then_probe	expired_session_action=login_expired_then_manual_reimport	automated_refresh_required=false
```

### Task 3: Run RED

Run:

```powershell
node --test --test-name-pattern "manual cookie|scope session|readiness doctor" test\observability.test.js test\ops-cli.test.js
```

Expected: FAIL because `manualCookieMode` / `manualCookieOperations` and plain `manual_cookie_mode` lines do not exist yet.

### Task 4: Minimal Implementation

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1: Add session audit manual-cookie status**

In `buildSessionFixtureAudit()`, add `manualCookieOperations`:

- `status:"ready"` only when successful `verifySession` and expired 401/login_required evidence are both present.
- `mode:"manual_reimport_then_probe"`.
- `expiredSessionAction:"login_expired_then_manual_reimport"`.
- `automatedRefreshRequired:false`.
- `automatedRefreshBacklog:"automated_session_refresh_strategy"`.
- `missing` contains only lifecycle evidence missing for the manual-cookie target, never `automated_session_refresh_strategy`.

**Step 2: Add doctor manual-cookie mode**

In `buildReadinessDoctorReport()`, add `manualCookieMode`:

- Depends on `readiness` + default `fixtureAudit` + session `manualCookieOperations`.
- Excludes `automated_session_refresh_strategy` from current-release missing.
- Includes `automatedSessionRefresh.requiredForCurrentRelease:false` and `status:"backlog"` while the session recovery strategy is not ready.

**Step 3: Add plain output lines**

- `readiness doctor` prints `manual_cookie_mode`.
- `fixtures audit --scope session` prints `manual_cookie_mode`.

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: `docs/plans/2026-07-04-session-lifecycle-plain-output.md`

**Step 1: Document operator semantics**

State that the current release target is manual cookie operations:

- No automatic registration/login, Yoda/SMS automation, or automatic session refresh is promised.
- 401/login_required from `verifySession` marks the account `login_expired`.
- The operator manually logs in and re-imports cookie/session.
- `automated_session_refresh_strategy` remains a backlog/evidence gate for a later automated recovery release.

### Task 6: Verification

Run:

```powershell
node --test --test-name-pattern "manual cookie|scope session|readiness doctor" test\observability.test.js test\ops-cli.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
git diff --check
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
node bin\tabbit-pool.js fixtures audit --scope session --json
node bin\tabbit-pool.js fixtures audit --scope upstream --json
```

Run forbidden-path and credential-shape diff scans before final reporting.

---

## Execution Status

- RED verified: `node --test --test-name-pattern "manual cookie|scope session|readiness doctor" test\observability.test.js test\ops-cli.test.js` initially failed because `manualCookieMode`, `manualCookieOperations`, and plain `manual_cookie_mode` output did not exist.
- GREEN implemented:
  - `src/observability.js` now exposes session `manualCookieOperations` and doctor-level `manualCookieMode`.
  - `manualCookieMode` excludes `automated_session_refresh_strategy` from current-release missing and marks automated refresh as `requiredForCurrentRelease:false`.
  - `src/ops-cli.js` now prints safe aggregate `manual_cookie_mode` lines in `readiness doctor` and `fixtures audit --scope session` plain output.
  - Stream-evidence tests now use non-cookie-shaped placeholder session strings.
- Documentation updated: README, real protocol acceptance doc, M08 ops doc, and this plan now state that the current release target is manual cookie operations and does not promise automatic registration, Yoda/SMS login automation, or automatic session refresh.
- Focused check: `node --test --test-name-pattern "manual cookie|scope session|readiness doctor" test\observability.test.js test\ops-cli.test.js` -> 8/8 pass.
- Additional focused check after placeholder cleanup: `node --test test\protocol-probe.test.js` -> 30/30 pass.
- Required verification:
  - `node --test test\ops-cli.test.js` -> 108/108 pass.
  - `node --test test\protocol-tabbit-client.test.js` -> 61/61 pass.
  - `npm test` -> 414/414 pass.
  - `git diff --check` -> exit 0, with LF-to-CRLF working-copy warnings only.
  - `readiness doctor --json` with configured send/session paths -> blocked in default stateDir; `manualCookieMode.status=blocked`, `automatedSessionRefresh.requiredForCurrentRelease=false`.
  - `fixtures audit --scope session --json` -> blocked with missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and `automated_session_refresh_strategy`; `manualCookieOperations.automatedRefreshRequired=false`.
  - `fixtures audit --scope upstream --json` -> blocked with missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.
  - Forbidden path scan -> 30 changed/untracked paths, 0 hits.
  - Strict credential-shape scan -> 3656 added/untracked lines, 0 hits.
