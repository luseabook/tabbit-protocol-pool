import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProtocolPoolCliDependencies, runProtocolPoolCli } from "../src/ops-cli.js";

function memoryStore(initialAccounts = [], events = []) {
  let accounts = JSON.parse(JSON.stringify(initialAccounts));
  return {
    async loadAccounts() {
      events.push(["loadAccounts"]);
      return JSON.parse(JSON.stringify(accounts));
    },
    async saveAccounts(nextAccounts) {
      events.push(["saveAccounts", nextAccounts.map((account) => [account.id, account.status])]);
      accounts = JSON.parse(JSON.stringify(nextAccounts));
      return JSON.parse(JSON.stringify(accounts));
    },
    get accounts() {
      return JSON.parse(JSON.stringify(accounts));
    },
  };
}

function memorySecretStore(events = []) {
  const secrets = new Map();
  return {
    async readSecret(ref) {
      events.push(["readSecret", ref]);
      return secrets.has(ref) ? secrets.get(ref) : null;
    },
    async writeSecret(ref, value) {
      events.push(["writeSecret", ref, value]);
      secrets.set(ref, value);
      return ref;
    },
    getSecret(ref) {
      return secrets.get(ref);
    },
  };
}


function memoryReadinessStore(initialState = {}, events = []) {
  let state = JSON.parse(JSON.stringify(initialState));
  return {
    async readState() {
      events.push(["readReadinessState"]);
      return JSON.parse(JSON.stringify(state));
    },
    async writeState(nextState) {
      events.push(["writeReadinessState", JSON.parse(JSON.stringify(nextState))]);
      state = JSON.parse(JSON.stringify(nextState));
      return JSON.parse(JSON.stringify(state));
    },
    get state() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

function io() {
  return {
    stdout: [],
    stderr: [],
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lowerHeaders[name.toLowerCase()] ?? null },
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

function baseAccounts() {
  return [
    {
      id: "acct_a",
      email: "alpha-user@example.test",
      status: "active",
      accessTier: "pro",
      cookieJarRef: "secrets/acct_a.cookie",
      cookieHeader: "tabbit_session=secret",
      quotaState: [{ model: "tabbit/priority", remaining: 8, limit: 10, unit: "requests", exhausted: false }],
    },
    {
      id: "acct_b",
      email: "beta-user@example.test",
      status: "login_expired",
      token: "secret-token",
      lastError: { category: "login_required", code: "LOGIN", message: "beta-user@example.test session=secret" },
    },
  ];
}

test("accounts import-session --json stores session in secret store and saves active metadata", async () => {
  const stream = io();
  const events = [];
  const store = memoryStore([], events);
  const secretStore = memorySecretStore(events);
  const cookieFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-pool-cookie-")), "cookie.txt");
  await writeFile(cookieFile, "tabbit_session=secret-cookie; tabbit_user=user@example.test", "utf8");

  const result = await runProtocolPoolCli([
    "accounts", "import-session",
    "--id", "acct_logged_in",
    "--email", "user@example.test",
    "--access-tier", "pro",
    "--cookie-file", cookieFile,
    "--json",
  ], {
    accountStore: store,
    secretStore,
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(secretStore.getSecret("secrets/acct_logged_in.cookie"), "tabbit_session=secret-cookie; tabbit_user=user@example.test");
  assert.deepEqual(store.accounts.map((account) => ({ id: account.id, status: account.status, email: account.email, accessTier: account.accessTier, cookieJarRef: account.cookieJarRef })), [
    { id: "acct_logged_in", status: "active", email: "user@example.test", accessTier: "pro", cookieJarRef: "secrets/acct_logged_in.cookie" },
  ]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.changed, true);
  assert.equal(body.account.id, "acct_logged_in");
  assert.equal(body.account.email, "us***@example.test");
  assert.equal(body.account.cookieJarRef, undefined);
  assert.doesNotMatch(text, /secret-cookie|tabbit_session|user@example.test/);
  assert.equal(stream.stderr.join(""), "");
});

test("accounts import-session requires exactly one session source without leaking values", async () => {
  const stream = io();
  const result = await runProtocolPoolCli([
    "accounts", "import-session",
    "--id", "acct_bad",
    "--cookie-header", "tabbit_session=secret-cookie",
    "--session", "another-secret",
    "--json",
  ], {
    accountStore: memoryStore([]),
    secretStore: memorySecretStore(),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.match(stream.stderr.join(""), /one session source/i);
  assert.doesNotMatch(stream.stderr.join(""), /secret-cookie|another-secret|tabbit_session/);
});

test("accounts list --json prints redacted account metadata", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["accounts", "list", "--json"], {
    accountStore: memoryStore(baseAccounts()),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.accounts.length, 2);
  assert.equal(body.accounts[0].email, "al***@example.test");
  assert.equal(body.accounts[1].lastError.message, "be***@example.test session=***");
  assert.equal(JSON.stringify(body).includes("alpha-user@example.test"), false);
  assert.equal(JSON.stringify(body).includes("cookieJarRef"), false);
  assert.equal(JSON.stringify(body).includes("tabbit_session"), false);
  assert.equal(JSON.stringify(body).includes("secret-token"), false);
});

test("accounts list prints a readable redacted table", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["accounts", "list"], {
    accountStore: memoryStore(baseAccounts()),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  const output = stream.stdout.join("\n");
  assert.match(output, /acct_a/);
  assert.match(output, /active/);
  assert.match(output, /al\*\*\*@example\.test/);
  assert.doesNotMatch(output, /alpha-user@example\.test/);
  assert.doesNotMatch(output, /cookieJarRef|tabbit_session|secret-token/);
});

test("health --json prints an account summary snapshot", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["health", "--json"], {
    accountStore: memoryStore(baseAccounts()),
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    startedAt: Date.parse("2026-07-02T02:59:50.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "degraded");
  assert.equal(body.mode, "protocol-pool");
  assert.equal(body.uptimeMs, 10_000);
  assert.equal(body.accounts.total, 2);
  assert.equal(body.accounts.active, 1);
  assert.equal(body.accounts.byStatus.login_expired, 1);
  assert.equal(JSON.stringify(body).includes("alpha-user@example.test"), false);
});

test("readiness --json prints calibration readiness without touching network", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["readiness", "--json"], {
    config: {
      stateDir: path.join(tmpdir(), "tabbit-readiness-test"),
      compat: {
        toolLoopMode: "disabled",
      },
      protocol: {
        enabled: true,
        signKeyPath: "/chat/sign-key",
        sendPath: "/chat/send",
        sessionVerifyPath: "/chat/session/check",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return [
          { operation: "verifySession", status: "success", adviceCategory: "unknown" },
          { operation: "sendMessage", status: "success", adviceCategory: "success" },
          { operation: "sendMessage", status: "failed", adviceCategory: "forbidden" },
        ];
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"]]);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "partial");
  assert.equal(body.checks.protocolCalibration.status, "ready");
  assert.equal(body.checks.codexClaudeE2E.status, "blocked");
  assert.equal(body.checks.toolLoopDecision.decision, "disabled");
  assert.equal(body.checks.forbidden403.status, "ready");
  assert.equal(JSON.stringify(body).includes("alpha-user@example.test"), false);
  assert.equal(JSON.stringify(body).includes("tabbit_session"), false);
});

test("readiness --json reads fixture bodies for sanitized forbidden coverage", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["readiness", "--json"], {
    config: {
      stateDir: path.join(tmpdir(), "tabbit-readiness-fixture-bodies-test"),
      protocol: {
        enabled: true,
        signKeyPath: "/chat/sign-key",
        sendPath: "/chat/send",
        sessionVerifyPath: "/chat/session/check",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return [
          { ref: "fixtures/protocol-probes/verify.json", operation: "verifySession", status: "success" },
          { ref: "fixtures/protocol-probes/send.json", operation: "sendMessage", status: "success" },
          { ref: "fixtures/protocol-probes/403.json", operation: "sendMessage", status: "failed" },
        ];
      },
      async readFixture(ref) {
        calls.push(["readFixture", ref]);
        if (ref.includes("verify")) {
          return { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } };
        }
        if (ref.includes("403")) {
          return {
            operation: "sendMessage",
            status: "failed",
            error: { category: "protocol_changed", code: "***", message: "protocol probe failed" },
            result: { ok: false, error: { category: "forbidden", status: 403 } },
          };
        }
        return { operation: "sendMessage", status: "success", result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["ok"] } };
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    ["loadAccounts"],
    ["listFixtures"],
    ["readFixture", "fixtures/protocol-probes/verify.json"],
    ["readFixture", "fixtures/protocol-probes/send.json"],
    ["readFixture", "fixtures/protocol-probes/403.json"],
  ]);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.checks.protocolCalibration.status, "ready");
  assert.equal(body.checks.forbidden403.status, "ready");
});


test("serve --json starts the protocol-pool gateway and waits for shutdown", async () => {
  const stream = io();
  const calls = [];
  const fakeServer = {
    address() {
      return { address: "127.0.0.2", port: 50125 };
    },
  };
  const fakeGateway = {
    server: fakeServer,
    async start(options) {
      calls.push(["start", options]);
      return fakeServer;
    },
    async close() {
      calls.push(["close"]);
    },
  };

  const result = await runProtocolPoolCli(["serve", "--host", "127.0.0.2", "--port", "50125", "--json"], {
    config: {
      host: "127.0.0.1",
      port: 50124,
      apiKey: "sk-tabbit-local",
      stateDir: path.join(tmpdir(), "tabbit-serve-test"),
      retryLimit: 1,
      protocol: {},
    },
    async gatewayFactory(options) {
      calls.push(["factory", options.config.host, options.config.port]);
      return fakeGateway;
    },
    async waitForShutdown({ address }) {
      calls.push(["wait", address]);
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [
    ["factory", "127.0.0.1", 50124],
    ["start", { host: "127.0.0.2", port: 50125 }],
    ["wait", { host: "127.0.0.2", port: 50125 }],
    ["close"],
  ]);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "listening");
  assert.equal(body.openaiBaseUrl, "http://127.0.0.2:50125/v1");
  assert.equal(body.anthropicBaseUrl, "http://127.0.0.2:50125");
  assert.equal(JSON.stringify(body).includes("sk-tabbit-local"), false);
});

test("start is an alias for serve", async () => {
  const stream = io();
  const calls = [];
  const fakeServer = { address: () => ({ address: "127.0.0.1", port: 50124 }) };
  const fakeGateway = {
    server: fakeServer,
    async start(options) {
      calls.push(["start", options]);
      return fakeServer;
    },
    async close() {
      calls.push(["close"]);
    },
  };

  const result = await runProtocolPoolCli(["start", "--json"], {
    config: {
      host: "127.0.0.1",
      port: 50124,
      apiKey: "sk-tabbit-local",
      stateDir: path.join(tmpdir(), "tabbit-start-test"),
      retryLimit: 1,
      protocol: {},
    },
    gatewayFactory: async () => fakeGateway,
    waitForShutdown: async () => calls.push(["wait"]),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    ["start", { host: "127.0.0.1", port: 50124 }],
    ["wait"],
    ["close"],
  ]);
  assert.equal(JSON.parse(stream.stdout.join("")).openaiBaseUrl, "http://127.0.0.1:50124/v1");
});


test("serve rejects invalid port before creating a gateway", async () => {
  const stream = io();
  const calls = [];

  const result = await runProtocolPoolCli(["serve", "--port", "not-a-port", "--json"], {
    gatewayFactory: async () => {
      calls.push("factory");
      throw new Error("should not be called");
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(calls, []);
  assert.match(stream.stderr.join("\n"), /--port/);
});



test("smoke gateway --json checks health, models, Chat, Responses, and Anthropic routes", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli([
    "smoke",
    "gateway",
    "--base-url",
    "http://127.0.0.1:50124",
    "--api-key",
    "secret-local-key",
    "--json",
  ], {
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === "http://127.0.0.1:50124/health") return jsonResponse({ status: "ok" });
      if (url === "http://127.0.0.1:50124/v1/models") return jsonResponse({ object: "list", data: [{ id: "tabbit/priority" }] });
      if (url === "http://127.0.0.1:50124/v1/chat/completions") return jsonResponse({ id: "chatcmpl_smoke", choices: [{ message: { content: "ok" } }] });
      if (url === "http://127.0.0.1:50124/v1/responses") return jsonResponse({ id: "resp_smoke", output_text: "ok" });
      if (url === "http://127.0.0.1:50124/v1/messages") return jsonResponse({ type: "message", content: [{ type: "text", text: "ok" }] });
      return jsonResponse({ error: { message: "unexpected" } }, { status: 404 });
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls.map((call) => [call.options.method || "GET", call.url]), [
    ["GET", "http://127.0.0.1:50124/health"],
    ["GET", "http://127.0.0.1:50124/v1/models"],
    ["POST", "http://127.0.0.1:50124/v1/chat/completions"],
    ["POST", "http://127.0.0.1:50124/v1/responses"],
    ["POST", "http://127.0.0.1:50124/v1/messages"],
  ]);
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret-local-key");
  assert.equal(calls[4].options.headers["x-api-key"], "secret-local-key");
  const chatBody = JSON.parse(calls[2].options.body);
  assert.equal(chatBody.model, "tabbit/priority");
  assert.equal(chatBody.messages[0].content, "tabbit-pool smoke: reply ok");
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "ok");
  assert.deepEqual(body.steps.map((step) => [step.name, step.ok]), [
    ["health", true],
    ["models", true],
    ["chat_completions", true],
    ["responses", true],
    ["anthropic_messages", true],
  ]);
  assert.equal(JSON.stringify(body).includes("secret-local-key"), false);
});

test("smoke gateway --json reports the failed step without leaking the API key", async () => {
  const stream = io();
  const result = await runProtocolPoolCli([
    "smoke",
    "gateway",
    "--api-key",
    "secret-local-key",
    "--json",
  ], {
    fetch: async (url) => {
      if (url.endsWith("/health")) return jsonResponse({ status: "ok" });
      if (url.endsWith("/v1/models")) return jsonResponse({ error: { message: "invalid secret-local-key" } }, { status: 401 });
      return jsonResponse({ ok: true });
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "failed");
  assert.equal(body.failedStep, "models");
  assert.equal(body.steps.find((step) => step.name === "models").ok, false);
  assert.equal(JSON.stringify(body).includes("secret-local-key"), false);
});

test("readiness --json uses persisted Codex and Claude verification marks", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["readiness", "--json"], {
    config: {
      stateDir: path.join(tmpdir(), "tabbit-readiness-state-test"),
      protocol: {
        enabled: true,
        signKeyPath: "/chat/sign-key",
        sendPath: "/chat/send",
        sessionVerifyPath: "/chat/session/check",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return [
          { operation: "verifySession", status: "success", adviceCategory: "unknown" },
          { operation: "sendMessage", status: "success", adviceCategory: "success" },
          { operation: "sendMessage", status: "failed", adviceCategory: "forbidden" },
        ];
      },
    },
    readinessStateStore: memoryReadinessStore({
      codex: { verified: true, verifiedAt: "2026-07-02T04:00:00.000Z" },
      claude: { verified: true, verifiedAt: "2026-07-02T04:05:00.000Z" },
    }, calls),
    now: () => Date.parse("2026-07-02T05:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "ready");
  assert.equal(body.checks.codexClaudeE2E.status, "ready");
  assert.equal(body.checks.codexClaudeE2E.evidence.codexVerified, true);
  assert.equal(body.checks.codexClaudeE2E.evidence.claudeVerified, true);
});

test("readiness mark --json persists Codex and Claude verification marks", async () => {
  const stream = io();
  const events = [];
  const readinessStateStore = memoryReadinessStore({}, events);

  const result = await runProtocolPoolCli([
    "readiness",
    "mark",
    "--codex-verified",
    "--claude-verified",
    "--json",
  ], {
    readinessStateStore,
    now: () => Date.parse("2026-07-02T06:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(events.map((event) => event[0]), ["readReadinessState", "writeReadinessState"]);
  assert.equal(readinessStateStore.state.codex.verified, true);
  assert.equal(readinessStateStore.state.codex.verifiedAt, "2026-07-02T06:00:00.000Z");
  assert.equal(readinessStateStore.state.claude.verified, true);
  assert.equal(readinessStateStore.state.claude.verifiedAt, "2026-07-02T06:00:00.000Z");
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.readiness.codex.verified, true);
  assert.equal(body.readiness.codex.verifiedAt, "2026-07-02T06:00:00.000Z");
  assert.equal(body.readiness.claude.verified, true);
  assert.equal(body.readiness.claude.verifiedAt, "2026-07-02T06:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(body), /sk-tabbit-local|tabbit_session|token=secret/);
});

test("readiness mark requires at least one verification flag", async () => {
  const stream = io();
  const events = [];
  const result = await runProtocolPoolCli(["readiness", "mark", "--json"], {
    readinessStateStore: memoryReadinessStore({}, events),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(events, []);
  assert.match(stream.stderr.join("\n"), /verification flag/i);
});

test("unknown commands print help and exit 2", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["wat"], {
    accountStore: memoryStore([]),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.match(stream.stderr.join("\n"), /Usage:/);
});

test("maintain --json runs injected maintainer, saves changed accounts, and prints action logs", async () => {
  const events = [];
  const store = memoryStore(baseAccounts(), events);
  const stream = io();
  const result = await runProtocolPoolCli(["maintain", "--json"], {
    accountStore: store,
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    benefitsMaintainer: {
      async maintainAccount(account) {
        if (account.id === "acct_a") {
          return {
            account: { ...account, lastMaintainedAt: "2026-07-02T03:00:00.000Z" },
            changed: true,
            actions: [{ name: "refreshQuota", status: "success", changed: true }],
          };
        }
        return {
          account,
          changed: false,
          actions: [{
            name: "dailyCheckin",
            status: "failed",
            changed: false,
            error: { category: "mail_timeout", code: "MAIL_TIMEOUT", message: "code 123456 beta-user@example.test token=secret" },
          }],
        };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(events.map((event) => event[0]), ["loadAccounts", "saveAccounts"]);
  assert.equal(store.accounts[0].lastMaintainedAt, "2026-07-02T03:00:00.000Z");
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.changed, true);
  assert.equal(body.events.length, 2);
  assert.equal(body.events[0].action, "refreshQuota");
  assert.equal(body.events[1].error.message, "code *** be***@example.test token=***");
});

test("maintain --json defaults to skipped protocol operations without network access", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["maintain", "--json"], {
    accountStore: memoryStore([{ id: "acct_a", status: "active" }]),
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.changed, false);
  assert.deepEqual(body.events.map((event) => [event.action, event.status]), [
    ["refreshQuota", "skipped"],
    ["claimProIfAvailable", "skipped"],
    ["dailyCheckin", "skipped"],
    ["useResetCoupon", "skipped"],
  ]);
});

test("probe advice --json prints protocol advice", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "advice", "--category", "protocol_changed", "--json"], {
    accountStore: memoryStore([]),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.category, "protocol_changed");
  assert.match(body.recommendation, /fixture/i);
});

test("probe advice accepts sanitized 403 message context", async () => {
  const stream = io();
  const result = await runProtocolPoolCli([
    "probe",
    "advice",
    "--status",
    "403",
    "--message",
    "risk control for beta-user@example.test token=secret code 123456",
    "--json",
  ], {
    accountStore: memoryStore([]),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.category, "forbidden");
  assert.equal(body.forbidden.kind, "risk_control");
  assert.equal(body.forbidden.accountAction, "suspect");
  assert.doesNotMatch(text, /beta-user@example\.test/);
  assert.doesNotMatch(text, /123456/);
  assert.doesNotMatch(text, /token=secret/);
});


test("probe template --operation sendMessage prints a safe starter input object", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "sendMessage", "--json"], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.deepEqual(body, {
    model: "tabbit/priority",
    messages: [{ role: "user", content: "ping" }],
  });
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.equal(JSON.stringify(body).includes("cookie"), false);
});

test("probe template --operation listModels prints a refresh input object", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "listModels", "--json"], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(JSON.parse(stream.stdout.join("")), { force: true });
});

test("probe template --operation refreshQuota prints a safe starter input object", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "refreshQuota", "--json"], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.deepEqual(body, {});
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.equal(JSON.stringify(body).includes("cookie"), false);
});

test("probe template --operation uploadAttachment prints a safe starter input object", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "uploadAttachment", "--json"], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.deepEqual(body, {
    attachment: {
      filename: "probe.txt",
      mimeType: "text/plain",
      data: "base64-probe-payload",
    },
  });
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.equal(JSON.stringify(body).includes("cookie"), false);
});

test("probe template --operation getNewbieExplorationMe prints calibrated read-only input", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "getNewbieExplorationMe", "--json"], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(JSON.parse(stream.stdout.join("")), {
    viewMode: "activity_page",
    includeCompletions: true,
    includeRewards: true,
  });
});

test("probe template --operation getPlacementResources prints calibrated read-only input", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "getPlacementResources", "--json"], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(JSON.parse(stream.stdout.join("")), {
    placementCode: "home.input_below",
  });
});

test("probe template prints side-effect inputs with confirmation disabled", async () => {
  const signInStream = io();
  const signIn = await runProtocolPoolCli(["probe", "template", "--operation", "dailySignIn", "--json"], {
    stdout: (line) => signInStream.stdout.push(line),
    stderr: (line) => signInStream.stderr.push(line),
  });

  assert.equal(signIn.exitCode, 0);
  assert.deepEqual(JSON.parse(signInStream.stdout.join("")), {
    confirmSideEffect: false,
    requestNo: "desktop-pet-sign-in-probe",
    sceneCodes: ["desktop_pet"],
  });

  const drawStream = io();
  const draw = await runProtocolPoolCli(["probe", "template", "--operation", "drawLottery", "--json"], {
    stdout: (line) => drawStream.stdout.push(line),
    stderr: (line) => drawStream.stderr.push(line),
  });

  assert.equal(draw.exitCode, 0);
  assert.deepEqual(JSON.parse(drawStream.stdout.join("")), {
    confirmSideEffect: false,
    body: {},
  });
});

test("probe template rejects unsupported operations", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "deleteEverything", "--json"], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.match(stream.stderr.join("\n"), /Unsupported probe template operation/);
  assert.equal(stream.stderr.join("\n").includes("token"), false);
});

test("command errors are redacted before printing", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["accounts", "list", "--json"], {
    accountStore: {
      async loadAccounts() {
        throw new Error("cookie=secret-token for alpha-user@example.test code 123456");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  const output = stream.stderr.join("\n");
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(output, /secret-token/);
  assert.doesNotMatch(output, /alpha-user@example\.test/);
  assert.doesNotMatch(output, /123456/);
  assert.match(output, /cookie=\*\*\*/);
  assert.match(output, /al\*\*\*@example\.test/);
});


test("accounts probe --json verifies one account and prints redacted advice", async () => {
  const calls = [];
  const stream = io();
  const result = await runProtocolPoolCli(["accounts", "probe", "acct_b", "--json"], {
    accountStore: memoryStore(baseAccounts()),
    accountVerifier: {
      async verifyAccount(accountId) {
        calls.push(accountId);
        return {
          changed: true,
          account: {
            id: accountId,
            email: "beta-user@example.test",
            status: "login_expired",
            cookieJarRef: "secrets/acct_b.cookie",
            token: "secret-token",
            lastError: { category: "login_required", code: "LOGIN", message: "beta-user@example.test token=secret code 123456" },
          },
          actions: [{
            name: "verifySession",
            status: "failed",
            changed: true,
            error: { category: "login_required", code: "LOGIN", message: "beta-user@example.test token=secret code 123456" },
          }],
        };
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["acct_b"]);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.changed, true);
  assert.equal(body.account.id, "acct_b");
  assert.equal(body.account.email, "be***@example.test");
  assert.equal(body.account.status, "login_expired");
  assert.equal(body.account.cookieJarRef, undefined);
  assert.equal(body.account.token, undefined);
  assert.equal(body.events[0].action, "verifySession");
  assert.equal(body.events[0].error.message, "be***@example.test token=*** code ***");
  assert.equal(body.advice.category, "login_required");
  assert.match(body.advice.recommendation, /refresh or import/i);
  assert.equal(JSON.stringify(body).includes("beta-user@example.test"), false);
  assert.equal(JSON.stringify(body).includes("secret-token"), false);
});

test("accounts probe requires an account id", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["accounts", "probe", "--json"], {
    accountStore: memoryStore(baseAccounts()),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.match(stream.stderr.join("\n"), /account id/i);
});

test("default CLI dependencies expose a batch benefits maintainer", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-maintainer-deps-"));
  const deps = createProtocolPoolCliDependencies({
    env: { TABBIT_POOL_STATE_DIR: stateDir },
    now: () => 1700000000000,
  });

  const result = await deps.benefitsMaintainer.maintainAllAccounts();

  assert.equal(result.changed, false);
  assert.deepEqual(result.accounts, []);
  assert.deepEqual(result.results, []);
});

test("configured quota usage env wires maintain refreshQuota with hydrated local session", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-quota-maintain-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH: "/api/commerce/quota/v1/usage",
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        user_id: "user_quota_env",
        member_level: "free",
        usage_percentage: "31.37%",
        current_cycle_end: "2026.07.10",
        unused_reset_coupon_count: 1,
      });
    },
  });
  await deps.accountStore.saveAccounts([{
    id: "acct_quota_env",
    status: "quota_exhausted",
    userId: "user_quota_env",
    cookieJarRef: "secrets/acct_quota_env.cookie",
    quotaState: [{ model: "tabbit/priority", remaining: 0, limit: 10, unit: "requests", exhausted: true }],
  }]);
  await deps.secretStore.writeSecret("secrets/acct_quota_env.cookie", "tabbit_session=quota-env");

  const result = await deps.benefitsMaintainer.maintainAllAccounts();

  assert.equal(result.changed, true);
  assert.equal(result.accounts[0].status, "active");
  assert.equal(result.accounts[0].accessTier, "free");
  assert.equal(result.accounts[0].resetCouponCount, 1);
  assert.equal(result.accounts[0].quotaState[0].source, "tabbit-quota-usage");
  assert.equal(result.accounts[0].quotaState[0].unit, "usage_percentage");
  assert.equal(result.accounts[0].lastMaintainedAt, "2026-07-02T03:00:00.000Z");
  assert.deepEqual(result.results[0].actions.map((item) => [item.name, item.status]), [
    ["refreshQuota", "success"],
    ["claimProIfAvailable", "skipped"],
    ["dailyCheckin", "skipped"],
    ["useResetCoupon", "skipped"],
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/quota/v1/usage?user_id=user_quota_env");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=quota-env");
  assert.equal(JSON.stringify(result).includes("tabbit_session=quota-env"), false);
});

test("configured sign-in env wires maintain dailyCheckin with hydrated local session", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-sign-in-maintain-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_SIGN_IN_STATUS_PATH: "/api/commerce/activity/v1/sign-in/status",
      TABBIT_POOL_PROTOCOL_SIGN_IN_PATH: "/api/commerce/activity/v1/sign-in",
    },
    now: () => Date.parse("2026-07-03T08:30:00.000Z"),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST") {
        return jsonResponse({
          sign_in_date: "2026-07-03",
          results: [{
            scene_code: "desktop_pet",
            sign_in_result: "success",
            signed_days: 2,
            total_signed_days: 3,
          }],
        });
      }
      return jsonResponse({
        sign_in_date: "2026-07-03",
        results: [{
          scene_code: "desktop_pet",
          signed_today: false,
          signed_days: 1,
          total_signed_days: 2,
        }],
      });
    },
  });
  await deps.accountStore.saveAccounts([{
    id: "acct_sign_in_env",
    status: "active",
    cookieJarRef: "secrets/acct_sign_in_env.cookie",
    lastCheckinAt: "2026-07-02T08:30:00.000Z",
  }]);
  await deps.secretStore.writeSecret("secrets/acct_sign_in_env.cookie", "tabbit_session=sign-in-env");

  const result = await deps.benefitsMaintainer.maintainAllAccounts();

  assert.equal(result.changed, true);
  assert.equal(result.accounts[0].lastCheckinAt, "2026-07-03T08:30:00.000Z");
  assert.deepEqual(result.results[0].actions.map((item) => [item.name, item.status]), [
    ["refreshQuota", "skipped"],
    ["claimProIfAvailable", "skipped"],
    ["dailyCheckin", "success"],
    ["useResetCoupon", "skipped"],
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/activity/v1/sign-in/status?scene_codes=desktop_pet");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=sign-in-env");
  assert.equal(calls[1].url, "https://web.tabbit.ai/api/commerce/activity/v1/sign-in");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=sign-in-env");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  assert.equal(Object.hasOwn(calls[1].options.headers, "x-signature"), false);
  const postBody = JSON.parse(calls[1].options.body);
  assert.deepEqual(postBody.scene_codes, ["desktop_pet"]);
  assert.match(postBody.request_no, /^daily-sign-in-20260703-[0-9a-f]{12}$/);
  assert.equal(postBody.request_no.length <= 64, true);
  assert.equal(JSON.stringify(result).includes("tabbit_session=sign-in-env"), false);
});

