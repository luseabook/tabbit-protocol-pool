# Auth Send Delivery Evidence Audit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent generic transport success from satisfying auth send-code coverage before a safe real delivery-success fixture exists.

**Architecture:** Keep `ProtocolTabbitClient.sendVerificationCode()` and `AccountProvisioner` runtime orchestration unchanged. Tighten only the read-only auth fixture audit so send-code attempts remain visible, but `successful_sendVerificationCode_fixture` requires a delivery-specific signal rather than `status:"success"` alone. The CLI continues to read only auth operation fixtures and prints aggregate coverage only.

**Tech Stack:** Node.js ESM, native `node:test`, existing `buildProtocolFixtureAudit({ scope:"auth" })`, `fixtures audit --scope auth`, and auth calibration docs.

---

### Task 1: Document Current Boundary

**Files:**
- Create: `docs/plans/2026-07-04-auth-send-delivery-evidence-audit.md`

**Step 1: Record the gap**

The current auth audit treats any `sendVerificationCode` fixture with `status:"success"` as `successful_sendVerificationCode_fixture`. That is too broad for real endpoint/body calibration because a bare 2xx/`ok:true` response can prove only transport success, not that Tabbit accepted and delivered/scheduled a verification code.

**Step 2: Define the safe rule**

`successful_sendVerificationCode_fixture` may be ready only when:

- `operation === "sendVerificationCode"`;
- `status === "success"`;
- result has a send/delivery-specific success field, such as:
  - boolean true in `codeSent`, `code_sent`, `verificationCodeSent`, `verification_code_sent`, `sent`, `emailSent`, `email_sent`, `mailSent`, `mail_sent`, `smsSent`, `sms_sent`;
  - success string in `sendResult`, `send_result`, `deliveryResult`, `delivery_result`, `verificationResult`, `verification_result`, `codeSendResult`, or `code_send_result`.

Generic `ok:true`, `status:"success"`, and `result:"success"` are not enough.

### Task 2: RED Observability Test

**Files:**
- Modify: `test/observability.test.js`

**Step 1: Write the failing test**

Add a test named `buildProtocolFixtureAudit requires delivery evidence for auth send success`.

Use a `sendVerificationCode` fixture with `status:"success"` and only:

```js
result: {
  ok: true,
  status: "success",
  result: "success",
}
```

Expected assertions:

- `counts.sendVerificationCode === 1`;
- `counts.successfulSendVerificationCode === 1` to preserve transport visibility;
- `counts.successfulSendVerificationCodeWithDeliverySignal === 0`;
- `coverage.authSendVerificationCode.status === "missing"`;
- `missing` still contains `successful_sendVerificationCode_fixture`;
- serialized audit output does not contain email, code, token, or raw payload text.

**Step 2: Run RED**

```powershell
node --test test\observability.test.js --test-name-pattern "delivery evidence"
```

Expected: FAIL because the current matcher treats any successful send-code fixture as coverage-ready.

### Task 3: RED CLI Test

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Extend auth scope test**

Update `fixtures audit --scope auth reports auth evidence coverage` so its send-code fixture has only generic success fields.

Expected assertions:

- CLI still reads the send-code fixture because it is an auth operation;
- `counts.successfulSendVerificationCode === 1`;
- `counts.successfulSendVerificationCodeWithDeliverySignal === 0`;
- `coverage.authSendVerificationCode.count === 0`;
- `missing` contains `successful_sendVerificationCode_fixture`;
- stdout does not contain raw email, code, token, session, or unrelated fixture body.

**Step 2: Run RED**

```powershell
node --test test\ops-cli.test.js --test-name-pattern "scope auth"
```

Expected: FAIL until auth send coverage uses delivery-specific evidence.

### Task 4: Minimal Implementation

**Files:**
- Modify: `src/observability.js`

**Step 1: Add send-code delivery matcher**

Add `fixtureMatchesAuthSendDeliverySuccess()`:

- returns false unless `fixtureMatchesAuthSendSuccess(fixture)`;
- reads `fixtureResult(fixture)`;
- accepts explicit boolean true fields for sent/delivery evidence;
- accepts success-like string values in send/delivery/verification/code-send result fields;
- does not accept generic `ok`, `status`, or `result`.

**Step 2: Preserve transport count**

Keep `successfulSendVerificationCode` as the transport success count. Add `successfulSendVerificationCodeWithDeliverySignal` and make `coverage.authSendVerificationCode` use that stricter count.

### Task 5: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M04-账号注册初始化/验证码注册流程.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`

**Step 1: Update audit wording**

Document that auth send-code coverage requires delivery-specific evidence. Generic 2xx/`ok/status/result:"success"` remains visible as transport success but does not close `successful_sendVerificationCode_fixture`.

### Task 6: Verification

**Files:**
- Inspect: `git status --short --untracked-files=all`

**Step 1: Focused checks**

```powershell
node --test test\observability.test.js --test-name-pattern "delivery evidence"
node --test test\ops-cli.test.js --test-name-pattern "scope auth"
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
node bin\tabbit-pool.js fixtures audit --scope auth --json
```

Only inspect aggregate JSON. Do not print raw fixture files.

**Step 4: Secret boundary**

Run `git diff --check`, forbidden-path scan, and added-line raw secret pattern scan. Confirm no forbidden local files were touched.
