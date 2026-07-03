import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AccountStoreError, JsonAccountStore, StoredAccountPool, resolveAccountStorePath } from "../src/account-store.js";

async function tempStorePath() {
  const dir = await mkdtemp(join(tmpdir(), "tabbit-account-store-"));
  return { dir, filePath: join(dir, "accounts.json") };
}

test("resolveAccountStorePath uses explicit filePath or stateDir/accounts.json", () => {
  assert.equal(resolveAccountStorePath({ filePath: "E:/tmp/custom-accounts.json" }), "E:/tmp/custom-accounts.json");
  assert.equal(resolveAccountStorePath({ stateDir: "E:/tmp/tabbit-state" }).replace(/\\/g, "/"), "E:/tmp/tabbit-state/accounts.json");
});

test("loadAccounts returns an empty list when the store file is missing", async () => {
  const { filePath } = await tempStorePath();
  const store = new JsonAccountStore({ filePath });

  assert.deepEqual(await store.loadAccounts(), []);
});

test("saveAccounts writes a versioned document and loadAccounts returns normalized accounts", async () => {
  const { filePath } = await tempStorePath();
  const store = new JsonAccountStore({ filePath, now: () => "2026-07-02T00:00:00.000Z" });

  const saved = await store.saveAccounts([{ id: "acct_a", email: "aa@example.com", quotaState: [{ remaining: 3 }] }]);
  const raw = JSON.parse(await readFile(filePath, "utf8"));

  assert.equal(raw.version, 1);
  assert.equal(raw.updatedAt, "2026-07-02T00:00:00.000Z");
  assert.deepEqual(saved, [{
    id: "acct_a",
    email: "aa@example.com",
    status: "active",
    accessTier: "unknown",
    quotaState: [{ remaining: 3 }],
    resetCouponCount: 0,
    failureStreak: 0,
    audit: [],
  }]);
  assert.deepEqual(await store.loadAccounts(), saved);
});

test("saveAccounts strips direct secret fields while preserving storage references", async () => {
  const { filePath } = await tempStorePath();
  const store = new JsonAccountStore({ filePath });

  await store.saveAccounts([{
    id: "acct_secret",
    cookie: "placeholder-cookie",
    cookieHeader: "placeholder-cookie",
    token: "placeholder-token",
    password: "placeholder-password",
    cookieJarRef: "secrets/acct_secret.cookie",
  }]);

  const [account] = await store.loadAccounts();
  assert.equal(account.cookie, undefined);
  assert.equal(account.cookieHeader, undefined);
  assert.equal(account.token, undefined);
  assert.equal(account.password, undefined);
  assert.equal(account.cookieJarRef, "secrets/acct_secret.cookie");
});

test("updateAccounts loads current accounts, applies a mutator, and saves normalized results", async () => {
  const { filePath } = await tempStorePath();
  const store = new JsonAccountStore({ filePath, now: () => "2026-07-02T01:00:00.000Z" });
  await store.saveAccounts([{ id: "acct_a", status: "active" }]);

  const updated = await store.updateAccounts((accounts) => accounts.map((account) => ({
    ...account,
    status: account.id === "acct_a" ? "cooldown" : account.status,
    cooldownUntil: "2026-07-02T01:01:00.000Z",
  })));

  assert.equal(updated[0].status, "cooldown");
  assert.equal(updated[0].cooldownUntil, "2026-07-02T01:01:00.000Z");
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(raw.updatedAt, "2026-07-02T01:00:00.000Z");
  assert.equal(raw.accounts[0].status, "cooldown");
});

test("loadAccounts throws AccountStoreError for malformed JSON", async () => {
  const { filePath } = await tempStorePath();
  await writeFile(filePath, "{bad json", "utf8");
  const store = new JsonAccountStore({ filePath });

  await assert.rejects(
    () => store.loadAccounts(),
    (error) => {
      assert.equal(error instanceof AccountStoreError, true);
      assert.equal(error.code, "INVALID_ACCOUNT_STORE_JSON");
      return true;
    },
  );
});

test("loadAccounts throws AccountStoreError for non-array account payloads", async () => {
  const { filePath } = await tempStorePath();
  await writeFile(filePath, JSON.stringify({ version: 1, accounts: { acct_a: {} } }), "utf8");
  const store = new JsonAccountStore({ filePath });

  await assert.rejects(
    () => store.loadAccounts(),
    (error) => {
      assert.equal(error instanceof AccountStoreError, true);
      assert.equal(error.code, "INVALID_ACCOUNT_STORE_SHAPE");
      return true;
    },
  );
});

test("StoredAccountPool loads accounts from store and persists recordSuccess changes", async () => {
  const { filePath } = await tempStorePath();
  const store = new JsonAccountStore({ filePath, now: () => "2026-07-02T02:00:00.000Z" });
  await store.saveAccounts([{ id: "acct_a", status: "cooldown", failureStreak: 2, cooldownUntil: "2026-07-02T03:00:00.000Z" }]);

  const pool = await StoredAccountPool.load({ store, now: () => Date.parse("2026-07-02T02:00:00.000Z") });
  await pool.recordSuccess("acct_a", { requestId: "req_success" });

  const [account] = await store.loadAccounts();
  assert.equal(account.status, "active");
  assert.equal(account.failureStreak, 0);
  assert.equal(account.cooldownUntil, null);
  assert.equal(account.audit.at(-1).requestId, "req_success");
});

test("StoredAccountPool persists recordFailure changes", async () => {
  const { filePath } = await tempStorePath();
  const store = new JsonAccountStore({ filePath });
  await store.saveAccounts([{ id: "acct_a", status: "active" }]);

  const pool = await StoredAccountPool.load({ store, now: () => Date.parse("2026-07-02T02:00:00.000Z") });
  await pool.recordFailure("acct_a", { category: "quota_exhausted", message: "quota", retryable: true }, { requestId: "req_fail" });

  const [account] = await store.loadAccounts();
  assert.equal(account.status, "quota_exhausted");
  assert.equal(account.failureStreak, 1);
  assert.equal(account.lastError.category, "quota_exhausted");
  assert.equal(account.audit.at(-1).requestId, "req_fail");
});