test("configured sign-in maintain checks signedToday before posting", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-sign-in-status-maintain-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_SIGN_IN_STATUS_PATH: "/api/commerce/activity/v1/sign-in/status",
      TABBIT_POOL_PROTOCOL_SIGN_IN_PATH: "/api/commerce/activity/v1/sign-in",
    },
    now: () => Date.parse("2026-07-03T09:45:00.000Z"),
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.method, "GET");
      return jsonResponse({
        sign_in_date: "2026-07-03",
        results: [{
          scene_code: "desktop_pet",
          signed_today: true,
          signed_days: 2,
          total_signed_days: 3,
        }],
      });
    },
  });
  await deps.accountStore.saveAccounts([{
    id: "acct_sign_in_status_env",
    status: "active",
    cookieJarRef: "secrets/acct_sign_in_status_env.cookie",
    lastCheckinAt: "2026-07-02T09:45:00.000Z",
  }]);
  await deps.secretStore.writeSecret("secrets/acct_sign_in_status_env.cookie", "tabbit_session=sign-in-status-env");

  const result = await deps.benefitsMaintainer.maintainAllAccounts();

  assert.equal(result.changed, true);
  assert.equal(result.accounts[0].lastCheckinAt, "2026-07-03T09:45:00.000Z");
  assert.equal(result.results[0].actions.find((item) => item.name === "dailyCheckin")?.status, "success");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/activity/v1/sign-in/status?scene_codes=desktop_pet");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=sign-in-status-env");
  assert.equal(JSON.stringify(result).includes("tabbit_session=sign-in-status-env"), false);
});

