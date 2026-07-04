# Send Message Validate Review Summary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `probe validate --operation sendMessage` explicitly report whether the input still contains the redacted message placeholder and whether it is ready for real protocol dispatch.

**Architecture:** Keep validation permissive for generated templates so operators can still review safe shapes. Add a sanitized `sendMessageReview` summary to validation output only; the real `probe protocol` gate remains the enforcement point and continues rejecting unreplaced placeholders before runner dispatch.

**Tech Stack:** Node.js, built-in `node:test`, PowerShell verification commands.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/ops-cli.test.js`

**Step 1: Placeholder template preview**

Extend the existing placeholder validation test so `probe validate --operation sendMessage --json` returns:

```js
sendMessageReview: {
  requiresReviewedInput: true,
  reviewRequirement: "replace_redacted_message_content",
  redactedMessageContentPresent: true,
  protocolDispatchReady: false,
}
```

Assert the output still does not print the placeholder body, prompt text, model, cookies, sessions, tokens, or API keys.

**Step 2: Reviewed input preview**

Extend the streamEvidence validation test with reviewed message content and assert:

```js
sendMessageReview.protocolDispatchReady === true
sendMessageReview.redactedMessageContentPresent === false
```

Expected RED command:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sendMessage"
```

Expected before implementation: FAIL because `sendMessageReview` is absent.

### Task 2: Implementation

**Files:**
- Modify: `src/ops-cli.js`

**Step 1:** Add a small helper that reuses existing `messageContentStrings()` and `REDACTED_MESSAGE_CONTENT_PLACEHOLDER`.

**Step 2:** In `buildProbeInputValidationPreview()`, when `operation === "sendMessage"`, add a `sendMessageReview` object with only booleans and the stable requirement name.

Do not include message content, model values, raw payload, endpoint, cookie, session, token, or account identifiers.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/07-API文档.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: this plan

Document that `probe validate` is a shape preflight and now emits a sanitized review summary; only `protocolDispatchReady:true` means the sendMessage input has at least one non-placeholder message string for dispatch.

### Task 4: Verification

Run:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sendMessage"
node --test test\ops-cli.test.js
npm test
git diff --check
```

Then run readiness doctor/session/upstream aggregate audits, forbidden-path scan, and strict credential-shape diff scan.

### Execution Evidence

RED evidence:

- `node --test test\ops-cli.test.js --test-name-pattern "sendMessage"` failed before implementation because `sendMessageReview` was absent from validate output.

Implementation summary:

- `src/ops-cli.js` now builds a `sendMessageReview` preview for `probe validate --operation sendMessage`.
- The preview contains only `requiresReviewedInput`, `reviewRequirement`, `redactedMessageContentPresent`, and `protocolDispatchReady`.
- `probe validate` remains permissive for placeholder templates; `probe protocol` remains the dispatch gate and still rejects unreplaced `<redacted-message-content>` before runner dispatch.

Documentation summary:

- `README.md`, `docs/07-API文档.md`, `docs/08-测试用例.md`, `docs/09-实现接口参考.md`, `docs/13-真实协议校准与端到端验收.md`, and `docs/modules/M08-观测运维/_M08-观测运维.md` now describe `sendMessageReview`.
- The docs state that `protocolDispatchReady:true` only means at least one non-placeholder message string exists; it does not prove content safety, real upstream success, fixture readiness, or manual-cookie release readiness.

Verification results:

```powershell
node --test test\ops-cli.test.js --test-name-pattern "sendMessage"
# pass: 114/114

node --test test\ops-cli.test.js
# pass: 114/114

node --test test\protocol-tabbit-client.test.js
# pass: 61/61

npm test
# pass: 425/425

git diff --check
# exit 0; only LF/CRLF warnings
```

Aggregate audit status with:

```powershell
$env:TABBIT_POOL_PROTOCOL_SEND_PATH = "/api/v1/chat/completion"
$env:TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info"
node bin\tabbit-pool.js readiness doctor --json
node bin\tabbit-pool.js fixtures audit --scope session --json
node bin\tabbit-pool.js fixtures audit --scope upstream --json
```

Results:

- `readiness doctor`: `status:"blocked"`, `manualCookieMode.status:"blocked"`, default fixture audit blocked because default stateDir has no real sanitized fixtures.
- `fixtures audit --scope session`: `status:"blocked"`; missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and backlog `automated_session_refresh_strategy`.
- `fixtures audit --scope upstream`: `status:"blocked"`; missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.

Safety scans:

```powershell
forbidden_path_scan
# changed_or_untracked_paths=44; hits=0

strict_credential_shape_scan
# added_or_untracked_lines=5343; hits=0
```

The credential-shape scan used a narrow allowlist for documented non-secret phrases such as `Bearer <redacted-bearer-like-value>`, local test refs, and explicit fake fixture placeholders; no real cookie, session, JWT, API key, Bearer value, raw payload, prompt, or real user data was printed or written.
