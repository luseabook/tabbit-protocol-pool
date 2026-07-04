# Send Message Capture Reviewed Input Marker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Implemented and verified on 2026-07-04.

**Goal:** Make readiness doctor sendMessage capture commands explicitly state that the generated input must be reviewed and the redacted message placeholder must be replaced before running `probe protocol`.

**Architecture:** Keep readiness and fixture audit semantics unchanged. Add metadata to sendMessage capture command specs only, surface it in JSON and plain doctor output, and document that this is an operator safety marker rather than a readiness shortcut.

**Tech Stack:** Node.js, built-in `node:test`, PowerShell verification commands.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/observability.test.js`
- Modify: `test/ops-cli.test.js`

**Step 1: JSON doctor regression**

Add assertions to the default send and upstream capture command tests:

```js
assert.equal(command.requiresReviewedInput, true);
assert.equal(command.reviewRequirement, "replace_redacted_message_content");
```

The assertions should cover:

- `successful_sendMessage_fixture`
- `streaming_text_fixture`
- `tool_call_fixture`
- `real_upstream_error_frame_fixture`
- `real_upstream_cancellation_fixture`
- `real_upstream_backpressure_fixture`

**Step 2: Plain doctor regression**

Update plain `capture_command` assertions for sendMessage commands so they require:

```text
review=replace_redacted_message_content
```

Expected RED command:

```powershell
node --test test\observability.test.js --test-name-pattern "capture command"
node --test test\ops-cli.test.js --test-name-pattern "capture command"
```

Expected before implementation: FAIL because sendMessage capture commands do not expose a reviewed-input marker.

### Task 2: Implementation

**Files:**
- Modify: `src/observability.js`
- Modify: `src/ops-cli.js`

**Step 1:** Add `requiresReviewedInput:true` and `reviewRequirement:"replace_redacted_message_content"` to all capture command specs with `operation:"sendMessage"`.

**Step 2:** Add a `review=` field to `plainCaptureCommandLines()` only when `reviewRequirement` is present.

Do not change readiness status, fixture coverage, command prerequisites, or probe execution behavior.

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/13-真实协议校准与端到端验收.md`
- Modify: `docs/modules/M08-观测运维/_M08-观测运维.md`
- Modify: this plan

Document that sendMessage capture command rows include `review=replace_redacted_message_content`, and that this is a mandatory operator review step before real `probe protocol`.

### Task 4: Verification

Run:

```powershell
node --test test\observability.test.js --test-name-pattern "capture command"
node --test test\ops-cli.test.js --test-name-pattern "capture command"
node --test test\observability.test.js
node --test test\ops-cli.test.js
npm test
git diff --check
```

Then run readiness doctor/session/upstream aggregate audits, forbidden-path scan, and strict credential-shape diff scan.

## Execution Evidence

- RED verified:
  - `node --test test\observability.test.js --test-name-pattern "capture command"` failed because sendMessage capture commands did not expose `requiresReviewedInput` or `reviewRequirement`.
  - `node --test test\ops-cli.test.js --test-name-pattern "capture command"` failed because plain `capture_command` rows did not print `review=replace_redacted_message_content`.
- GREEN implementation:
  - `src/observability.js` now adds `requiresReviewedInput:true` and `reviewRequirement:"replace_redacted_message_content"` to every `operation:"sendMessage"` capture command.
  - `src/ops-cli.js` now prints `review=<reviewRequirement>` in plain capture command rows when present.
  - README, API docs, implementation reference, real protocol acceptance docs, M08 ops docs, and this plan document the reviewed-input marker.

Verification:

```powershell
node --test test\observability.test.js --test-name-pattern "capture command"
# pass: 46/46

node --test test\ops-cli.test.js --test-name-pattern "capture command"
# pass: 114/114

node --test test\observability.test.js
# pass: 46/46

node --test test\ops-cli.test.js
# pass: 114/114

npm test
# pass: 425/425

git diff --check
# exit 0; only LF/CRLF working-copy warnings
```

Default stateDir aggregate checks with `TABBIT_POOL_PROTOCOL_SEND_PATH=/api/v1/chat/completion` and `TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH=/api/v0/user/base-info`:

- `node bin\tabbit-pool.js readiness doctor --json` -> `status=blocked`, `readiness=blocked`, `fixtureAudit=blocked`, `manualCookieMode=blocked`; missing real sanitized fixtures and E2E marks.
- `node bin\tabbit-pool.js fixtures audit --scope session --json` -> `status=blocked`; missing `successful_verifySession_fixture`, `expired_verifySession_fixture`, and backlog `automated_session_refresh_strategy`.
- `node bin\tabbit-pool.js fixtures audit --scope upstream --json` -> `status=blocked`; missing `real_upstream_error_frame_fixture`, `real_upstream_cancellation_fixture`, and `real_upstream_backpressure_fixture`.

Safety scans:

- Forbidden path scan -> 43 changed/untracked paths, 0 hits.
- Strict credential-shape diff scan -> 43 scanned paths, 5012 added/untracked lines, 0 hits.