test("default CLI dependencies expose a safe account verifier", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-probe-"));
  const deps = createProtocolPoolCliDependencies({
    env: { TABBIT_POOL_STATE_DIR: stateDir },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
  });

  assert.equal(typeof deps.accountVerifier.verifyAccount, "function");
  await deps.accountStore.saveAccounts([{ id: "acct_default", status: "active", cookieJarRef: "secrets/missing.cookie" }]);

  const result = await deps.accountVerifier.verifyAccount("acct_default");

  assert.equal(result.changed, true);
  assert.equal(result.account.status, "login_expired");
  assert.equal(result.actions[0].name, "verifySession");
  assert.equal(result.actions[0].status, "failed");
  assert.equal(result.actions[0].error.code, "SESSION_MISSING");
});

test("configured protocol env wires account verifier to ProtocolTabbitClient", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-protocol-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH: "/chat/session/check",
    },
    now: () => 1700000000000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-env");
      return jsonResponse({ data: { userId: "user_env", accessTier: "pro" } });
    },
  });
  await deps.accountStore.saveAccounts([{ id: "acct_env", status: "login_expired", cookieJarRef: "secrets/acct_env.cookie" }]);
  await deps.secretStore.writeSecret("secrets/acct_env.cookie", "tabbit_session=env");

  const result = await deps.accountVerifier.verifyAccount("acct_env");

  assert.equal(result.changed, true);
  assert.equal(result.account.status, "active");
  assert.equal(result.account.userId, "user_env");
  assert.equal(result.account.accessTier, "pro");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://web.tabbit.ai/chat/sign-key");
  assert.equal(calls[1].url, "https://web.tabbit.ai/chat/session/check");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=env");
});

