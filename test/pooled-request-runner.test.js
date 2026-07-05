import test from "node:test";
import assert from "node:assert/strict";

import { AccountPool } from "../src/account-pool.js";
import { PooledRequestRunner } from "../src/pooled-request-runner.js";

const NOW = Date.parse("2026-07-02T00:00:00.000Z");

test("run picks an account, sends message, records success, and returns routing metadata", async () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [{ id: "acct_a", status: "active", cookie: "placeholder-cookie-value", failureStreak: 2 }],
  });
  const calls = [];
  const runner = new PooledRequestRunner({
    accountPool: pool,
    protocolClientFactory: (account) => ({
      async sendMessage(input) {
        calls.push({ account, input });
        return { ok: true, contentBlocks: [{ type: "text", text: "hello" }], selectedModel: input.model };
      },
    }),
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.accountId, "acct_a");
  assert.equal(result.fallbackHappened, false);
  assert.deepEqual(result.attemptedAccounts, ["acct_a"]);
  assert.deepEqual(result.contentBlocks, [{ type: "text", text: "hello" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.account.id, "acct_a");
  assert.deepEqual(calls[0].input.messages, [{ role: "user", content: "hi" }]);
  assert.equal(pool.getAccount("acct_a").failureStreak, 0);
  assert.equal(pool.getAccount("acct_a").lastSuccessAt, "2026-07-02T00:00:00.000Z");
});

test("run passes official tool options through to the protocol client", async () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [{ id: "acct_a", status: "active" }],
  });
  const calls = [];
  const tools = [{ type: "function", function: { name: "edit_file", parameters: { type: "object" } } }];
  const runner = new PooledRequestRunner({
    accountPool: pool,
    protocolClientFactory: () => ({
      async sendMessage(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    }),
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "change code" }],
    tools,
    toolChoice: "auto",
    parallelToolCalls: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].tools, tools);
  assert.equal(calls[0].toolChoice, "auto");
  assert.equal(calls[0].parallelToolCalls, false);
});

test("run records retryable failure and falls back to the next account", async () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [
      { id: "acct_a", status: "active" },
      { id: "acct_b", status: "active" },
    ],
  });
  const calls = [];
  const runner = new PooledRequestRunner({
    accountPool: pool,
    retryLimit: 1,
    protocolClientFactory: (account) => ({
      async sendMessage(input) {
        calls.push({ accountId: account.id, input });
        if (account.id === "acct_a") {
          return {
            ok: false,
            error: { category: "quota_exhausted", message: "quota", retryable: true },
          };
        }
        return { ok: true, contentBlocks: [{ type: "text", text: "fallback ok" }], selectedModel: input.model };
      },
    }),
  });

  const result = await runner.run({ model: "tabbit/priority", messages: [{ role: "user", content: "hi" }], requestId: "req_fallback" });

  assert.equal(result.ok, true);
  assert.equal(result.accountId, "acct_b");
  assert.equal(result.fallbackHappened, true);
  assert.deepEqual(result.attemptedAccounts, ["acct_a", "acct_b"]);
  assert.equal(pool.getAccount("acct_a").status, "quota_exhausted");
  assert.equal(pool.getAccount("acct_b").lastSuccessAt, "2026-07-02T00:00:00.000Z");
  assert.deepEqual(calls.map((call) => call.accountId), ["acct_a", "acct_b"]);
});

test("run uses premium-only catalog metadata to route paid models to Pro accounts", async () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [
      { id: "acct_free", status: "active", accessTier: "free" },
      { id: "acct_pro", status: "active", accessTier: "pro" },
    ],
  });
  const calls = [];
  const runner = new PooledRequestRunner({
    accountPool: pool,
    modelCatalogProvider: {
      async listModels() {
        return [
          { id: "tabbit/priority", selectedModel: null, requires_premium: false },
          { id: "tabbit/GPT-5.5", selectedModel: "GPT-5.5", model_access_type: "premium_only" },
        ];
      },
    },
    protocolClientFactory: (account) => ({
      async sendMessage(input) {
        calls.push({ accountId: account.id, input });
        return { ok: true, contentBlocks: [{ type: "text", text: "pro ok" }], selectedModel: input.model };
      },
    }),
  });

  const result = await runner.run({ model: "tabbit/GPT-5.5", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.ok, true);
  assert.equal(result.accountId, "acct_pro");
  assert.deepEqual(calls.map((call) => call.accountId), ["acct_pro"]);
});

test("run honors explicit catalog metadata before Opus name fallback", async () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [
      { id: "acct_free", status: "active", accessTier: "free" },
      { id: "acct_pro", status: "active", accessTier: "pro" },
    ],
  });
  const calls = [];
  const runner = new PooledRequestRunner({
    accountPool: pool,
    modelCatalogProvider: {
      async listModels() {
        return [
          { id: "tabbit/Claude-Opus-4.8", selectedModel: "Claude-Opus-4.8", model_access_type: "free_metered" },
        ];
      },
    },
    protocolClientFactory: (account) => ({
      async sendMessage(input) {
        calls.push({ accountId: account.id, input });
        return { ok: true, contentBlocks: [{ type: "text", text: "catalog ok" }], selectedModel: input.model };
      },
    }),
  });

  const result = await runner.run({ model: "Claude-Opus-4.8", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.ok, true);
  assert.equal(result.accountId, "acct_free");
  assert.deepEqual(calls.map((call) => call.accountId), ["acct_free"]);
});

