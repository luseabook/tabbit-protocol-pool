# Pooled Request Runner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first request runner that connects AccountPool selection/fallback with ProtocolTabbitClient message sending.

**Architecture:** Keep HTTP compatibility outside this phase and implement a small orchestration layer. The runner receives normalized messages, picks an account, invokes an injected protocol client, records account success/failure, and optionally falls back to a second account based on AccountPool policy. This makes M06 gateway integration possible without depending on live Tabbit endpoints.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `assert/strict`, dependency-injected protocol clients.

---

### Task 1: Successful request orchestration

**Files:**
- Create: `tabbit-protocol-pool/src/pooled-request-runner.js`
- Modify: `tabbit-protocol-pool/src/index.js`
- Create: `tabbit-protocol-pool/test/pooled-request-runner.test.js`

**Step 1: Write the failing test**

Test that `PooledRequestRunner.run()` picks an account, calls the injected protocol client with account/model/messages/attachments/stream, records success, and returns account/model/fallback metadata.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/pooled-request-runner.test.js`
Expected: FAIL because `pooled-request-runner.js` does not exist.

**Step 3: Write minimal implementation**

Implement `PooledRequestRunner` and `PooledRequestError` with a single-attempt success path.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/pooled-request-runner.test.js`
Expected: PASS.

### Task 2: Failure recording and fallback

**Files:**
- Modify: `tabbit-protocol-pool/src/pooled-request-runner.js`
- Modify: `tabbit-protocol-pool/test/pooled-request-runner.test.js`

**Step 1: Write the failing test**

Test that a retryable first-account failure records failure, consults `AccountPool.shouldFallback()`, retries another account, records success, and returns `fallbackHappened: true` with both attempted accounts.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/pooled-request-runner.test.js`
Expected: FAIL because fallback is missing.

**Step 3: Write minimal implementation**

Loop over attempts up to `retryLimit`, normalize thrown errors and `{ ok:false }` results, call `recordFailure()`, and use `shouldFallback()` to pick the next account.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/pooled-request-runner.test.js`
Expected: PASS.

### Task 3: Non-retryable and no-account results

**Files:**
- Modify: `tabbit-protocol-pool/src/pooled-request-runner.js`
- Modify: `tabbit-protocol-pool/test/pooled-request-runner.test.js`

**Step 1: Write the failing test**

Test that `protocol_changed` does not fallback and no available account returns a stable `{ ok:false, error.category: "no_available_account" }` shape.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/pooled-request-runner.test.js`
Expected: FAIL if non-retryable/no-account behavior is missing.

**Step 3: Write minimal implementation**

Convert AccountPoolError to a pooled error result and stop on global/non-retryable categories.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/pooled-request-runner.test.js`
Expected: PASS.

### Task 4: Regression

Run `cd tabbit-protocol-pool && npm test`, then root `npm test`.