test("configured protocol env wires protocol probe runner without leaking the session", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-protocol-probe-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH: "/chat/session/check",
    },
    now: () => 1700000000000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-env");
      return jsonResponse({ data: { userId: "user_probe", accessTier: "pro" } });
    },
  });
  await deps.accountStore.saveAccounts([{ id: "acct_probe_env", status: "active", cookieJarRef: "secrets/acct_probe_env.cookie" }]);
  await deps.secretStore.writeSecret("secrets/acct_probe_env.cookie", "tabbit_session=probe-env");

  const result = await deps.protocolProbeRunner.probeAccount({
    accountId: "acct_probe_env",
    operation: "verifySession",
  });

  assert.equal(result.status, "success");
  assert.equal(result.fixture.operation, "verifySession");
  assert.equal(result.fixture.result.userId, "user_probe");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=probe-env");
  assert.equal(JSON.stringify(result).includes("tabbit_session=probe-env"), false);
});

test("configured protocol env wires protocol probe runner for uploadAttachment", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-protocol-upload-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH: "/chat/attachments/upload",
    },
    now: () => 1700000000000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-upload-env");
      return jsonResponse({ data: { id: "att_env", filename: "probe.txt", mimeType: "text/plain", size: 12 } });
    },
  });
  await deps.accountStore.saveAccounts([{ id: "acct_upload_env", status: "active", cookieJarRef: "secrets/acct_upload_env.cookie" }]);
  await deps.secretStore.writeSecret("secrets/acct_upload_env.cookie", "tabbit_session=upload-env");

  const result = await deps.protocolProbeRunner.probeAccount({
    accountId: "acct_upload_env",
    operation: "uploadAttachment",
    input: {
      attachment: {
        filename: "probe.txt",
        mimeType: "text/plain",
        data: "base64-probe-payload",
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.fixture.operation, "uploadAttachment");
  assert.equal(result.fixture.result.attachment.id, "att_env");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://web.tabbit.ai/chat/attachments/upload");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=upload-env");
  assert.equal(JSON.stringify(result).includes("tabbit_session=upload-env"), false);
  assert.equal(JSON.stringify(result).includes("base64-probe-payload"), false);
});

test("configured COS upload env wires protocol probe runner for uploadAttachment", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-protocol-cos-upload-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH: "/proxy/v0/cos/presigned-upload-url",
      TABBIT_POOL_PROTOCOL_ATTACHMENT_COMPLETE_UPLOAD_PATH: "/api/v0/cos/complete-upload",
    },
    now: () => 1700000000000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/proxy/v0/cos/presigned-upload-url")) {
        return jsonResponse({
          url: "https://cos.example.test/upload/probe.txt",
          file_id: "file_probe_cos",
        });
      }
      if (url === "https://cos.example.test/upload/probe.txt") {
        return jsonResponse("");
      }
      if (url.endsWith("/api/v0/cos/complete-upload")) {
        return jsonResponse({ success: true });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });
  await deps.accountStore.saveAccounts([{ id: "acct_cos_upload_env", status: "active", cookieJarRef: "secrets/acct_cos_upload_env.cookie" }]);
  await deps.secretStore.writeSecret("secrets/acct_cos_upload_env.cookie", "tabbit_session=cos-upload-env");

  const result = await deps.protocolProbeRunner.probeAccount({
    accountId: "acct_cos_upload_env",
    operation: "uploadAttachment",
    input: {
      attachment: {
        filename: "probe.txt",
        mimeType: "text/plain",
        data: "probe payload",
      },
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.fixture.operation, "uploadAttachment");
  assert.equal(result.fixture.result.attachment.id, "file_probe_cos");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/proxy/v0/cos/presigned-upload-url",
    "/upload/probe.txt",
    "/api/v0/cos/complete-upload",
  ]);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=cos-upload-env");
  assert.match(calls[0].options.headers["trace-id"], uuidPattern);
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-nonce"), false);
  assert.equal(Buffer.from(calls[1].options.body).toString("utf8"), "probe payload");
  assert.equal(Object.hasOwn(calls[1].options.headers, "Cookie"), false);
  assert.deepEqual(JSON.parse(calls[2].options.body), { file_id: "file_probe_cos" });
  assert.match(calls[2].options.headers["trace-id"], uuidPattern);
  assert.equal(Object.hasOwn(calls[2].options.headers, "x-signature"), false);
  assert.equal(Object.hasOwn(calls[2].options.headers, "x-nonce"), false);
  assert.equal(JSON.stringify(result).includes("tabbit_session=cos-upload-env"), false);
  assert.equal(JSON.stringify(result).includes("probe payload"), false);
});

