# BenefitsMaintainer Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an offline-testable M05 BenefitsMaintainer foundation that orchestrates quota refresh, daily check-in, Pro claiming, and reset coupon usage without guessing real Tabbit endpoint paths.

**Status:** Implemented on 2026-07-02. `test/benefits-maintainer.test.js` covers quota normalization, quota refresh state changes, daily check-in, Pro claiming, reset coupon usage, action continuation after failures, and constructor validation. `test/smoke.test.js` covers package entry exports.

**Architecture:** Introduce `src/benefits-maintainer.js` as a pure orchestration layer. It accepts an injected `protocolClient` whose optional methods represent protocol operations still waiting for endpoint restoration. The maintainer mutates normalized account metadata copies, returns auditable action results, and never stores raw secrets or hard-codes unknown Tabbit routes.

**Tech Stack:** Node.js ESM, native `node:test`, existing `normalizeAccount` from `account-pool.js`.

---

### Task 1: Quota refresh foundation

**Files:**
- Create: `test/benefits-maintainer.test.js`
- Create: `src/benefits-maintainer.js`

**Step 1: Write failing tests**

Add tests for:

- `normalizeQuotaState` converts raw quota entries into stable `QuotaState` objects with defaults.
- `refreshQuota(account)` calls injected `protocolClient.refreshQuota(account)`.
- A successful refresh updates `quotaState`, `resetCouponCount`, `accessTier`, `lastMaintainedAt`, and returns an audit action with `status:"success"`.
- Exhausted quota sets account status to `quota_exhausted`.
- Non-exhausted quota restores a `quota_exhausted` account to `active`.
- Refresh failure keeps the previous quota and returns `status:"failed"` with a sanitized message.

**Step 2: Run RED**

Run: `node --test test/benefits-maintainer.test.js`
Expected: FAIL because `src/benefits-maintainer.js` does not exist.

**Step 3: Implement minimal code**

Implement:

- `BenefitsMaintainerError`
- `normalizeQuotaState(entry, options)`
- `BenefitsMaintainer.refreshQuota(account)`

Do not add real endpoint URLs. Missing `protocolClient.refreshQuota` returns a skipped action.

**Step 4: Run GREEN**

Run: `node --test test/benefits-maintainer.test.js`
Expected: PASS.

### Task 2: Action orchestration

**Files:**
- Modify: `test/benefits-maintainer.test.js`
- Modify: `src/benefits-maintainer.js`

**Step 1: Write failing tests**

Add tests for:

- `dailyCheckin(account)` skips when `lastCheckinAt` is on the same UTC date as `now`.
- `dailyCheckin(account)` calls `protocolClient.dailyCheckin` when not already checked in and updates `lastCheckinAt`.
- `claimProIfAvailable(account)` skips existing pro/premium accounts.
- `claimProIfAvailable(account)` updates `accessTier` and `proClaimed` on success.
- `useResetCoupon(account)` skips unless account is `quota_exhausted` and `resetCouponCount > 0`.
- `useResetCoupon(account)` marks account active and decrements coupons on success.

**Step 2: Run RED**

Run: `node --test test/benefits-maintainer.test.js`
Expected: FAIL until methods exist.

**Step 3: Implement minimal code**

Implement the three action methods. Each returns:

~~~ts
type MaintenanceAction = {
  name: string;
  status: "success" | "skipped" | "failed";
  changed: boolean;
  detail?: string;
  error?: { message: string; code?: string; category?: string };
};
~~~

**Step 4: Run GREEN**

Run: `node --test test/benefits-maintainer.test.js`
Expected: PASS.

### Task 3: maintainAccount and exports/docs

**Files:**
- Modify: `test/benefits-maintainer.test.js`
- Modify: `test/smoke.test.js`
- Modify: `src/benefits-maintainer.js`
- Modify: `src/index.js`
- Modify: `docs/modules/M05-权益额度维护/_M05-权益额度维护.md`
- Modify: `docs/modules/M05-权益额度维护/额度查询.md`
- Modify: `docs/modules/M05-权益额度维护/活动Pro领取.md`
- Modify: `docs/modules/M05-权益额度维护/每日签到.md`
- Modify: `docs/modules/M05-权益额度维护/重置券使用.md`
- Modify: `docs/04-开发追踪.md`
- Modify: `docs/08-测试用例.md`
- Modify: `docs/09-实现接口参考.md`
- Modify: `README.md`

**Step 1: Write tests**

Add tests for:

- `maintainAccount(account)` runs refresh quota, claim Pro, daily check-in, and reset coupon in a deterministic order.
- It returns `{ account, changed, actions }`.
- It continues after a failed action so one maintenance failure does not block other account upkeep.
- `src/index.js` exports `BenefitsMaintainer`, `BenefitsMaintainerError`, and `normalizeQuotaState`.

**Step 2: Implement and export**

Add exports from `src/index.js`. Keep methods pure and offline-testable.

**Step 3: Document**

Document that this is a foundation layer: real Tabbit quota/check-in/pro/reset endpoints are still to be restored, and the maintainer depends on injected protocol operations.

**Step 4: Run full verification**

Run:

- `npm test` in `tabbit-protocol-pool`.
- `npm test` in repository root.
- Markdown local-link scan.
- Markdown sensitive placeholder scan.
