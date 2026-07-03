# Account Pool Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first offline-testable M02 AccountPool foundation: account status normalization, account selection with round-robin and eligibility filters, success/failure state recording, and fallback decisions.

**Architecture:** Keep the account pool in memory for this phase. Persistence is deliberately deferred to the storage module, but the API returns updated account snapshots so a future store can write changes atomically. The selector is deterministic with injected `now()` and an internal round-robin cursor, making tests stable and enabling later gateway integration.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `assert/strict`, no external dependencies.

---

### Task 1: Account status and selector

**Files:**
- Create: `tabbit-protocol-pool/src/account-pool.js`
- Modify: `tabbit-protocol-pool/src/index.js`
- Create: `tabbit-protocol-pool/test/account-pool.test.js`

**Step 1: Write the failing test**

Test that `AccountPool.pickAccount()` round-robins active accounts, excludes `disabled/provisioning/login_expired/quota_exhausted`, excludes not-yet-expired cooldown accounts, respects `excludeAccountIds`, filters premium requirements, and throws `AccountPoolError` with `code: "NO_AVAILABLE_ACCOUNT"` when no account can be selected.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/account-pool.test.js`
Expected: FAIL because `account-pool.js` does not exist.

**Step 3: Write minimal implementation**

Implement `AccountPool`, `AccountPoolError`, `normalizeAccount()`, `isAccountSelectable()`, and `scoreAccount()` with deterministic candidate reasons.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/account-pool.test.js`
Expected: PASS.

### Task 2: Success and failure state recording

**Files:**
- Modify: `tabbit-protocol-pool/src/account-pool.js`
- Modify: `tabbit-protocol-pool/test/account-pool.test.js`

**Step 1: Write the failing test**

Test that `recordSuccess()` clears `failureStreak`, marks an account active, writes `lastSuccessAt`, and appends an audit event. Test that `recordFailure()` maps protocol categories to `login_expired`, `quota_exhausted`, `cooldown`, or `suspect`, applies cooldown durations, increments failure streak, and appends audit events.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/account-pool.test.js`
Expected: FAIL because recording methods are missing.

**Step 3: Write minimal implementation**

Implement immutable account updates, default cooldown rules, `getAccount()`, `listAccounts()`, `recordSuccess()`, and `recordFailure()`.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/account-pool.test.js`
Expected: PASS.

### Task 3: Fallback decision helpers

**Files:**
- Modify: `tabbit-protocol-pool/src/account-pool.js`
- Modify: `tabbit-protocol-pool/test/account-pool.test.js`

**Step 1: Write the failing test**

Test that `shouldFallback()` returns true only for retryable account-local failures with remaining retry budget and candidate accounts, and false for `protocol_changed`, `login_required`, exhausted retry budget, or no remaining account.

**Step 2: Run test to verify it fails**

Run: `cd tabbit-protocol-pool && node --test test/account-pool.test.js`
Expected: FAIL because `shouldFallback()` is missing.

**Step 3: Write minimal implementation**

Implement `shouldFallback({ error, attemptedAccountIds, model, retryCount, retryLimit })` using `pickAccount()` internally with exclusions.

**Step 4: Run test to verify it passes**

Run: `cd tabbit-protocol-pool && node --test test/account-pool.test.js`
Expected: PASS.

### Task 4: Regression

**Files:**
- Modify docs only if status changes.

**Step 1: Run new project tests**

Run: `cd tabbit-protocol-pool && npm test`
Expected: PASS.

**Step 2: Run root project tests**

Run: `npm test`
Expected: PASS.