test("configured quota usage env wires protocol probe runner for refreshQuota", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-protocol-quota-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH: "/api/commerce/quota/v1/usage",
    },
    now: () => 1700000000000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        user_id: "user_probe_quota",
        member_level: "free",
        usage_percentage: "31.37%",
        current_cycle_end: "2026.07.10",
        unused_reset_coupon_count: 0,
      });
    },
  });
  await deps.accountStore.saveAccounts([{ id: "acct_quota_probe", status: "active", userId: "user_probe_quota", cookieJarRef: "secrets/acct_quota_probe.cookie" }]);
  await deps.secretStore.writeSecret("secrets/acct_quota_probe.cookie", "tabbit_session=quota-probe");

  const result = await deps.protocolProbeRunner.probeAccount({
    accountId: "acct_quota_probe",
    operation: "refreshQuota",
  });

  assert.equal(result.status, "success");
  assert.equal(result.fixture.operation, "refreshQuota");
  assert.equal(result.fixture.result.source, "tabbit-quota-usage");
  assert.equal(result.fixture.result.accessTier, "free");
  assert.equal(result.fixture.result.quotaState[0].unit, "usage_percentage");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/quota/v1/usage?user_id=user_probe_quota");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=quota-probe");
  assert.equal(JSON.stringify(result).includes("tabbit_session=quota-probe"), false);
});

