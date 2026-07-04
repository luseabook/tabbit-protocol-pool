# Auth Fixture Audit Scope Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a read-only auth fixture audit scope so operators can see whether send-code and submit-code evidence has been captured without changing the existing chat/gateway readiness gate.

**Architecture:** Extend the observability audit helper with a scoped mode. The existing default `buildProtocolFixtureAudit()` and `fixtures audit` behavior stays focused on verify/send/stream/tool/403 readiness; `scope:"auth"` counts only `sendVerificationCode` and `submitRegistrationOrLogin` protocol probe fixtures and reports missing auth evidence names. The CLI exposes this through `tabbit-pool fixtures audit --scope auth --json` and never prints fixture bodies.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit()`, `readProtocolFixtureDetails()`, `runProtocolPoolCli()`, protocol probe fixture sanitizer, and docs under `docs/`.

---

### Task 1: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add a test named `buildProtocolFixtureAudit supports auth fixture scope`.

It should call:

```js
buildProtocolFixtureAudit({
  scope: "auth",
  fixtures: [
    { operation: "sendVerificationCode", status: "success", input: { email: "new-user@example.test" } },
    { operation: "submitRegistrationOrLogin", status: "failed", error: { category: "code_invalid" } },
  ],
  now: () => NOW,
});
```

Expected assertions:

- `scope === "auth"`.
- `status === "blocked"` because submit success is missing.
- `counts.sendVerificationCode === 1`.
- `counts.submitRegistrationOrLogin === 1`.
- `counts.successfulSendVerificationCode === 1`.
- `counts.successfulSubmitRegistrationOrLogin === 0`.
- `coverage.authSendVerificationCode.status === "ready"`.
- `coverage.authSubmitRegistrationOrLogin.status === "missing"`.
- `missing` contains `successful_submitRegistrationOrLogin_fixture`.
- serialized output does not include the raw email.

**Step 2: Run RED**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "auth fixture scope"
```

Expected: FAIL because `scope:"auth"` is not implemented.

### Task 2: RED CLI Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Write the failing test**

Add a test named `fixtures audit --scope auth reports auth evidence coverage`.

Use injected `protocolFixtureStore` with summaries and `readFixture(ref)` returning sanitized auth fixtures:

- `sendVerificationCode` success.
- `submitRegistrationOrLogin` failed.

Run:

```js
runProtocolPoolCli(["fixtures", "audit", "--scope", "auth", "--json"], ...)
```

Expected assertions:

- CLI reads fixture details but does not call network.
- output has `scope:"auth"`.
- output status is `blocked`.
- missing contains `successful_submitRegistrationOrLogin_fixture`.
- stdout does not contain raw email, code, cookie, session, token, or raw payload.

**Step 2: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope auth"
```

Expected: FAIL until the CLI parses and passes scope.

### Task 3: Implement Scoped Audit

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1: Add auth audit helper logic**

In `buildProtocolFixtureAudit({ fixtures, now, scope })`:

- If `scope === "auth"`, return auth-specific shape.
- Count all auth operation fixtures.
- Count successful `sendVerificationCode` and successful `submitRegistrationOrLogin` fixtures.
- Return `status:"ready"` only when both success counts are greater than zero.
- Return missing names:
  - `successful_sendVerificationCode_fixture`
  - `successful_submitRegistrationOrLogin_fixture`
- Return next actions that point to the two auth `probe protocol` commands.
- Keep fixture bodies out of the audit output.

**Step 2: Keep default behavior unchanged**

The existing default audit scope must remain unchanged so current readiness doctor and gateway readiness semantics do not start requiring auth evidence.

**Step 3: Add CLI scope parsing**

In `handleFixturesAudit()`, parse optional `--scope`; pass `scope` to `buildProtocolFixtureAudit()`. Reject unsupported scopes with `CliUsageError` and exitCode 2. Supported values:

- omitted/default: existing audit.
- `protocol`: alias for existing audit.
- `auth`: new auth audit.

### Task 4: Documentation

**Files:**
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/modules/M04-账号注册初始化/验证码注册流程.md`

**Step 1: Document command**

Document:

```powershell
node bin\tabbit-pool.js fixtures audit --scope auth --json
```

Clarify it is read-only and optional for auth calibration, while default `fixtures audit` remains the chat/gateway readiness coverage check.

**Step 2: Update tracking**

Record that priority 1 now has both capture and audit pipeline. Real endpoint/body/session success evidence is still missing.

### Task 5: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused tests**

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "auth fixture scope"
node --test test\ops-cli.test.js --test-name-pattern "scope auth"
```

**Step 2: Regression tests**

Run:

```powershell
node --test test\observability.test.js
node --test test\ops-cli.test.js
npm test
```

**Step 3: External state read-only check**

Run readiness doctor/readiness/fixtures audit against `E:\tabbit2api\output\tabbit-live-state`; additionally run `fixtures audit --scope auth --json` to show the auth evidence gap without printing fixture bodies.

**Step 4: Secret boundary**

Run forbidden-path and sensitive-token scans. Confirm no forbidden local files were touched.
