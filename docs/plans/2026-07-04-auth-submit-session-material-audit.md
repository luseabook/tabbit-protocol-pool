# Auth Submit Session Material Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make auth calibration audit require usable session material for `submitRegistrationOrLogin` success evidence, so priority-1 registration/login cannot be marked ready by a sanitized 2xx fixture that cannot activate an account.

**Architecture:** Keep real auth endpoint/body discovery outside this change. Reuse local sanitized protocol probe fixtures and the existing `buildProtocolFixtureAudit({ scope:"auth" })` path, but split submit-code evidence into transport success and usable session-material success. The default protocol readiness, probe execution, and AccountProvisioner orchestration remain unchanged.

**Tech Stack:** Node.js ESM, native `node:test`, existing `src/observability.js`, `src/ops-cli.js`, `AccountProvisioner.extractSessionSecret()` semantics, and docs under `docs/`.

---

### Task 1: RED Observability Test for Submit Session Material

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Add failing test**

Add a test named `buildProtocolFixtureAudit requires session material for auth submit success evidence`.

Fixtures:

```js
[
  {
    operation: "sendVerificationCode",
    status: "success",
    result: { ok: true },
  },
  {
    operation: "submitRegistrationOrLogin",
    status: "success",
    result: { ok: true, userId: "user_without_session" },
  },
]
```

Expected:

- `audit.scope === "auth"`.
- `audit.status === "blocked"`.
- send-code coverage is ready.
- submit-code transport count is visible as `counts.successfulSubmitRegistrationOrLogin === 1`.
- usable submit session material count is `0`.
- submit coverage remains missing and `missing` contains `successful_submitRegistrationOrLogin_fixture`.
- serialized output does not include raw user id, token, cookie, session, or email.

**Step 2: Run RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "session material for auth submit"
```

Expected: FAIL because current auth audit counts any successful submit fixture as ready.

### Task 2: RED CLI Test for Auth Submit Session Material

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Extend auth scope CLI test**

Add a `submitRegistrationOrLogin` fixture with `status:"success"` and `{ ok:true, userId:"user_without_session" }`, plus a `sendMessage` fixture that must not affect auth scope coverage.

Expected:

- CLI reads auth refs only for auth scope, not unrelated `sendMessage` refs.
- JSON output keeps auth scope blocked.
- `counts.successfulSubmitRegistrationOrLogin === 1`.
- `counts.successfulSubmitRegistrationOrLoginWithSessionMaterial === 0`.
- `coverage.authSubmitRegistrationOrLogin.status === "missing"`.

**Step 2: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope auth"
```

Expected: FAIL because current CLI reads all fixture refs and current audit treats submit transport success as ready.

### Task 3: Implement Auth Session-Material Gate

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1: Add matcher**

Add a helper equivalent to `AccountProvisioner.extractSessionSecret()` but local to observability to avoid pulling provisioning state into M08:

- Check `fixtureResult(fixture)`.
- Accept non-empty string values under `cookieHeader`, `cookie`, `session`, `sessionToken`, or `token`.
- Accept non-null `cookieJar`.
- Return false for missing, empty, or redacted-only values if the field cannot activate an account.

**Step 2: Gate submit coverage**

- Keep `successfulSubmitRegistrationOrLogin` as the transport success count for visibility.
- Add `successfulSubmitRegistrationOrLoginWithSessionMaterial`.
- Make `coverage.authSubmitRegistrationOrLogin` use the session-material count.
- Keep missing name `successful_submitRegistrationOrLogin_fixture`.
- Add a nextAction that asks for a sanitized submit fixture that proves session material or another safe import path.

**Step 3: Scope-aware CLI fixture loading**

- Reuse `readProtocolFixtureDetails(protocolFixtureStore, { operation })` for session.
- Add auth operation filtering so auth scope only reads `sendVerificationCode` and `submitRegistrationOrLogin` fixture refs.
- Leave protocol and benefits scope behavior unchanged.

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M04-账号注册初始化/验证码注册流程.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Document submit evidence boundary**

State that auth scope requires:

- successful `sendVerificationCode` fixture;
- successful `submitRegistrationOrLogin` fixture that still contains sanitized evidence of session material shape (`cookieHeader`, `cookie`, `cookieJar`, `session`, `sessionToken`, or `token`) or a future explicitly documented safe import path.

**Step 2: Clarify non-completion**

Clarify that this is not real endpoint/body calibration. The priority-1 item remains blocked until safe real success fixtures are captured.

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

Run with `E:\tabbit2api\output\tabbit-live-state`:

```powershell
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope auth --json
```

Expected: no raw fixture content; auth remains blocked until real safe success evidence is present.

**Step 4: Safety scans**

Run diff check, forbidden path scan, and strict sensitive pattern scan. Confirm no `tabbit-cookie.txt`, `output/`, browser profiles, local state fixtures, `.agents/`, `.codex/`, or `.omx/` files were touched.
