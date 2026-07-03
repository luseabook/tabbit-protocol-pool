import test from "node:test";
import assert from "node:assert/strict";

import {
  AccountPool,
  AccountPoolError,
  isAccountSelectable,
  normalizeAccount,
} from "../src/account-pool.js";

const NOW = Date.parse("2026-07-02T00:00:00.000Z");

test("normalizeAccount fills safe defaults", () => {
  assert.deepEqual(normalizeAccount({ id: "acct_1" }), {
    id: "acct_1",
    status: "active",
    accessTier: "unknown",
    quotaState: [],
    resetCouponCount: 0,
    failureStreak: 0,
    audit: [],
  });
});

test("isAccountSelectable explains status, cooldown, excluded, quota, and tier filters", () => {
  assert.deepEqual(isAccountSelectable(normalizeAccount({ id: "a" }), { now: NOW }), { selectable: true, reason: "selectable" });
  assert.equal(isAccountSelectable(normalizeAccount({ id: "a", status: "disabled" }), { now: NOW }).reason, "status_disabled");
  assert.equal(isAccountSelectable(normalizeAccount({ id: "a", status: "cooldown", cooldownUntil: "2026-07-02T00:01:00.000Z" }), { now: NOW }).reason, "cooldown_until_2026-07-02T00:01:00.000Z");
  assert.equal(isAccountSelectable(normalizeAccount({ id: "a", status: "quota_exhausted" }), { now: NOW }).reason, "quota_exhausted");
  assert.equal(isAccountSelectable(normalizeAccount({ id: "a", accessTier: "free" }), { now: NOW, requiresPremium: true }).reason, "requires_premium");
  assert.equal(isAccountSelectable(normalizeAccount({ id: "a" }), { now: NOW, excludeAccountIds: ["a"] }).reason, "excluded_by_request");
});

test("pickAccount round-robins active accounts and respects exclusions", () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [
      { id: "acct_a", status: "active", accessTier: "pro" },
      { id: "acct_b", status: "active", accessTier: "pro" },
    ],
  });

  assert.equal(pool.pickAccount({ model: "tabbit/priority" }).account.id, "acct_a");
  assert.equal(pool.pickAccount({ model: "tabbit/priority" }).account.id, "acct_b");
  assert.equal(pool.pickAccount({ model: "tabbit/priority", excludeAccountIds: ["acct_a"] }).account.id, "acct_b");
});

test("pickAccount filters unavailable states and premium requirements", () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [
      { id: "disabled", status: "disabled" },
      { id: "provisioning", status: "provisioning" },
      { id: "expired", status: "login_expired" },
      { id: "quota", status: "quota_exhausted" },
      { id: "cooldown", status: "cooldown", cooldownUntil: "2026-07-02T00:10:00.000Z" },
      { id: "free", status: "active", accessTier: "free" },
      { id: "pro", status: "active", accessTier: "pro" },
    ],
  });

  const result = pool.pickAccount({ model: "tabbit/priority", requiresPremium: true });
  assert.equal(result.account.id, "pro");
  assert.equal(result.candidates.find((item) => item.accountId === "disabled").excludedReason, "status_disabled");
  assert.equal(result.candidates.find((item) => item.accountId === "free").excludedReason, "requires_premium");
});

test("pickAccount throws structured error when no accounts are available", () => {
  const pool = new AccountPool({ now: () => NOW, accounts: [{ id: "acct_a", status: "quota_exhausted" }] });

  assert.throws(
    () => pool.pickAccount({ model: "tabbit/priority" }),
    (error) => {
      assert.equal(error instanceof AccountPoolError, true);
      assert.equal(error.code, "NO_AVAILABLE_ACCOUNT");
      assert.equal(error.category, "no_available_account");
      assert.equal(error.candidates[0].excludedReason, "quota_exhausted");
      return true;
    },
  );
});

test("recordSuccess clears failure state and appends audit event", () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [{ id: "acct_a", status: "cooldown", failureStreak: 3, lastError: { category: "network_error" } }],
  });

  const updated = pool.recordSuccess("acct_a", { requestId: "req_1" });

  assert.equal(updated.status, "active");
  assert.equal(updated.failureStreak, 0);
  assert.equal(updated.lastError, null);
  assert.equal(updated.lastSuccessAt, "2026-07-02T00:00:00.000Z");
  assert.deepEqual(updated.audit.at(-1), {
    type: "success",
    requestId: "req_1",
    observedAt: "2026-07-02T00:00:00.000Z",
    fromStatus: "cooldown",
    toStatus: "active",
    reason: "request_succeeded",
  });
  assert.equal(pool.getAccount("acct_a").status, "active");
});