test("run treats available Claude Opus model names as Pro-tier when catalog metadata is unavailable", async () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [
      { id: "acct_free", status: "active", accessTier: "free" },
      { id: "acct_pro", status: "active", accessTier: "pro" },
    ],
  });
  const calls = [];
  const runner = new PooledRequestRunner({
    accountPool: pool,
    protocolClientFactory: (account) => ({
      async sendMessage(input) {
        calls.push({ accountId: account.id, input });
        return { ok: true, contentBlocks: [{ type: "text", text: "opus ok" }], selectedModel: input.model };
      },
    }),
  });

  const result = await runner.run({ model: "Claude-Opus-4.8", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.ok, true);
  assert.equal(result.accountId, "acct_pro");
  assert.deepEqual(calls.map((call) => call.accountId), ["acct_pro"]);
});

test("run rejects Claude Opus locally when no Pro account is available", async () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [
      { id: "acct_free", status: "active", accessTier: "free" },
    ],
  });
  let dispatched = false;
  const runner = new PooledRequestRunner({
    accountPool: pool,
    protocolClientFactory: () => ({
      async sendMessage() {
        dispatched = true;
        return { ok: true, contentBlocks: [{ type: "text", text: "should not send" }] };
      },
    }),
  });

  const result = await runner.run({ model: "Claude-Opus-4.8", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "no_available_account");
  assert.equal(result.error.code, "NO_AVAILABLE_ACCOUNT");
  assert.deepEqual(result.attemptedAccounts, []);
  assert.equal(dispatched, false);
});

test("run rejects unavailable Claude Opus 4.7 before selecting an account", async () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [
      { id: "acct_pro", status: "active", accessTier: "pro" },
    ],
  });
  let dispatched = false;
  const runner = new PooledRequestRunner({
    accountPool: pool,
    protocolClientFactory: () => ({
      async sendMessage() {
        dispatched = true;
        return { ok: true, contentBlocks: [{ type: "text", text: "should not send" }] };
      },
    }),
  });

  const result = await runner.run({ model: "Claude-Opus-4.7", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "invalid_request");
  assert.equal(result.error.code, "UNSUPPORTED_MODEL");
  assert.deepEqual(result.attemptedAccounts, []);
  assert.equal(dispatched, false);
});

test("run stops on non-retryable protocol_changed and records only one attempt", async () => {
  const pool = new AccountPool({
    now: () => NOW,
    accounts: [{ id: "acct_a", status: "active" }, { id: "acct_b", status: "active" }],
  });
  const runner = new PooledRequestRunner({
    accountPool: pool,
    retryLimit: 1,
    protocolClientFactory: () => ({
      async sendMessage() {
        return { ok: false, error: { category: "protocol_changed", message: "bad shape", retryable: true } };
      },
    }),
  });

  const result = await runner.run({ model: "tabbit/priority", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "protocol_changed");
  assert.deepEqual(result.attemptedAccounts, ["acct_a"]);
  assert.equal(result.fallbackHappened, false);
  assert.equal(pool.getAccount("acct_a").status, "suspect");
  assert.equal(pool.getAccount("acct_b").status, "active");
});

test("run returns stable no_available_account result", async () => {
  const pool = new AccountPool({ now: () => NOW, accounts: [{ id: "acct_a", status: "quota_exhausted" }] });
  const runner = new PooledRequestRunner({
    accountPool: pool,
    protocolClientFactory: () => { throw new Error("should not create client"); },
  });

  const result = await runner.run({ model: "tabbit/priority", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "no_available_account");
  assert.equal(result.error.code, "NO_AVAILABLE_ACCOUNT");
  assert.deepEqual(result.attemptedAccounts, []);
  assert.equal(result.fallbackHappened, false);
});

test("run reports invalid protocol client without poisoning account state", async () => {
  const pool = new AccountPool({ now: () => NOW, accounts: [{ id: "acct_a", status: "active" }] });
  const runner = new PooledRequestRunner({
    accountPool: pool,
    protocolClientFactory: () => ({}),
  });

  const result = await runner.run({ model: "tabbit/priority", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "invalid_request");
  assert.equal(result.error.code, "MISSING_SEND_MESSAGE");
  assert.deepEqual(result.attemptedAccounts, ["acct_a"]);
  assert.equal(pool.getAccount("acct_a").status, "active");
  assert.equal(pool.getAccount("acct_a").failureStreak, 0);
});

test("constructor rejects invalid retry limits before routing requests", () => {
  const pool = new AccountPool({ now: () => NOW, accounts: [{ id: "acct_a", status: "active" }] });
  const protocolClientFactory = () => ({
    async sendMessage() {
      return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
    },
  });

  for (const retryLimit of [-1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, "1"]) {
    assert.throws(
      () => new PooledRequestRunner({ accountPool: pool, protocolClientFactory, retryLimit }),
      /Invalid retryLimit/,
    );
  }
});

test("run waits for asynchronous success state persistence before resolving", async () => {
  let persisted = false;
  const accountPool = {
    pickAccount() { return { account: { id: "acct_async" } }; },
    async recordSuccess() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      persisted = true;
    },
    recordFailure() { throw new Error("not used"); },
    shouldFallback() { throw new Error("not used"); },
  };
  const runner = new PooledRequestRunner({
    accountPool,
    protocolClientFactory: () => ({
      async sendMessage() {
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    }),
  });

  const result = await runner.run({ model: "tabbit/priority", messages: [{ role: "user", content: "hi" }] });

  assert.equal(result.ok, true);
  assert.equal(persisted, true);
});