test("configured read-only benefits env wires protocol probe runner", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-protocol-benefits-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_NEWBIE_EXPLORATION_PATH: "/api/commerce/activity/v1/newbie-exploration/me",
      TABBIT_POOL_PROTOCOL_REWARD_CARD_RECORDS_PATH: "/api/commerce/reward/v1/card-records",
      TABBIT_POOL_PROTOCOL_PLACEMENT_RESOURCES_PATH: "/api/commerce/placement/v1/resources",
    },
    now: () => 1700000000000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/newbie-exploration/")) {
        return jsonResponse({ view_mode: "activity_page", status: "not_available", visible: false });
      }
      return jsonResponse({ total: 0, records: [] });
    },
  });
  await deps.accountStore.saveAccounts([{ id: "acct_benefits_probe", status: "active", userId: "user_benefits_probe", cookieJarRef: "secrets/acct_benefits_probe.cookie" }]);
  await deps.secretStore.writeSecret("secrets/acct_benefits_probe.cookie", "tabbit_session=benefits-probe");

  const newbie = await deps.protocolProbeRunner.probeAccount({
    accountId: "acct_benefits_probe",
    operation: "getNewbieExplorationMe",
    input: { viewMode: "activity_page" },
  });
  const reward = await deps.protocolProbeRunner.probeAccount({
    accountId: "acct_benefits_probe",
    operation: "listRewardCardRecords",
    input: { limit: 10 },
  });
  const placement = await deps.protocolProbeRunner.probeAccount({
    accountId: "acct_benefits_probe",
    operation: "getPlacementResources",
    input: { placementCode: "home.input_below" },
  });

  assert.equal(newbie.status, "success");
  assert.equal(newbie.fixture.operation, "getNewbieExplorationMe");
  assert.equal(newbie.fixture.result.status, "not_available");
  assert.equal(reward.status, "success");
  assert.equal(reward.fixture.operation, "listRewardCardRecords");
  assert.equal(placement.status, "success");
  assert.equal(placement.fixture.operation, "getPlacementResources");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/activity/v1/newbie-exploration/me?view_mode=activity_page&include_completions=true&include_rewards=true");
  assert.equal(calls[1].url, "https://web.tabbit.ai/api/commerce/reward/v1/card-records?user_id=user_benefits_probe&offset=0&limit=10&order.field=award_time&order.order=desc");
  assert.equal(calls[2].url, "https://web.tabbit.ai/api/commerce/placement/v1/resources?placement_code=home.input_below");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=benefits-probe");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=benefits-probe");
  assert.equal(calls[2].options.headers.Cookie, "tabbit_session=benefits-probe");
  assert.equal(JSON.stringify([newbie, reward, placement]).includes("tabbit_session=benefits-probe"), false);
});