test("recordFailure maps protocol categories to account states", () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [
      { id: "login", status: "active" },
      { id: "quota", status: "active" },
      { id: "rate", status: "active" },
      { id: "protocol", status: "active" },
    ],
  });

  assert.equal(pool.recordFailure("login", { category: "login_required", message: "login" }, { requestId: "r1" }).status, "login_expired");
  assert.equal(pool.recordFailure("quota", { category: "quota_exhausted", message: "quota" }, { requestId: "r2" }).status, "quota_exhausted");
  const rate = pool.recordFailure("rate", { category: "rate_limited", message: "slow", cooldownMs: 3000, retryable: true }, { requestId: "r3" });
  assert.equal(rate.status, "cooldown");
  assert.equal(rate.cooldownUntil, "2026-07-02T00:00:03.000Z");
  assert.equal(rate.failureStreak, 1);
  assert.equal(pool.recordFailure("protocol", { category: "protocol_changed", message: "shape" }, { requestId: "r4" }).status, "suspect");
});

test("recordFailure uses default cooldown and preserves audit trail", () => {
  const pool = new AccountPool({ now: () => NOW, accounts: [{ id: "acct_a", status: "active", failureStreak: 1 }] });

  const updated = pool.recordFailure("acct_a", { category: "upstream_error", message: "bad gateway", retryable: true }, { requestId: "req_2" });

  assert.equal(updated.status, "cooldown");
  assert.equal(updated.failureStreak, 2);
  assert.equal(updated.cooldownUntil, "2026-07-02T00:00:10.000Z");
  assert.deepEqual(updated.lastError, { category: "upstream_error", message: "bad gateway", retryable: true, cooldownMs: 10000 });
  assert.deepEqual(updated.audit.at(-1), {
    type: "failure",
    requestId: "req_2",
    observedAt: "2026-07-02T00:00:00.000Z",
    fromStatus: "active",
    toStatus: "cooldown",
    reason: "upstream_error",
  });
});

test("recording an unknown account throws AccountPoolError", () => {
  const pool = new AccountPool({ now: () => NOW, accounts: [] });
  assert.throws(() => pool.recordSuccess("missing"), /Account not found/);
  assert.throws(() => pool.recordFailure("missing", { category: "network_error" }), /Account not found/);
});

test("shouldFallback allows retryable account-local failures with remaining candidates", () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [{ id: "acct_a", status: "quota_exhausted" }, { id: "acct_b", status: "active" }],
  });

  const decision = pool.shouldFallback({
    error: { category: "quota_exhausted", retryable: true },
    attemptedAccountIds: ["acct_a"],
    model: "tabbit/priority",
    retryCount: 0,
    retryLimit: 1,
  });

  assert.equal(decision.fallback, true);
  assert.equal(decision.nextAccount.id, "acct_b");
  assert.equal(decision.reason, "retryable_quota_exhausted");
});

test("shouldFallback rejects global failures, exhausted retry budget, and no candidates", () => {
  const pool = new AccountPool({ now: () => NOW, accounts: [{ id: "acct_a", status: "active" }] });

  assert.deepEqual(pool.shouldFallback({ error: { category: "protocol_changed", retryable: true }, attemptedAccountIds: ["acct_a"], retryCount: 0, retryLimit: 1 }), {
    fallback: false,
    reason: "global_or_non_retryable_protocol_changed",
  });
  assert.deepEqual(pool.shouldFallback({ error: { category: "upstream_error", retryable: true }, attemptedAccountIds: ["acct_a"], retryCount: 1, retryLimit: 1 }), {
    fallback: false,
    reason: "retry_budget_exhausted",
  });
  assert.deepEqual(pool.shouldFallback({ error: { category: "upstream_error", retryable: true }, attemptedAccountIds: ["acct_a"], retryCount: 0, retryLimit: 1 }), {
    fallback: false,
    reason: "no_candidate_account",
  });
  assert.deepEqual(pool.shouldFallback({ error: { category: "login_required", retryable: true }, attemptedAccountIds: ["acct_a"], retryCount: 0, retryLimit: 1 }), {
    fallback: false,
    reason: "global_or_non_retryable_login_required",
  });
});
