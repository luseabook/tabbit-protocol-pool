# Session Lifecycle Fixture Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a read-only session lifecycle audit scope so operators can see whether valid-session and expired-session evidence exists, instead of treating one successful `verifySession` fixture as a complete session recovery strategy.

**Architecture:** Reuse existing sanitized protocol probe fixtures and `buildProtocolFixtureAudit()`. Add a `session` scope that only inspects `verifySession` fixtures and reports current success evidence, upstream expiration evidence, observed timestamps, and the current recovery strategy. Wire it into `fixtures audit --scope session` and `readiness doctor.calibrationBacklog` without changing default gateway readiness or triggering any network/probe calls.

**Tech Stack:** Node.js ESM, native `node:test`, existing `src/observability.js`, `src/ops-cli.js`, `FileProtocolFixtureStore`, and docs under `docs/`.

---

### Task 1: RED Observability Test for Session Scope

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write a failing scope test**

Add a test named `buildProtocolFixtureAudit supports session lifecycle fixture scope`.

Use fixtures:

```js
[
  {
    operation: "verifySession",
    status: "success",
    observedAt: "2026-07-02T03:00:00.000Z",
    result: { ok: true, userId: "user_123", raw: { token: "secret-token" } },
  },
  {
    operation: "verifySession",
    status: "failed",
    observedAt: "2026-07-03T03:00:00.000Z",
    error: { category: "login_required", status: 401, message: "expired beta-user@example.test token=secret" },
  },
  {
    operation: "verifySession",
    status: "failed",
    observedAt: "2026-07-03T04:00:00.000Z",
    error: { category: "session_missing", message: "local secret missing token=secret" },
  },
]
```

Expected:

- `audit.scope === "session"`.
- `audit.status === "ready"` because success and upstream expiration evidence both exist.
- counts include `verifySession:3`, `successfulVerifySession:1`, `expiredVerifySession:1`, `sessionMissing:1`.
- coverage includes ready `successfulSessionVerify` and ready `expiredSessionSignal`.
- `audit.lifecycle.lastSuccessfulAt` and `audit.lifecycle.lastExpiredAt` are set.
- `audit.recoveryStrategy.current === "manual_reimport_then_probe"`.
- serialized output does not include email, token, session, or raw user id.

**Step 2: Run RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "session lifecycle"
```

Expected: FAIL because `scope:"session"` is not implemented.

### Task 2: RED CLI Test for Session Scope

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write a failing CLI test**

Add a test named `fixtures audit --scope session reports session lifecycle evidence`.

Use a fixture store with `listFixtures()` returning refs and `readFixture(ref)` returning one success and one 401/login_required `verifySession` fixture. Expected:

- CLI calls only `listFixtures` and `readFixture:*`.
- JSON output has `scope:"session"`, `status:"ready"`, ready coverage, and no raw email/session/token.

**Step 2: Update unsupported-scope test expectation**

`session` must no longer be rejected.

**Step 3: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope session|unsupported scopes"
```

Expected: FAIL because CLI only accepts protocol/auth/benefits.

### Task 3: Implement Session Scope

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1: Add session matchers**

Add helpers:

- `fixtureMatchesSessionExpired(fixture)` for `operation:"verifySession"` with status failed and `login_required` or HTTP 401 signals under `fixture.error` or `fixtureResult(fixture).error`.
- `fixtureMatchesSessionMissing(fixture)` for local `session_missing`, counted separately but not treated as upstream expiration.
- timestamp helpers that safely pick latest valid ISO timestamp from `observedAt`.

**Step 2: Add `buildSessionFixtureAudit()`**

Return:

```js
{
  scope: "session",
  status: missing.length ? "blocked" : "ready",
  observedAt,
  counts: {
    total,
    verifySession,
    successfulVerifySession,
    expiredVerifySession,
    sessionMissing,
    success,
    failed,
  },
  coverage: {
    successfulSessionVerify,
    expiredSessionSignal,
  },
  lifecycle: {
    lastSuccessfulAt,
    lastExpiredAt,
    observedWindowMs,
  },
  recoveryStrategy: {
    current: "manual_reimport_then_probe",
    automatedRefresh: "not_calibrated",
  },
  missing,
  nextActions,
}
```

If success is missing, next action asks for a read-only `verifySession` success fixture. If expired evidence is missing, next action asks to capture a sanitized 401/login_required `verifySession` fixture after session expiry.

**Step 3: Wire scope and doctor backlog**

- `buildProtocolFixtureAudit({ scope:"session" })` returns session audit.
- `readinessDoctorCommands()` adds `sessionFixturesAudit`.
- `buildReadinessDoctorReport()` includes `session` under `calibrationBacklog.scopes`, and merges its missing/nextActions.
- Top-level `status`, `readiness`, `fixtureAudit`, and `remainingWork` remain unchanged.

**Step 4: Wire CLI scope**

- Help text becomes `--scope <protocol|auth|benefits|session>`.
- Accepted scope set includes `session`.
- Non-JSON output prints success/expired/session_missing counts.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document session scope**

State that `fixtures audit --scope session --json` is read-only and checks sanitized `verifySession` success plus upstream 401/login_required expiration evidence.

**Step 2: Document backlog semantics**

Clarify that `readiness doctor.calibrationBacklog` includes auth, benefits, and session scopes. Core readiness can be ready while session lifecycle evidence remains blocked.

**Step 3: Preserve recovery boundary**

Document that the current recovery strategy is `manual_reimport_then_probe`; automated refresh remains uncalibrated until a safe refresh path is captured and tested.

### Task 5: Verification

**Step 1: Focused tests**

Run:

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
node --test test\protocol-tabbit-client.test.js
```

**Step 2: Full tests**

Run:

```powershell
npm test
```

**Step 3: External state read-only check**

Run:

```powershell
$env:TABBIT_POOL_STATE_DIR = "E:\tabbit2api\output\tabbit-live-state"
$env:TABBIT_POOL_PROTOCOL_ENABLED = "true"
$env:TABBIT_POOL_PROTOCOL_BASE_URL = "https://web.tabbit.ai"
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
$env:TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS = "true"
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope session --json
```

Expected: no raw fixture output; external state may remain blocked for `expired_verifySession_fixture` until a safe 401/login_required session expiry fixture is captured.

**Step 4: Secret boundary**

Run forbidden-path and sensitive-token scans. Confirm no forbidden local files or raw state fixtures were touched.
