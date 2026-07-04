# Auth Probe Fixture Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let operators safely capture sanitized send-code and submit-code auth evidence through the existing `probe protocol` fixture pipeline.

**Architecture:** Extend `ProtocolProbeRunner.dispatch()` and the ops CLI probe template/schema layer with two explicit operations: `sendVerificationCode` and `submitRegistrationOrLogin`. Both are side-effect operations, so templates default `confirmSideEffect:false`, validation rejects unsafe or malformed payloads before the runner is called, and dispatch only calls the protocol client when `confirmSideEffect:true` is explicitly supplied.

**Tech Stack:** Node.js ESM, native `node:test`, existing `ProtocolProbeRunner`, `buildProtocolProbeFixture()`, `sanitizeProtocolProbeFixture()`, `runProtocolPoolCli()`, and protocol fixture redaction.

---

### Task 1: Document the Auth Probe Gap

**Files:**
- Create: `docs/plans/2026-07-03-auth-probe-fixture-pipeline.md`

**Step 1: Record the current state**

`ProtocolTabbitClient` already exposes `sendVerificationCode()` and `submitRegistrationOrLogin()`, but `probe protocol` cannot dispatch these operations. This prevents safe auth endpoint/body evidence capture from using the repository's existing sanitized fixture path.

**Step 2: Define safety boundaries**

Both auth operations can create email or login side effects. Templates must default to `confirmSideEffect:false`; schema validation must require explicit boolean `confirmSideEffect`; dispatch must reject `confirmSideEffect !== true` before invoking the protocol client. Fixture redaction must remove email, verification code, cookie, session, token, and raw payload values.

### Task 2: RED Tests for Protocol Probe Dispatch

**Files:**
- Modify: `test/protocol-probe.test.js`

**Step 1: Add failing dispatch test**

Add a test named `ProtocolProbeRunner dispatches auth probes only with explicit confirmation`.

It should:

- create an active account with `cookieJarRef` and a secret value;
- create a provisioning account without `cookieJarRef` to prove auth probes can run before login/session creation;
- inject a protocol client with `sendVerificationCode()` and `submitRegistrationOrLogin()` stubs;
- call `probeAccount()` for both operations with `confirmSideEffect:true`;
- assert runtime account is hydrated;
- assert the confirmed send-code probe can dispatch without stored session material;
- assert fixture operation names are preserved;
- assert serialized results do not contain raw email, code, cookie/session, or token values.

**Step 2: Add no-confirmation guard test**

Call `probeAccount()` for both auth operations with missing/false `confirmSideEffect` and assert:

- status is `failed`;
- advice/category is `invalid_request` or equivalent;
- injected protocol stubs are not called;
- fixture does not contain raw email/code values.

**Step 3: Run RED**

Run:

```powershell
node --test test\protocol-probe.test.js --test-name-pattern "auth probes"
```

Expected: FAIL because dispatch does not support these operations.

### Task 3: RED Tests for CLI Template and Schema

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Template tests**

Add assertions that:

```powershell
tabbit-pool probe template --operation sendVerificationCode --json
tabbit-pool probe template --operation submitRegistrationOrLogin --json
```

return safe placeholder payloads with `confirmSideEffect:false`, placeholder email/code values, and no cookie/token/session.

**Step 2: Schema validation tests**

Add tests that:

- valid auth payloads pass through to `protocolProbeRunner.probeAccount({ input })`;
- missing email, empty body, non-boolean `confirmSideEffect`, and submit payload missing code return exitCode 2 before runner call;
- stderr does not include raw email, code, token, or raw JSON payload.

**Step 3: Run RED**

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "auth|verification code"
```

Expected: FAIL until templates and validators are implemented.

### Task 4: Implement Auth Probe Support

**Files:**
- Modify: `src/protocol-probe.js`
- Modify: `src/ops-cli.js`

**Step 1: Add dispatch operations**

In `ProtocolProbeRunner.dispatch()` add:

- `sendVerificationCode`
- `submitRegistrationOrLogin`

Both must check `input.confirmSideEffect === true` before reading secrets or calling the protocol client and return a failed result if not confirmed. They should pass `email`, `code`, `body`, and `input` through to the protocol client, plus the runtime account. Auth probes can run against provisioning account metadata without stored session material; all other probe operations still require a readable local session secret.

**Step 2: Add templates**

In `buildProbeInputTemplate()` add safe placeholders:

```json
{
  "email": "new-user@example.test",
  "body": { "email": "new-user@example.test" },
  "confirmSideEffect": false
}
```

and submit variant including placeholder code/body.

**Step 3: Add validation**

In `validateProbeInputForOperation()` validate:

- `confirmSideEffect` exists when provided and is boolean;
- `email` is a non-empty string;
- `code` is a non-empty string for submit;
- `body`, when present, is a plain object;
- reject arrays/null bodies.

**Step 4: Run GREEN**

Run the focused tests from Tasks 2 and 3 and require PASS.

### Task 5: Documentation and Tracking

**Files:**
- Modify: `docs/modules/M04-账号注册初始化/验证码注册流程.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/04-开发追踪.md`

**Step 1: Update M04**

Document that auth evidence can now be captured through `probe protocol` once real endpoint/body details are known, but requires explicit confirmation and sanitized fixture review.

**Step 2: Update API/reference docs**

Document the two new probe operations and their payload shape.

**Step 3: Update tracking**

Record that the evidence capture pipeline exists; the remaining blocker is still real success evidence.

### Task 6: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused tests**

Run:

```powershell
node --test test\protocol-probe.test.js
node --test test\ops-cli.test.js
```

**Step 2: Required tests**

Run:

```powershell
node --test test\protocol-tabbit-client.test.js
npm test
```

**Step 3: External state read-only evidence**

Run readiness doctor/readiness/fixtures audit with `E:\tabbit2api\output\tabbit-live-state`, without printing fixture bodies.

**Step 4: Secret boundary**

Check `git status` and run a sensitive-token scan over changed files. Confirm no `tabbit-cookie.txt`, `output/`, browser profile, local state fixture, `.agents/`, `.codex/`, or `.omx/` files are touched.
