import test from "node:test";
import assert from "node:assert/strict";

import { BenefitsMaintainer, BenefitsMaintainerError, normalizeQuotaState } from "../src/benefits-maintainer.js";

const fixedNow = () => new Date("2026-07-02T10:00:00.000Z");

function account(overrides = {}) {
  return {
    id: "acct_a",
    status: "active",
    accessTier: "free",
    quotaState: [{ model: "tabbit/priority", remaining: 2, limit: 10, unit: "requests", resetAt: null, exhausted: false, source: "old" }],
    resetCouponCount: 0,
    audit: [],
    ...overrides,
  };
}

test("normalizeQuotaState fills stable quota defaults", () => {
  assert.deepEqual(normalizeQuotaState({ model: "tabbit/priority", remaining: "3", limit: "10" }, { source: "quota-api" }), {
    model: "tabbit/priority",
    remaining: 3,
    limit: 10,
    unit: "unknown",
    resetAt: null,
    exhausted: false,
    source: "quota-api",
  });

  assert.deepEqual(normalizeQuotaState({ remaining: 0, exhausted: true }), {
    model: "unknown",
    remaining: 0,
    limit: null,
    unit: "unknown",
    resetAt: null,
    exhausted: true,
    source: "unknown",
  });
});

test("refreshQuota updates quota metadata and marks exhausted accounts", async () => {
  const calls = [];
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    protocolClient: {
      async refreshQuota(inputAccount) {
        calls.push(inputAccount.id);
        return {
          quotaState: [{ model: "tabbit/priority", remaining: 0, limit: 10, unit: "requests", exhausted: true, source: "remote" }],
          resetCouponCount: 2,
          accessTier: "pro",
        };
      },
    },
  });

  const result = await maintainer.refreshQuota(account());

  assert.deepEqual(calls, ["acct_a"]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.action, { name: "refreshQuota", status: "success", changed: true });
  assert.equal(result.account.status, "quota_exhausted");
  assert.equal(result.account.accessTier, "pro");
  assert.equal(result.account.resetCouponCount, 2);
  assert.equal(result.account.lastMaintainedAt, "2026-07-02T10:00:00.000Z");
  assert.equal(result.account.quotaState[0].exhausted, true);
  assert.equal(result.account.quotaState[0].source, "remote");
});

test("refreshQuota restores quota_exhausted account when quota is available", async () => {
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    protocolClient: {
      async refreshQuota() {
        return { quotaState: [{ model: "tabbit/priority", remaining: 5, limit: 10, unit: "requests", source: "remote" }] };
      },
    },
  });

  const result = await maintainer.refreshQuota(account({ status: "quota_exhausted" }));

  assert.equal(result.account.status, "active");
  assert.equal(result.action.status, "success");
});

test("refreshQuota failure preserves previous quota metadata", async () => {
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    protocolClient: {
      async refreshQuota() {
        const error = new Error("remote quota failed with cookie=secret");
        error.code = "REMOTE_DOWN";
        throw error;
      },
    },
  });

  const original = account();
  const result = await maintainer.refreshQuota(original);

  assert.equal(result.changed, false);
  assert.equal(result.action.status, "failed");
  assert.equal(result.action.error.code, "REMOTE_DOWN");
  assert.match(result.action.error.message, /remote quota failed/);
  assert.doesNotMatch(result.action.error.message, /secret/);
  assert.deepEqual(result.account.quotaState, original.quotaState);
});

test("dailyCheckin skips same UTC day and updates lastCheckinAt on success", async () => {
  const calls = [];
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    protocolClient: {
      async dailyCheckin(inputAccount) {
        calls.push(inputAccount.id);
        return { ok: true };
      },
    },
  });

  const skipped = await maintainer.dailyCheckin(account({ lastCheckinAt: "2026-07-02T00:01:00.000Z" }));
  assert.equal(skipped.action.status, "skipped");
  assert.equal(skipped.changed, false);

  const checked = await maintainer.dailyCheckin(account({ lastCheckinAt: "2026-07-01T23:59:00.000Z" }));
  assert.deepEqual(calls, ["acct_a"]);
  assert.equal(checked.action.status, "success");
  assert.equal(checked.account.lastCheckinAt, "2026-07-02T10:00:00.000Z");
});

test("claimProIfAvailable skips existing paid tiers and records successful claims", async () => {
  const calls = [];
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    protocolClient: {
      async claimProIfAvailable(inputAccount) {
        calls.push(inputAccount.id);
        return { accessTier: "pro", proClaimed: true };
      },
    },
  });

  const skipped = await maintainer.claimProIfAvailable(account({ accessTier: "premium" }));
  assert.equal(skipped.action.status, "skipped");

  const claimed = await maintainer.claimProIfAvailable(account({ accessTier: "free", proClaimed: false }));
  assert.deepEqual(calls, ["acct_a"]);
  assert.equal(claimed.action.status, "success");
  assert.equal(claimed.account.accessTier, "pro");
  assert.equal(claimed.account.proClaimed, true);
});

test("dailyCheckin marks account login_expired when protocol reports login_required", async () => {
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    protocolClient: {
      async dailyCheckin() {
        const error = new Error("session expired cookie=secret-session");
        error.category = "login_required";
        error.code = "LOGIN_REQUIRED";
        throw error;
      },
    },
  });

  const result = await maintainer.dailyCheckin(account({ status: "active" }));

  assert.equal(result.changed, true);
  assert.equal(result.account.status, "login_expired");
  assert.equal(result.account.lastError.category, "login_required");
  assert.equal(result.account.lastMaintainedAt, "2026-07-02T10:00:00.000Z");
  assert.equal(result.action.status, "failed");
  assert.equal(result.action.changed, true);
  assert.equal(result.action.error.code, "LOGIN_REQUIRED");
  assert.doesNotMatch(result.action.error.message, /secret-session/);
});