test("probe protocol --json runs injected protocol probe runner", async () => {
  const calls = [];
  const stream = io();
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "verifySession",
    "--write-fixture",
    "--json",
  ], {
    accountStore: memoryStore(baseAccounts()),
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return {
          status: "failed",
          fixtureRef: "fixtures/protocol-probes/probe.json",
          advice: { category: "protocol_changed", severity: "warning", recommendation: "Capture a fresh fixture." },
          fixture: {
            version: 1,
            kind: "protocol_probe",
            operation: input.operation,
            accountId: input.accountId,
            status: "failed",
            error: { category: "protocol_changed", message: "parser failed for al***@example.test token=***" },
          },
        };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [{ accountId: "acct_a", operation: "verifySession", writeFixture: true }]);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "failed");
  assert.equal(body.fixtureRef, "fixtures/protocol-probes/probe.json");
  assert.equal(body.fixture.operation, "verifySession");
  assert.equal(body.advice.category, "protocol_changed");
  assert.equal(JSON.stringify(body).includes("secret-token"), false);
});

test("probe protocol --input-json passes parsed input to the probe runner", async () => {
  const calls = [];
  const stream = io();
  const probeInput = {
    model: "tabbit/priority",
    messages: [{ role: "user", content: "ping" }],
  };

  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "sendMessage",
    "--input-json",
    JSON.stringify(probeInput),
    "--json",
  ], {
    accountStore: memoryStore(baseAccounts()),
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return {
          status: "success",
          advice: { category: "unknown", severity: "info", recommendation: "ok" },
          fixture: { version: 1, kind: "protocol_probe", operation: input.operation, status: "success" },
        };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [{
    accountId: "acct_a",
    operation: "sendMessage",
    input: probeInput,
    writeFixture: false,
  }]);
});

test("probe protocol --input-file reads JSON input for listModels probes", async () => {
  const calls = [];
  const stream = io();
  const dir = await mkdtemp(path.join(tmpdir(), "tabbit-probe-input-"));
  const inputPath = path.join(dir, "probe-input.json");
  const probeInput = { force: false, catalog: "all" };
  await writeFile(inputPath, JSON.stringify(probeInput), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "listModels",
    "--input-file",
    inputPath,
    "--json",
  ], {
    accountStore: memoryStore(baseAccounts()),
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return {
          status: "success",
          advice: { category: "unknown", severity: "info", recommendation: "ok" },
          fixture: { version: 1, kind: "protocol_probe", operation: input.operation, status: "success" },
        };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [{
    accountId: "acct_a",
    operation: "listModels",
    input: probeInput,
    writeFixture: false,
  }]);
});

test("probe protocol rejects empty sendMessage messages before calling the runner", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "sendMessage",
    "--input-json",
    JSON.stringify({ messages: [] }),
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return { status: "success", advice: {}, fixture: {} };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(calls, []);
  assert.match(stream.stderr.join("\n"), /messages/i);
  assert.match(stream.stderr.join("\n"), /non-empty/i);
});

test("probe protocol rejects invalid sendMessage model without leaking raw payload", async () => {
  const stream = io();
  const calls = [];
  const rawPayload = JSON.stringify({ model: "", messages: [{ role: "user", content: "secret-code-123456" }] });
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "sendMessage",
    "--input-json",
    rawPayload,
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return { status: "success", advice: {}, fixture: {} };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(calls, []);
  const stderr = stream.stderr.join("\n");
  assert.match(stderr, /model/i);
  assert.equal(stderr.includes("secret-code-123456"), false);
  assert.equal(stderr.includes(rawPayload), false);
});

test("probe protocol rejects non-boolean listModels force before calling the runner", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "listModels",
    "--input-json",
    JSON.stringify({ force: "yes" }),
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return { status: "success", advice: {}, fixture: {} };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(calls, []);
  assert.match(stream.stderr.join("\n"), /force/i);
  assert.match(stream.stderr.join("\n"), /boolean/i);
});

test("probe protocol rejects invalid newbie exploration viewMode before calling the runner", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "getNewbieExplorationMe",
    "--input-json",
    JSON.stringify({ viewMode: "sidebar", token: "secret-token" }),
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return { status: "success", advice: {}, fixture: {} };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(calls, []);
  const stderr = stream.stderr.join("\n");
  assert.match(stderr, /viewMode/i);
  assert.equal(stderr.includes("secret-token"), false);
});

test("probe protocol rejects invalid placement resources placementCode before calling the runner", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "getPlacementResources",
    "--input-json",
    JSON.stringify({ placementCode: "", token: "secret-token", code: "123456" }),
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return { status: "success", advice: {}, fixture: {} };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(calls, []);
  const stderr = stream.stderr.join("\n");
  assert.match(stderr, /placementCode/i);
  assert.equal(stderr.includes("secret-token"), false);
  assert.equal(stderr.includes("123456"), false);
});

