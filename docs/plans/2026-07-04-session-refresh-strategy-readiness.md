# Session Refresh Strategy Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep session lifecycle evidence separate from session recovery readiness so a successful/expired pair does not imply automated refresh is usable.

**Architecture:** Reuse the existing read-only `fixtures audit --scope session` path and do not add any network probing or refresh endpoint guesses. The scope continues to report valid-session and expired-session fixture coverage, but its overall status remains blocked while `recoveryStrategy.automatedRefresh` is `not_calibrated`. `readiness doctor.calibrationBacklog` then keeps session recovery visible even if core gateway readiness is already ready.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit({ scope:"session" })`, `buildReadinessDoctorReport()`, `fixtures audit --scope session`, and M08/session calibration docs.

---

### Task 1: Document Current Boundary

**Files:**
- Create: `docs/plans/2026-07-04-session-refresh-strategy-readiness.md`

**Step 1: Record the gap**

The current session scope returns `status:"ready"` when it has one successful `verifySession` fixture and one upstream 401/login_required expired fixture. That proves lifecycle observation, but it does not prove an automated refresh or recovery strategy.

**Step 2: Define the safe rule**

Session scope status should be `blocked` while:

- `recoveryStrategy.current === "manual_reimport_then_probe"`;
- `recoveryStrategy.automatedRefresh === "not_calibrated"`.

The lifecycle coverage items may still be ready. The additional missing name should be:

```text
automated_session_refresh_strategy
```

### Task 2: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add a test named `buildProtocolFixtureAudit keeps session scope blocked until refresh strategy is calibrated`.

Use fixtures containing:

- one `verifySession` success with `observedAt`;
- one upstream expired `verifySession` failed fixture with `category:"login_required"` and status 401.

Expected assertions:

- lifecycle coverage remains ready;
- `recoveryStrategy.current === "manual_reimport_then_probe"`;
- `recoveryStrategy.automatedRefresh === "not_calibrated"`;
- `recoveryStrategy.status === "blocked"`;
- audit `status === "blocked"`;
- `missing` includes only `automated_session_refresh_strategy` once lifecycle evidence is present.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "refresh strategy"
```

Expected: FAIL because the current session scope reports ready and does not expose a recovery strategy status/missing item.

### Task 3: RED CLI/Doctor Test

**Files:**
- Modify: `test/ops-cli.test.js`
- Modify: `test/observability.test.js`

**Step 1: Update CLI session scope test**

In `fixtures audit --scope session reports session lifecycle evidence`, keep the same success and expired fixtures but expect:

- `body.status === "blocked"`;
- `body.recoveryStrategy.status === "blocked"`;
- `body.missing === ["automated_session_refresh_strategy"]`.

**Step 2: Update doctor backlog test**

Update the doctor backlog assertions so session scope remains blocked until refresh strategy is calibrated even when success/expired evidence exists. The top-level core `status` and `remainingWork` stay unchanged.

**Step 3: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope session|readiness doctor"
```

Expected: FAIL until session audit includes the refresh strategy missing item.

### Task 4: Minimal Implementation

**Files:**
- Modify: `src/observability.js`

**Step 1: Add recovery strategy item**

In `buildSessionFixtureAudit()`:

- keep lifecycle coverage unchanged;
- create `recoveryStrategy` with `status:"blocked"`, `current:"manual_reimport_then_probe"`, and `automatedRefresh:"not_calibrated"`;
- append `automated_session_refresh_strategy` to `missing` while recovery strategy status is not ready;
- add a nextAction explaining that a safe refresh/re-auth endpoint must be captured before enabling automated recovery.

**Step 2: Preserve secret boundary**

Do not include fixture body, cookie, token, email, user id, raw request/response, or refresh payloads in the audit output.

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/06-数据字典.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Update wording**

Document that session lifecycle evidence and session recovery readiness are separate. `successful_verifySession_fixture` and `expired_verifySession_fixture` can be ready while session scope remains blocked because `automated_session_refresh_strategy` is missing.

### Task 6: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused checks**

```powershell
node --test test\observability.test.js --test-name-pattern "refresh strategy"
node --test test\ops-cli.test.js --test-name-pattern "scope session|readiness doctor"
```

**Step 2: Required regression checks**

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
npm test
```

**Step 3: External aggregate checks**

With `TABBIT_POOL_STATE_DIR=E:\tabbit2api\output\tabbit-live-state` and explicit protocol env, run:

```powershell
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope session --json
```

Expected: no raw fixture output; session scope can show success/expired lifecycle coverage ready while overall session scope remains blocked for `automated_session_refresh_strategy`.

**Step 4: Secret boundary**

Run `git diff --check`, forbidden-path scan, and added-line raw secret pattern scan. Confirm no forbidden local files were touched.