test("useResetCoupon skips ineligible accounts and activates account on success", async () => {
  const calls = [];
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    protocolClient: {
      async useResetCoupon(inputAccount) {
        calls.push(inputAccount.id);
        return { quotaState: [{ model: "tabbit/priority", remaining: 10, limit: 10, unit: "requests", source: "reset" }] };
      },
    },
  });

  const skipped = await maintainer.useResetCoupon(account({ status: "active", resetCouponCount: 1 }));
  assert.equal(skipped.action.status, "skipped");

  const used = await maintainer.useResetCoupon(account({ status: "quota_exhausted", resetCouponCount: 1 }));
  assert.deepEqual(calls, ["acct_a"]);
  assert.equal(used.action.status, "success");
  assert.equal(used.account.status, "active");
  assert.equal(used.account.resetCouponCount, 0);
  assert.equal(used.account.quotaState[0].source, "reset");
});

test("useResetCoupon moves account to cooldown on retryable maintenance failures", async () => {
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    protocolClient: {
      async useResetCoupon() {
        const error = new Error("rate limited with token=secret-token");
        error.category = "rate_limited";
        error.code = "RATE_LIMITED";
        error.retryable = true;
        error.cooldownMs = 120000;
        throw error;
      },
    },
  });

  const result = await maintainer.useResetCoupon(account({ status: "quota_exhausted", resetCouponCount: 1 }));

  assert.equal(result.changed, true);
  assert.equal(result.account.status, "cooldown");
  assert.equal(result.account.cooldownUntil, "2026-07-02T10:02:00.000Z");
  assert.equal(result.account.resetCouponCount, 1);
  assert.equal(result.account.lastError.category, "rate_limited");
  assert.equal(result.account.lastError.retryable, true);
  assert.equal(result.action.status, "failed");
  assert.equal(result.action.changed, true);
  assert.doesNotMatch(result.action.error.message, /secret-token/);
});

test("maintainAccount runs actions in order and continues after failures", async () => {
  const calls = [];
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    protocolClient: {
      async refreshQuota() {
        calls.push("refreshQuota");
        return { quotaState: [{ model: "tabbit/priority", remaining: 0, limit: 10, exhausted: true, source: "remote" }], resetCouponCount: 1 };
      },
      async claimProIfAvailable() {
        calls.push("claimProIfAvailable");
        throw new Error("claim failed");
      },
      async dailyCheckin() {
        calls.push("dailyCheckin");
        return { ok: true };
      },
      async useResetCoupon() {
        calls.push("useResetCoupon");
        return { quotaState: [{ model: "tabbit/priority", remaining: 8, limit: 10, source: "reset" }] };
      },
    },
  });

  const result = await maintainer.maintainAccount(account({ proClaimed: false }));

  assert.deepEqual(calls, ["refreshQuota", "claimProIfAvailable", "dailyCheckin", "useResetCoupon"]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.actions.map((action) => [action.name, action.status]), [
    ["refreshQuota", "success"],
    ["claimProIfAvailable", "failed"],
    ["dailyCheckin", "success"],
    ["useResetCoupon", "success"],
  ]);
  assert.equal(result.account.status, "active");
  assert.equal(result.account.resetCouponCount, 0);
});

test("maintainAllAccounts loads accounts, persists changed accounts, and returns per-account results", async () => {
  const calls = [];
  const saves = [];
  const accounts = [
    account({ id: "acct_a", lastCheckinAt: "2026-07-01T00:00:00.000Z" }),
    account({ id: "acct_b", lastCheckinAt: "2026-07-01T01:00:00.000Z" }),
  ];
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    accountStore: {
      async loadAccounts() {
        return accounts;
      },
      async saveAccounts(nextAccounts) {
        saves.push(nextAccounts);
        return nextAccounts;
      },
    },
    protocolClient: {
      async dailyCheckin(inputAccount) {
        calls.push(inputAccount.id);
        return { ok: true };
      },
    },
  });

  const result = await maintainer.maintainAllAccounts();

  assert.deepEqual(calls, ["acct_a", "acct_b"]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.results.map((item) => [item.accountId, item.changed]), [
    ["acct_a", true],
    ["acct_b", true],
  ]);
  assert.deepEqual(result.accounts.map((item) => item.id), ["acct_a", "acct_b"]);
  assert.equal(result.accounts[0].lastCheckinAt, "2026-07-02T10:00:00.000Z");
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].map((item) => item.id), ["acct_a", "acct_b"]);
});

test("maintainAllAccounts skips persistence when no account changes", async () => {
  const saves = [];
  const maintainer = new BenefitsMaintainer({
    now: fixedNow,
    accountStore: {
      async loadAccounts() {
        return [account({ id: "acct_a" })];
      },
      async saveAccounts(nextAccounts) {
        saves.push(nextAccounts);
        return nextAccounts;
      },
    },
    protocolClient: {},
  });

  const result = await maintainer.maintainAllAccounts();

  assert.equal(result.changed, false);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(result.results.map((item) => [item.accountId, item.changed]), [["acct_a", false]]);
  assert.equal(saves.length, 0);
});

test("BenefitsMaintainer requires a protocolClient object", () => {
  assert.throws(() => new BenefitsMaintainer(), BenefitsMaintainerError);
});