test("probe protocol rejects invalid uploadAttachment attachment before calling the runner", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "uploadAttachment",
    "--input-json",
    JSON.stringify({ attachment: null, token: "secret-token", code: "123456" }),
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return { status: "success", advice: {}, fixture: {} };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(calls, []);
  const stderr = stream.stderr.join("\n");
  assert.match(stderr, /uploadAttachment\.attachment/);
  assert.equal(stderr.includes("secret-token"), false);
  assert.equal(stderr.includes("123456"), false);
});

test("probe protocol rejects invalid side-effect probe input before calling the runner", async () => {
  const calls = [];
  const stream = io();
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "drawLottery",
    "--input-json",
    JSON.stringify({ confirmSideEffect: "yes", body: [] }),
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return { status: "success", advice: {}, fixture: {} };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(calls, []);
  assert.match(stream.stderr.join("\n"), /confirmSideEffect/i);
});

test("probe protocol rejects oversized side-effect requestNo before calling the runner", async () => {
  const calls = [];
  const stream = io();
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "dailySignIn",
    "--input-json",
    JSON.stringify({ confirmSideEffect: true, requestNo: "x".repeat(65) }),
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return { status: "success", advice: {}, fixture: {} };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(stream.stdout.length, 0);
  assert.deepEqual(calls, []);
  assert.match(stream.stderr.join("\n"), /requestNo/);
});

test("probe protocol rejects invalid --input-json without leaking raw payload", async () => {
  const calls = [];
  const stream = io();
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--input-json",
    '{"token":"secret-token","code":"123456",',
    "--json",
  ], {
    accountStore: memoryStore(baseAccounts()),
    protocolProbeRunner: {
      async probeAccount(input) {
        calls.push(input);
        return { status: "success", advice: {}, fixture: {} };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  const stderr = stream.stderr.join("\n");
  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.match(stderr, /invalid JSON/i);
  assert.doesNotMatch(stderr, /secret-token|123456/);
});

test("probe protocol requires an account id", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "protocol", "--json"], {
    accountStore: memoryStore(baseAccounts()),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.match(stream.stderr.join("\n"), /account id/i);
});



test("fixtures audit --json prints calibration coverage without raw fixture secrets", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["fixtures", "audit", "--json"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return [
          { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
          { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
          { operation: "sendMessage", status: "failed", adviceCategory: "forbidden", error: { status: 403, message: "beta-user@example.test token=secret code 123456" } },
        ];
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["listFixtures"]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "blocked");
  assert.equal(body.coverage.sessionVerify.count, 1);
  assert.equal(body.coverage.successfulSendMessage.count, 1);
  assert.equal(body.coverage.streamingText.count, 1);
  assert.equal(body.coverage.forbidden403.count, 1);
  assert.deepEqual(body.missing, ["tool_call_fixture"]);
  assert.doesNotMatch(text, /beta-user@example.test|token=secret|123456/);
});

test("fixtures audit --json reads fixture bodies for stream and tool coverage", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/verify.json", { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } }],
    ["fixtures/protocol-probes/send.json", { operation: "sendMessage", status: "success", result: { contentBlocks: [{ type: "text", text: "ok" }] } }],
    ["fixtures/protocol-probes/stream.json", { operation: "sendMessage", status: "success", result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["ok"] } }],
    ["fixtures/protocol-probes/tool.json", {
      operation: "sendMessage",
      status: "failed",
      input: { model: "tabbit/priority", messages: [{ role: "user", content: "tool" }], tools: [{ type: "function", function: { name: "read_file" } }] },
      error: { code: "TOOL_FIELDS_UNSUPPORTED", message: "tool unsupported beta-user@example.test token=secret" },
    }],
    ["fixtures/protocol-probes/403.json", { operation: "sendMessage", status: "failed", adviceCategory: "forbidden", error: { status: 403, message: "code 123456" } }],
  ]);
  const result = await runProtocolPoolCli(["fixtures", "audit", "--json"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.keys()).map((ref) => ({
          ref,
          operation: ref.includes("verify") ? "verifySession" : "sendMessage",
          status: ref.includes("403") || ref.includes("tool") ? "failed" : "success",
        }));
      },
      async readFixture(ref) {
        calls.push("readFixture:" + ref);
        return fixtures.get(ref);
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, [
    "listFixtures",
    "readFixture:fixtures/protocol-probes/verify.json",
    "readFixture:fixtures/protocol-probes/send.json",
    "readFixture:fixtures/protocol-probes/stream.json",
    "readFixture:fixtures/protocol-probes/tool.json",
    "readFixture:fixtures/protocol-probes/403.json",
  ]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "ready");
  assert.deepEqual(body.missing, []);
  assert.equal(body.coverage.sessionVerify.count, 1);
  assert.equal(body.coverage.toolCall.count, 1);
  assert.doesNotMatch(text, /beta-user@example.test|token=secret|123456/);
});

test("fixtures list --json prints fixture summaries from the fixture store", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["fixtures", "list", "--json"], {
    accountStore: memoryStore([]),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return [{
          ref: "fixtures/protocol-probes/probe.json",
          observedAt: "2026-07-02T03:00:00.000Z",
          operation: "verifySession",
          status: "failed",
          accountId: "acct_a",
          adviceCategory: "session_missing",
        }];
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["listFixtures"]);
  const body = JSON.parse(stream.stdout.join(""));
  assert.deepEqual(body.fixtures.map((item) => item.ref), ["fixtures/protocol-probes/probe.json"]);
  assert.equal(body.fixtures[0].adviceCategory, "session_missing");
});

test("fixtures show --json prints a sanitized fixture document", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["fixtures", "show", "fixtures/protocol-probes/probe.json", "--json"], {
    accountStore: memoryStore([]),
    protocolFixtureStore: {
      async readFixture(ref) {
        calls.push(ref);
        return {
          version: 1,
          kind: "protocol_probe",
          observedAt: "2026-07-02T03:00:00.000Z",
          operation: "verifySession",
          accountId: "acct_a",
          status: "failed",
          account: {
            id: "acct_a",
            email: "alpha-user@example.test",
            status: "active",
            cookieJarRef: "secrets/acct_a.cookie",
            cookieHeader: "tabbit_session=secret-cookie",
          },
          input: { code: "123456", token: "secret-token" },
          error: { category: "session_missing", message: "alpha-user@example.test code 123456 token=secret" },
        };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["fixtures/protocol-probes/probe.json"]);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.kind, "protocol_probe");
  assert.equal(body.account.email, "al***@example.test");
  assert.equal(body.account.cookieJarRef, undefined);
  assert.doesNotMatch(JSON.stringify(body), /alpha-user@example.test|secret-cookie|secret-token|123456|secrets\/acct_a\.cookie/);
});

test("fixtures show requires a fixture ref", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["fixtures", "show", "--json"], {
    accountStore: memoryStore([]),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.match(stream.stderr.join("\n"), /fixture ref/i);
});
