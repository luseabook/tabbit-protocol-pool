import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import {
  anthropicMessageToSseEvents,
  chatCompletionToSseEvents,
  createProtocolPoolServer,
  responsesToSseEvents,
} from "../src/http-server.js";

async function withServer(server, fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.json(),
  };
}

async function requestText(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

function basicAuth(username, password) {
  return "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

const FAKE_ADMIN_SESSION_COOKIE = "tabbit" + "_session=private";
const FAKE_ADMIN_SESSION_COOKIE_NAME = "tabbit" + "_session";
const FAKE_ADMIN_LEAK_KEY = "sk" + "-should-not-leak";
const FAKE_ADMIN_CURRENT_KEY = "sk" + "-current-admin-key";
const FAKE_ADMIN_ROTATED_KEY = "sk" + "-rotated-admin-key";

function createAdminScriptHarness(script, { fetch } = {}) {
  const elements = new Map();
  const body = { className: "" };
  function getElementById(id) {
    if (!elements.has(id)) {
      const listeners = {};
      const attributes = new Map();
      elements.set(id, {
        id,
        value: "",
        innerHTML: "",
        textContent: "",
        hidden: false,
        type: "",
        disabled: false,
        listeners,
        addEventListener(type, handler) {
          listeners[type] = handler;
        },
        getAttribute(name) {
          return attributes.get(name) ?? null;
        },
        setAttribute(name, value) {
          attributes.set(name, String(value));
        },
        removeAttribute(name) {
          attributes.delete(name);
        },
        querySelectorAll() {
          return [];
        },
      });
    }
    return elements.get(id);
  }
  const clipboardWrites = [];
  return {
    elements,
    getElementById,
    body,
    clipboardWrites,
    context: {
      document: { getElementById, body },
      navigator: {
        clipboard: {
          async writeText(value) {
            clipboardWrites.push(value);
          },
        },
      },
      fetch,
      JSON,
      String,
      Array,
      btoa(value) { return Buffer.from(String(value), "utf8").toString("base64"); },
    },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createNeverEndingDeltas(firstDelta = "Hel") {
  const waitingForNext = createDeferred();
  const cancelled = createDeferred();
  return {
    waitingForNext,
    cancelled,
    deltas: {
      [Symbol.asyncIterator]() {
        let reads = 0;
        return {
          async next() {
            reads += 1;
            if (reads === 1) return { value: firstDelta, done: false };
            waitingForNext.resolve();
            return new Promise(() => {});
          },
          async return() {
            cancelled.resolve("returned");
            return { value: undefined, done: true };
          },
        };
      },
    },
  };
}

async function readUntil(reader, decoder, pattern) {
  let text = "";
  while (!pattern.test(text)) {
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 1000)),
    ]);
    if (next.done) return text;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

function rejectAfter(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

test("GET /health returns protocol-pool health without authentication", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/health");

    assert.equal(response.status, 200);
    assert.match(response.contentType, /^application\/json/);
    assert.deepEqual(response.body, { status: "ok", mode: "protocol-pool" });
  });
});

test("GET /admin serves the management shell without exposing secrets", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    admin: {
      async statusProvider() {
        return { status: "blocked" };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestText(baseUrl, "/admin");

    assert.equal(response.status, 200);
    assert.match(response.contentType, /^text\/html/);
    assert.match(response.body, /Tabbit 池管理后台/);
    assert.match(response.body, /<body class="auth-mode">/);
    assert.match(response.body, /admin-root/);
    assert.match(response.body, /admin-shell/);
    assert.match(response.body, /class="login-screen"/);
    assert.match(response.body, /受控后台入口/);
    assert.match(response.body, /<label for="admin-user">后台账号<\/label>/);
    assert.match(response.body, /id="admin-user"[^>]*aria-label="后台账号"/);
    assert.match(response.body, /<label for="admin-password">后台密码<\/label>/);
    assert.match(response.body, /id="admin-password"[^>]*aria-label="后台密码"/);
    assert.match(response.body, /凭据仅保存在当前页面/);
    assert.match(response.body, /admin-user/);
    assert.match(response.body, /admin-password/);
    assert.match(response.body, /ops-rail/);
    assert.match(response.body, /motion-grid/);
    assert.match(response.body, /metric-wall/);
    assert.match(response.body, /incident-strip/);
    assert.match(response.body, /raw-drawer/);
    assert.match(response.body, /id="nav-dashboard"/);
    assert.match(response.body, /id="nav-accounts"/);
    assert.match(response.body, /id="nav-key"/);
    assert.match(response.body, /id="nav-raw"/);
    assert.match(response.body, /id="view-dashboard"[^>]*hidden/);
    assert.match(response.body, /id="view-accounts"[^>]*hidden/);
    assert.match(response.body, /id="view-key"[^>]*hidden/);
    assert.match(response.body, /id="view-raw"[^>]*hidden/);
    assert.match(response.body, /id="key-secret-input"[^>]*type="password"/);
    assert.match(response.body, /id="key-secret-toggle"/);
    assert.match(response.body, /id="key-secret-copy"/);
    assert.match(response.body, /id="summary"[^>]*hidden/);
    assert.match(response.body, /id="raw-panel"[^>]*hidden/);
    assert.doesNotMatch(response.body, /Gateway Control Surface|Gateway state|Overview|Telemetry|API Key|StateDir|Key source|LOCKED|后台用户名/);
    assert.doesNotMatch(response.body, /sk-tabbit-local|tabbit_session|Bearer\s+/);
  });
});

test("GET /admin keeps operational data hidden until login and clears it on logout", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    admin: {
      async statusProvider() {
        return { status: "ok" };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestText(baseUrl, "/admin");
    const script = response.body.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);
    let fetchCount = 0;
    const requestPaths = [];
    const harness = createAdminScriptHarness(script, {
      fetch: async (path) => {
        fetchCount += 1;
        requestPaths.push(path);
        if (path === "/admin/api/key") {
          return {
            ok: true,
            json: async () => ({
              apiKey: FAKE_ADMIN_CURRENT_KEY,
              secretRef: "secrets/gateway-api-key.txt",
              apiKeySource: "state_secret",
              restartRequired: false,
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            status: "ok",
            stateDir: "E:\\tabbit-live-state",
            observedAt: "2026-07-05T02:00:00.000Z",
      gatewayApiKey: { status: "configured", source: "state_secret" },
            accounts: [{ id: "acct_a", email: "al***@example.test", status: "active", accessTier: "pro" }],
            protocol: {
              enabled: true,
              sendPathConfigured: true,
              sessionVerifyPathConfigured: true,
              modelCatalogPathConfigured: true,
              baseUrlConfigured: true,
              signKeyPathConfigured: true,
            },
            health: { accounts: { total: 1, active: 1, byStatus: {} } },
          }),
        };
      },
    });

    await runInNewContext(script, harness.context);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(harness.body.className, "auth-mode");
    assert.equal(fetchCount, 0);
    assert.equal(harness.getElementById("view-dashboard").hidden, true);
    assert.equal(harness.getElementById("view-accounts").hidden, true);
    assert.equal(harness.getElementById("view-key").hidden, true);
    assert.equal(harness.getElementById("view-raw").hidden, true);
    assert.equal(harness.getElementById("summary").innerHTML, "");

    harness.getElementById("admin-user").value = "admin";
    harness.getElementById("admin-password").value = "secret";
    await harness.getElementById("admin-auth").listeners.submit({ preventDefault() {} });

    assert.equal(fetchCount, 1);
    assert.equal(harness.body.className, "admin-mode");
    assert.equal(harness.getElementById("admin-auth").hidden, true);
    assert.equal(harness.getElementById("session-actions").hidden, false);
    assert.equal(harness.getElementById("view-dashboard").hidden, false);
    assert.equal(harness.getElementById("view-accounts").hidden, true);
    assert.equal(harness.getElementById("view-key").hidden, true);
    assert.equal(harness.getElementById("view-raw").hidden, true);
    assert.equal(harness.getElementById("summary").hidden, false);
    assert.match(harness.getElementById("summary").innerHTML, /网关/);
    assert.match(harness.getElementById("summary").innerHTML, /正常/);
    assert.match(harness.getElementById("summary").innerHTML, /接口密钥/);
    assert.doesNotMatch(harness.getElementById("summary").innerHTML, /Gateway|Accounts|Active|API Key|configured/);
    assert.match(harness.getElementById("protocol").innerHTML, /已启用/);
    assert.doesNotMatch(harness.getElementById("protocol").innerHTML, /Enabled|Send Path|Session Verify|Model Catalog|ON/);
    assert.match(harness.getElementById("security").innerHTML, /状态密钥/);
    assert.doesNotMatch(harness.getElementById("security").innerHTML, /state_secret|Base URL|Sign Key/);
    assert.equal(harness.getElementById("account-management-panel").hidden, true);
    assert.equal(harness.getElementById("key-management-panel").hidden, true);

    await harness.getElementById("nav-accounts").listeners.click({ preventDefault() {} });
    assert.equal(harness.getElementById("view-dashboard").hidden, true);
    assert.equal(harness.getElementById("view-accounts").hidden, false);
    assert.equal(harness.getElementById("account-management-panel").hidden, false);
    assert.match(harness.getElementById("account-table").innerHTML, /acct_a/);
    assert.match(harness.getElementById("account-table").innerHTML, /al\*\*\*@example\.test/);

    await harness.getElementById("nav-key").listeners.click({ preventDefault() {} });
    assert.deepEqual(requestPaths, ["/admin/api/status", "/admin/api/key"]);
    assert.equal(harness.getElementById("view-accounts").hidden, true);
    assert.equal(harness.getElementById("view-key").hidden, false);
    assert.equal(harness.getElementById("key-management-panel").hidden, false);
    assert.equal(harness.getElementById("key-secret-input").value, FAKE_ADMIN_CURRENT_KEY);
    assert.equal(harness.getElementById("key-secret-input").type, "password");
    await harness.getElementById("key-secret-toggle").listeners.click();
    assert.equal(harness.getElementById("key-secret-input").type, "text");
    await harness.getElementById("key-secret-copy").listeners.click();
    assert.deepEqual(harness.clipboardWrites, [FAKE_ADMIN_CURRENT_KEY]);

    await harness.getElementById("nav-raw").listeners.click({ preventDefault() {} });
    assert.equal(harness.getElementById("view-key").hidden, true);
    assert.equal(harness.getElementById("view-raw").hidden, false);

    harness.getElementById("admin-logout").listeners.click();

    assert.equal(harness.body.className, "auth-mode");
    assert.equal(harness.getElementById("admin-auth").hidden, false);
    assert.equal(harness.getElementById("session-actions").hidden, true);
    assert.equal(harness.getElementById("view-dashboard").hidden, true);
    assert.equal(harness.getElementById("view-accounts").hidden, true);
    assert.equal(harness.getElementById("view-key").hidden, true);
    assert.equal(harness.getElementById("view-raw").hidden, true);
    assert.equal(harness.getElementById("account-management-panel").hidden, true);
    assert.equal(harness.getElementById("key-management-panel").hidden, true);
    assert.equal(harness.getElementById("summary").innerHTML, "");
    assert.equal(harness.getElementById("account-table").innerHTML, "");
    assert.equal(harness.getElementById("accounts").innerHTML, "");
    assert.equal(harness.getElementById("protocol").innerHTML, "");
    assert.equal(harness.getElementById("security").innerHTML, "");
    assert.equal(harness.getElementById("key-secret-input").value, "");
    assert.equal(harness.getElementById("raw").textContent, "请先登录");
  });
});

test("admin APIs manage accounts and gateway key without leaking secrets", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    apiKey: "admin-secret-key",
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    admin: {
      username: "admin",
      password: "page-password",
      async statusProvider() {
        return { status: "ok" };
      },
      async keyProvider() {
        return { apiKey: FAKE_ADMIN_CURRENT_KEY, apiKeySource: "state_secret", secretRef: "secrets/gateway-api-key.txt" };
      },
      async accountsProvider() {
        return [{
          id: "acct_a",
          email: "alpha-user@example.test",
          status: "active",
          cookieJarRef: "secrets/acct_a.cookie",
          cookieHeader: "tabbit" + "_session=secret",
          token: "secret-token",
        }];
      },
      async importSession(input) {
        calls.push({ type: "import", input });
        return {
          id: input.accountId || "acct_auto",
          email: input.email,
          status: "active",
          accessTier: input.accessTier,
          cookieHeader: input.session,
          cookieJarRef: "secrets/" + (input.accountId || "acct_auto") + ".cookie",
        };
      },
      async updateAccountStatus(input) {
        calls.push({ type: "status", input });
        return { id: input.accountId, email: "alpha-user@example.test", status: input.status };
      },
      async rotateGatewayKey() {
        calls.push({ type: "rotate" });
        return { changed: true, secretRef: "secrets/gateway-api-key.txt", apiKeySource: "state_secret", apiKey: FAKE_ADMIN_ROTATED_KEY };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const rejected = await requestJson(baseUrl, "/admin/api/accounts", {
      headers: { Authorization: basicAuth("admin", "wrong-password") },
    });
    const listed = await requestJson(baseUrl, "/admin/api/accounts", {
      headers: { Authorization: basicAuth("admin", "page-password") },
    });
    const keyRejectedWithGatewayKey = await requestJson(baseUrl, "/admin/api/key", {
      headers: { "x-api-key": "admin-secret-key" },
    });
    const keyDetails = await requestJson(baseUrl, "/admin/api/key", {
      headers: { Authorization: basicAuth("admin", "page-password") },
    });
    const imported = await requestJson(baseUrl, "/admin/api/accounts/import-session", {
      method: "POST",
      headers: { Authorization: basicAuth("admin", "page-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "acct_b", email: "beta-user@example.test", session: FAKE_ADMIN_SESSION_COOKIE, accessTier: "pro" }),
    });
    const autoImported = await requestJson(baseUrl, "/admin/api/accounts/import-session", {
      method: "POST",
      headers: { Authorization: basicAuth("admin", "page-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "auto-user@example.test", session: FAKE_ADMIN_SESSION_COOKIE, accessTier: "free" }),
    });
    const disabled = await requestJson(baseUrl, "/admin/api/accounts/status", {
      method: "POST",
      headers: { Authorization: basicAuth("admin", "page-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "acct_a", status: "disabled" }),
    });
    const rotated = await requestJson(baseUrl, "/admin/api/key/rotate", {
      method: "POST",
      headers: { Authorization: basicAuth("admin", "page-password"), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(rejected.status, 401);
    assert.equal(listed.status, 200);
    assert.equal(keyRejectedWithGatewayKey.status, 401);
    assert.equal(keyDetails.status, 200);
    assert.equal(imported.status, 200);
    assert.equal(autoImported.status, 200);
    assert.equal(disabled.status, 200);
    assert.equal(rotated.status, 200);
    assert.equal(listed.body.accounts[0].email, "al***@example.test");
    assert.equal(keyDetails.body.apiKey, FAKE_ADMIN_CURRENT_KEY);
    assert.equal(keyDetails.body.secretRef, "secrets/gateway-api-key.txt");
    assert.equal(listed.body.accounts[0].cookieJarRef, undefined);
    assert.equal(imported.body.account.email, "be***@example.test");
    assert.equal(autoImported.body.account.id, "acct_auto");
    assert.equal(autoImported.body.account.email, "au***@example.test");
    assert.equal(autoImported.body.account.accessTier, "free");
    assert.equal(disabled.body.account.status, "disabled");
    assert.deepEqual(rotated.body, {
      changed: true,
      secretRef: "secrets/gateway-api-key.txt",
      apiKeySource: "state_secret",
      apiKey: FAKE_ADMIN_ROTATED_KEY,
      restartRequired: false,
    });
    const serialized = JSON.stringify({ listed: listed.body, imported: imported.body, autoImported: autoImported.body, disabled: disabled.body });
    assert.doesNotMatch(serialized, /alpha-user@example\.test|beta-user@example\.test|cookieJarRef|secret-token/);
    assert.equal(serialized.includes(FAKE_ADMIN_SESSION_COOKIE_NAME), false);
    assert.equal(serialized.includes(FAKE_ADMIN_LEAK_KEY), false);
    assert.equal(JSON.stringify({ listed: listed.body, imported: imported.body, disabled: disabled.body }).includes(FAKE_ADMIN_CURRENT_KEY), false);
    assert.deepEqual(calls, [
      { type: "import", input: { accountId: "acct_b", email: "beta-user@example.test", session: FAKE_ADMIN_SESSION_COOKIE, accessTier: "pro" } },
      { type: "import", input: { accountId: "", email: "auto-user@example.test", session: FAKE_ADMIN_SESSION_COOKIE, accessTier: "free" } },
      { type: "status", input: { accountId: "acct_a", status: "disabled" } },
      { type: "rotate" },
    ]);
  });
});

test("GET /admin renders account import tiers without a Premium option", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    admin: {
      username: "admin",
      password: "page-password",
      async statusProvider() { return { status: "ok" }; },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestText(baseUrl, "/admin");

    assert.equal(response.status, 200);
    assert.match(response.body, /<option value="free">免费版<\/option>/);
    assert.match(response.body, /<option value="pro">Pro<\/option>/);
    assert.match(response.body, /placeholder="账号 ID（可选，留空自动生成）"/);
    assert.doesNotMatch(response.body, /<option value="premium"|Premium/);
  });
});

test("POST /admin/api/accounts/import-session requires only session when account id is omitted", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    apiKey: "admin-secret-key",
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    admin: {
      username: "admin",
      password: "page-password",
      async importSession(input) {
        calls.push(input);
        return { id: input.accountId || "acct_auto", email: input.email, status: "active", accessTier: input.accessTier };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const missingId = await requestJson(baseUrl, "/admin/api/accounts/import-session", {
      method: "POST",
      headers: { Authorization: basicAuth("admin", "page-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ session: FAKE_ADMIN_SESSION_COOKIE, accessTier: "unknown" }),
    });
    const missingSession = await requestJson(baseUrl, "/admin/api/accounts/import-session", {
      method: "POST",
      headers: { Authorization: basicAuth("admin", "page-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "acct_b", accessTier: "unknown" }),
    });

    assert.equal(missingId.status, 200);
    assert.equal(missingId.body.account.id, "acct_auto");
    assert.equal(missingSession.status, 400);
    assert.equal(missingSession.body.error.message, "请粘贴 Tabbit session / cookie。");
    assert.deepEqual(calls, [{ accountId: "", email: "", session: FAKE_ADMIN_SESSION_COOKIE, accessTier: "unknown" }]);
  });
});

test("POST /admin/api/accounts/import-session rejects unsupported Premium tier", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    apiKey: "admin-secret-key",
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    admin: {
      username: "admin",
      password: "page-password",
      async importSession(input) {
        calls.push(input);
        return { id: input.accountId, status: "active", accessTier: input.accessTier };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const rejected = await requestJson(baseUrl, "/admin/api/accounts/import-session", {
      method: "POST",
      headers: { Authorization: basicAuth("admin", "page-password"), "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "acct_b", session: FAKE_ADMIN_SESSION_COOKIE, accessTier: "premium" }),
    });

    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "invalid_admin_account_input");
    assert.deepEqual(calls, []);
  });
});

test("GET /admin renders status values as escaped text", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    admin: {
      async statusProvider() {
        return { status: "blocked" };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestText(baseUrl, "/admin");
    const script = response.body.match(/<script>([\s\S]*)<\/script>/)?.[1];
    assert.ok(script);

    const harness = createAdminScriptHarness(script, {
      fetch: async () => ({
        ok: true,
        json: async () => ({
          status: 'ok"><img src=x onerror=alert(1)>',
          stateDir: '<img src=x onerror=alert(2)>',
          gatewayApiKey: { status: "configured", source: "env" },
          protocol: {},
          health: { accounts: {} },
        }),
      }),
    });

    await runInNewContext(script, harness.context);
    harness.getElementById("admin-user").value = "admin";
    harness.getElementById("admin-password").value = "secret";
    await harness.getElementById("admin-auth").listeners.submit({ preventDefault() {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.doesNotMatch(harness.getElementById("summary").innerHTML, /<img/);
    assert.match(harness.getElementById("summary").innerHTML, /&lt;img/);
  });
});

test("GET /admin/api/status requires the gateway API key", async () => {
  const server = createProtocolPoolServer({
    apiKey: "admin-secret-key",
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    admin: {
      async statusProvider() {
        return { status: "blocked", stateDir: "E:\\tabbit-live-state" };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const rejected = await requestJson(baseUrl, "/admin/api/status");
    const accepted = await requestJson(baseUrl, "/admin/api/status", {
      headers: { "x-api-key": "admin-secret-key" },
    });

    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error.code, "invalid_api_key");
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, {
      status: "blocked",
      stateDir: "E:\\tabbit-live-state",
    });
  });
});

test("GET /admin/api/status accepts configured admin username and password", async () => {
  const server = createProtocolPoolServer({
    apiKey: "admin-secret-key",
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    admin: {
      username: "admin",
      password: "page-password",
      async statusProvider() {
        return { status: "ok", stateDir: "E:\\tabbit-live-state" };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const rejected = await requestJson(baseUrl, "/admin/api/status", {
      headers: { Authorization: basicAuth("admin", "wrong-password") },
    });
    const accepted = await requestJson(baseUrl, "/admin/api/status", {
      headers: { Authorization: basicAuth("admin", "page-password") },
    });

    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.error.code, "invalid_api_key");
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, {
      status: "ok",
      stateDir: "E:\\tabbit-live-state",
    });
  });
});

test("POST /v1/chat/completions rejects missing authentication", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("must not call handler"); },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: {
        message: "Missing or invalid API key.",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
  });
});

test("POST /v1/chat/completions parses JSON and writes handler result", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions(body) {
        calls.push(body);
        return { status: 201, body: { ok: true, route: "chat" } };
      },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const requestBody = { model: "tabbit/priority", messages: [{ role: "user", content: "hello" }] };
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { ok: true, route: "chat" });
    assert.deepEqual(calls, [requestBody]);
  });
});

test("POST /v1/responses parses JSON and writes handler result", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses(body) {
        calls.push(body);
        return { status: 202, body: { ok: true, route: "responses" } };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const requestBody = { model: "tabbit/priority", input: "hello" };
    const response = await requestJson(baseUrl, "/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { ok: true, route: "responses" });
    assert.deepEqual(calls, [requestBody]);
  });
});

test("POST routes return OpenAI invalid_json for malformed JSON", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("must not call handler"); },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: "{bad json",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: {
        message: "Request body must be valid JSON.",
        type: "invalid_request_error",
        code: "invalid_json",
      },
    });
  });
});

test("GET /v1/models returns OpenAI list shape from modelsProvider", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
    modelsProvider: async () => [
      {
        id: "tabbit/priority",
        selectedModel: null,
        supports_tools: true,
        supports_images: false,
        model_access_type: "priority",
        requires_premium: false,
      },
      {
        id: "tabbit/Claude-Sonnet-4.6",
        selectedModel: "Claude-Sonnet-4.6",
        supports_tools: true,
        supports_images: true,
        model_access_type: "pro",
        requires_premium: true,
      },
      {
        id: "tabbit/Default",
        selectedModel: "Default",
        supports_tools: true,
        supports_images: true,
        model_access_type: "free_unlimited",
        requires_premium: false,
      },
      {
        id: "tabbit/Claude-Opus-4.7",
        selectedModel: "Claude-Opus-4.7",
        supports_tools: true,
        supports_images: true,
        model_access_type: "premium_only",
        requires_premium: true,
      },
      {
        id: "tabbit/Claude-Opus-4.8",
        selectedModel: "Claude-Opus-4.8",
        supports_tools: true,
        supports_images: true,
        model_access_type: "premium_only",
        requires_premium: true,
      },
    ],
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/models", {
      headers: { "x-api-key": "sk-tabbit-local" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      object: "list",
      data: [
        {
          id: "Claude-Sonnet-4.6",
          object: "model",
          owned_by: "tabbit",
          tabbit_selected_model: "Claude-Sonnet-4.6",
          supports_tools: true,
          supports_images: true,
          model_access_type: "pro",
          requires_premium: true,
        },
        {
          id: "Claude-Opus-4.8",
          object: "model",
          owned_by: "tabbit",
          tabbit_selected_model: "Claude-Opus-4.8",
          supports_tools: true,
          supports_images: true,
          model_access_type: "premium_only",
          requires_premium: true,
        },
      ],
    });
  });
});

test("POST routes pass an empty body as an empty object", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions(body) {
        calls.push(body);
        return { status: 200, body: { ok: true } };
      },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer sk-tabbit-local" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
    assert.deepEqual(calls, [{}]);
  });
});

test("protected routes reject incorrect API keys", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("must not call handler"); },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer wrong" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.error.type, "authentication_error");
    assert.equal(response.body.error.code, "invalid_api_key");
  });
});

test("unknown routes return OpenAI not_found errors", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/unknown", {
      headers: { "Authorization": "Bearer sk-tabbit-local" },
    });

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: {
        message: "Route not found.",
        type: "invalid_request_error",
        code: "not_found",
      },
    });
  });
});

test("POST /v1/messages parses JSON and writes Anthropic handler result", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages(body) {
        calls.push(body);
        return { status: 200, body: { type: "message", route: "anthropic" } };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const requestBody = { model: "tabbit/priority", messages: [{ role: "user", content: "hello" }] };
    const response = await requestJson(baseUrl, "/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": "sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { type: "message", route: "anthropic" });
    assert.deepEqual(calls, [requestBody]);
  });
});

test("POST /v1/messages rejects missing authentication before reading JSON", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages() { throw new Error("must not call handler"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.error.type, "authentication_error");
    assert.equal(response.body.error.code, "invalid_api_key");
  });
});

test("SSE converters can emit separate upstream text deltas when supplied", () => {
  const chatEvents = chatCompletionToSseEvents({
    id: "chat_stream_delta",
    created: 1782961200,
    model: "tabbit/priority",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  }, { deltas: ["Hel", "lo"] });
  const chatBody = chatEvents.join("");
  assert.match(chatBody, /"delta":\{"content":"Hel"\}/);
  assert.match(chatBody, /"delta":\{"content":"lo"\}/);
  assert.doesNotMatch(chatBody, /"delta":\{"content":"Hello"\}/);
  assert.equal((chatBody.match(/"delta":\{"content":/g) || []).length, 2);

  const responsesEvents = responsesToSseEvents({
    id: "resp_stream_delta",
    object: "response",
    created_at: 1782961201,
    model: "tabbit/priority",
    output_text: "Hello",
    output: [],
  }, { deltas: ["Hel", "lo"] });
  const responsesBody = responsesEvents.join("");
  assert.match(responsesBody, /"delta":"Hel"/);
  assert.match(responsesBody, /"delta":"lo"/);
  assert.doesNotMatch(responsesBody, /"delta":"Hello"/);
  assert.equal((responsesBody.match(/event: response\.output_text\.delta/g) || []).length, 2);

  const anthropicEvents = anthropicMessageToSseEvents({
    id: "msg_stream_delta",
    type: "message",
    role: "assistant",
    model: "tabbit/priority",
    content: [{ type: "text", text: "Hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }, { deltas: ["Hel", "lo"] });
  const anthropicBody = anthropicEvents.join("");
  assert.match(anthropicBody, /"delta":\{"type":"text_delta","text":"Hel"\}/);
  assert.match(anthropicBody, /"delta":\{"type":"text_delta","text":"lo"\}/);
  assert.doesNotMatch(anthropicBody, /"delta":\{"type":"text_delta","text":"Hello"\}/);
  assert.equal((anthropicBody.match(/event: content_block_delta/g) || []).length, 2);
});

test("chatCompletionToSseEvents emits OpenAI tool_calls deltas", () => {
  const events = chatCompletionToSseEvents({
    id: "chatcmpl_tool_stream",
    object: "chat.completion",
    created: 1782961210,
    model: "tabbit/priority",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "I will inspect the file.",
        tool_calls: [{
          id: "call_read_file",
          type: "function",
          function: {
            name: "read_file",
            arguments: "{\"path\":\"package.json\"}",
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });

  const text = events.join("");
  assert.match(text, /"delta":\{"content":"I will inspect the file\."\}/);
  assert.match(text, /"tool_calls":\[\{"index":0,"id":"call_read_file","type":"function","function":\{"name":"read_file","arguments":"\{\\\"path\\\":\\\"package\.json\\\"\}"\}\}\]/);
  assert.match(text, /"finish_reason":"tool_calls"/);
});

test("responsesToSseEvents emits Responses function_call item events", () => {
  const events = responsesToSseEvents({
    id: "resp_function_stream",
    object: "response",
    created_at: 1782961211,
    model: "tabbit/priority",
    output_text: "",
    output: [{
      id: "fc_call_read_file",
      type: "function_call",
      call_id: "call_read_file",
      name: "read_file",
      arguments: "{\"path\":\"package.json\"}",
      status: "completed",
    }],
  });

  const text = events.join("");
  assert.match(text, /event: response\.output_item\.added/);
  assert.match(text, /"type":"response\.output_item\.added"/);
  assert.match(text, /"item":\{"id":"fc_call_read_file","type":"function_call","call_id":"call_read_file","name":"read_file","arguments":""/);
  assert.match(text, /event: response\.function_call_arguments\.delta/);
  assert.match(text, /"delta":"\{\\\"path\\\":\\\"package\.json\\\"\}"/);
  assert.match(text, /event: response\.function_call_arguments\.done/);
  assert.match(text, /event: response\.output_item\.done/);
  assert.match(text, /event: response\.completed/);
});

test("POST /v1/messages returns invalid_json for malformed JSON", async () => {
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages() { throw new Error("must not call handler"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: "{bad json",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: {
        message: "Request body must be valid JSON.",
        type: "invalid_request_error",
        code: "invalid_json",
      },
    });
  });
});

test("POST /v1/chat/completions stream true flushes async deltas before completion", async () => {
  const releaseSecond = createDeferred();
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions(body) {
        calls.push(body);
        return {
          status: 200,
          body: {
            id: "chat_async_stream",
            object: "chat.completion",
            created: 1782961200,
            model: "tabbit/priority",
            choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
          },
          stream: {
            deltas: (async function* deltas() {
              yield "Hel";
              await releaseSecond.promise;
              yield "lo";
            }()),
          },
        };
      },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith("text/event-stream"));
    assert.equal(response.headers.get("content-length"), null);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeSecond = await readUntil(reader, decoder, /"delta":\{"content":"Hel"\}/);
    releaseSecond.resolve();

    assert.match(beforeSecond, /"delta":\{"content":"Hel"\}/);
    assert.doesNotMatch(beforeSecond, /"delta":\{"content":"lo"\}/);

    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }

    assert.match(rest, /"delta":\{"content":"lo"\}/);
    assert.ok(rest.endsWith("data: [DONE]\n\n"));
  });

  assert.deepEqual(calls, [{ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }]);
});

test("POST /v1/chat/completions stream true flushes async tool_call deltas", async () => {
  const releaseArguments = createDeferred();
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() {
        return {
          status: 200,
          body: {
            id: "chat_async_tool_stream",
            object: "chat.completion",
            created: 1782961200,
            model: "tabbit/priority",
            choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
          },
          stream: {
            deltas: (async function* deltas() {
              yield { type: "tool_call_delta", index: 0, id: "call_read_file", name: "read_file" };
              await releaseArguments.promise;
              yield { type: "tool_call_delta", index: 0, argumentsDelta: "{\"path\":\"package.json\"}" };
            }()),
          },
        };
      },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeArguments = await readUntil(reader, decoder, /"tool_calls":\[\{"index":0,"id":"call_read_file"/);
    releaseArguments.resolve();
    const rest = await readUntil(reader, decoder, /data: \[DONE\]/);

    assert.match(beforeArguments, /"function":\{"name":"read_file"\}/);
    assert.doesNotMatch(beforeArguments, /package\.json/);
    assert.match(rest, /"function":\{"arguments":"\{\\\"path\\\":\\\"package\.json\\\"\}"\}/);
    assert.match(rest, /"finish_reason":"tool_calls"/);
    assert.ok(rest.endsWith("data: [DONE]\n\n"));
  });
});

test("POST /v1/chat/completions stream true cancels async deltas when client disconnects", async () => {
  const stream = createNeverEndingDeltas("Hel");
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() {
        return {
          status: 200,
          body: {
            id: "chatcmpl_cancel",
            object: "chat.completion",
            created: 1700000001,
            model: "tabbit/priority",
            choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
          },
          stream: { deltas: stream.deltas },
        };
      },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const abortController = new AbortController();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }),
      signal: abortController.signal,
    });

    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeDisconnect = await readUntil(reader, decoder, /"delta":\{"content":"Hel"\}/);
    assert.match(beforeDisconnect, /"delta":\{"content":"Hel"\}/);
    await Promise.race([
      stream.waitingForNext.promise,
      rejectAfter(1000, "server did not start waiting for the next upstream delta"),
    ]);

    abortController.abort();
    await reader.cancel().catch(() => {});

    await Promise.race([
      stream.cancelled.promise,
      rejectAfter(250, "server did not cancel async stream deltas after client disconnect"),
    ]);
  });
});

test("POST /v1/chat/completions stream true emits SSE error when async deltas reject", async () => {
  const releaseError = createDeferred();
  const calls = [];
  const streamError = Object.assign(new Error("Current account quota exhausted"), {
    code: "QUOTA_EXHAUSTED",
    category: "quota_exhausted",
  });
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions(body) {
        calls.push(body);
        return {
          status: 200,
          body: {
            id: "chat_async_stream_error",
            object: "chat.completion",
            created: 1782961200,
            model: "tabbit/priority",
            choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
          },
          stream: {
            deltas: (async function* deltas() {
              yield "Hel";
              await releaseError.promise;
              throw streamError;
            }()),
          },
        };
      },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith("text/event-stream"));
    assert.equal(response.headers.get("content-length"), null);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeError = await readUntil(reader, decoder, /"delta":\{"content":"Hel"\}/);
    releaseError.resolve();

    assert.match(beforeError, /"delta":\{"content":"Hel"\}/);

    let rest;
    try {
      rest = await readUntil(reader, decoder, /data: \[DONE\]/);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }

    assert.match(rest, /"error":\{"message":"Current account quota exhausted","type":"api_error","code":"QUOTA_EXHAUSTED"\}/);
    assert.ok(rest.endsWith("data: [DONE]\n\n"));
  });

  assert.deepEqual(calls, [{ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }]);
});

test("POST /v1/responses stream true flushes async deltas before completion", async () => {
  const releaseSecond = createDeferred();
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses(body) {
        calls.push(body);
        return {
          status: 200,
          body: {
            id: "resp_async_stream",
            object: "response",
            created_at: 1782961201,
            model: "tabbit/priority",
            output_text: "Hello",
            output: [],
          },
          stream: {
            deltas: (async function* deltas() {
              yield "Hel";
              await releaseSecond.promise;
              yield "lo";
            }()),
          },
        };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, input: "hello" }),
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith("text/event-stream"));
    assert.equal(response.headers.get("content-length"), null);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeSecond = await readUntil(reader, decoder, /"delta":"Hel"/);
    releaseSecond.resolve();

    assert.match(beforeSecond, /"delta":"Hel"/);
    assert.doesNotMatch(beforeSecond, /"delta":"lo"/);

    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }

    assert.match(rest, /"delta":"lo"/);
    assert.ok(rest.endsWith("data: [DONE]\n\n"));
  });

  assert.deepEqual(calls, [{ model: "tabbit/priority", stream: true, input: "hello" }]);
});

test("POST /v1/responses stream true flushes async function_call item events", async () => {
  const releaseArguments = createDeferred();
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() {
        return {
          status: 200,
          body: {
            id: "resp_async_tool_stream",
            object: "response",
            created_at: 1782961201,
            model: "tabbit/priority",
            output_text: "",
            output: [],
          },
          stream: {
            deltas: (async function* deltas() {
              yield { type: "tool_call_delta", index: 0, id: "call_read_file", name: "read_file" };
              await releaseArguments.promise;
              yield { type: "tool_call_delta", index: 0, argumentsDelta: "{\"path\":\"package.json\"}" };
            }()),
          },
        };
      },
      async handleMessages() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, input: "hello" }),
    });

    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeArguments = await readUntil(reader, decoder, /event: response\.output_item\.added/);
    releaseArguments.resolve();
    const rest = await readUntil(reader, decoder, /data: \[DONE\]/);

    assert.match(beforeArguments, /"item":\{"id":"fc_call_read_file","type":"function_call","call_id":"call_read_file","name":"read_file","arguments":""/);
    assert.match(rest, /event: response\.function_call_arguments\.delta/);
    assert.match(rest, /"delta":"\{\\\"path\\\":\\\"package\.json\\\"\}"/);
    assert.match(rest, /event: response\.function_call_arguments\.done/);
    assert.match(rest, /event: response\.output_item\.done/);
    assert.match(rest, /event: response\.completed/);
    assert.ok(rest.endsWith("data: [DONE]\n\n"));
  });
});

test("POST /v1/responses stream true emits response.failed when async deltas reject", async () => {
  const releaseError = createDeferred();
  const streamError = Object.assign(new Error("Current account quota exhausted"), {
    code: "QUOTA_EXHAUSTED",
    category: "quota_exhausted",
  });
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() {
        return {
          status: 200,
          body: {
            id: "resp_async_stream_error",
            object: "response",
            created_at: 1782961201,
            model: "tabbit/priority",
            output_text: "",
            output: [],
          },
          stream: {
            deltas: (async function* deltas() {
              yield "Hel";
              await releaseError.promise;
              throw streamError;
            }()),
          },
        };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, input: "hello" }),
    });

    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeError = await readUntil(reader, decoder, /"delta":"Hel"/);
    releaseError.resolve();
    const rest = await readUntil(reader, decoder, /data: \[DONE\]/);

    assert.match(beforeError, /"delta":"Hel"/);
    assert.match(rest, /event: response\.failed/);
    assert.match(rest, /"type":"response.failed"/);
    assert.match(rest, /"status":"failed"/);
    assert.match(rest, /"code":"QUOTA_EXHAUSTED"/);
    assert.ok(rest.endsWith("data: [DONE]\n\n"));
  });
});

test("POST /v1/messages stream true flushes async Anthropic deltas before completion", async () => {
  const releaseSecond = createDeferred();
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages(body) {
        calls.push(body);
        return {
          status: 200,
          body: {
            id: "msg_async_stream",
            type: "message",
            role: "assistant",
            model: "tabbit/priority",
            content: [{ type: "text", text: "Hello" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          stream: {
            deltas: (async function* deltas() {
              yield "Hel";
              await releaseSecond.promise;
              yield "lo";
            }()),
          },
        };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith("text/event-stream"));
    assert.equal(response.headers.get("content-length"), null);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeSecond = await readUntil(reader, decoder, /"delta":\{"type":"text_delta","text":"Hel"\}/);
    releaseSecond.resolve();

    assert.match(beforeSecond, /"delta":\{"type":"text_delta","text":"Hel"\}/);
    assert.doesNotMatch(beforeSecond, /"delta":\{"type":"text_delta","text":"lo"\}/);

    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }

    assert.match(rest, /"delta":\{"type":"text_delta","text":"lo"\}/);
    assert.match(rest, /event: message_stop/);
  });

  assert.deepEqual(calls, [{ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }]);
});

test("POST /v1/messages stream true flushes async tool_use content block deltas", async () => {
  const releaseArguments = createDeferred();
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages() {
        return {
          status: 200,
          body: {
            id: "msg_async_tool_stream",
            type: "message",
            role: "assistant",
            model: "tabbit/priority",
            content: [{ type: "text", text: "" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          stream: {
            deltas: (async function* deltas() {
              yield { type: "tool_call_delta", index: 0, id: "toolu_read_file", name: "read_file" };
              await releaseArguments.promise;
              yield { type: "tool_call_delta", index: 0, argumentsDelta: "{\"path\":\"package.json\"}" };
            }()),
          },
        };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeArguments = await readUntil(reader, decoder, /"content_block":\{"type":"tool_use","id":"toolu_read_file","name":"read_file","input":\{\}\}/);
    releaseArguments.resolve();
    const rest = await readUntil(reader, decoder, /event: message_stop/);

    assert.doesNotMatch(beforeArguments, /package\.json/);
    assert.match(rest, /"delta":\{"type":"input_json_delta","partial_json":"\{\\\"path\\\":\\\"package\.json\\\"\}"\}/);
    assert.match(rest, /"stop_reason":"tool_use"/);
    assert.match(rest, /event: content_block_stop/);
  });
});

test("POST /v1/messages stream true emits Anthropic error event when async deltas reject", async () => {
  const releaseError = createDeferred();
  const streamError = Object.assign(new Error("Current account quota exhausted"), {
    code: "QUOTA_EXHAUSTED",
    category: "quota_exhausted",
  });
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages() {
        return {
          status: 200,
          body: {
            id: "msg_async_stream_error",
            type: "message",
            role: "assistant",
            model: "tabbit/priority",
            content: [{ type: "text", text: "" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          stream: {
            deltas: (async function* deltas() {
              yield "Hel";
              await releaseError.promise;
              throw streamError;
            }()),
          },
        };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeError = await readUntil(reader, decoder, /"delta":\{"type":"text_delta","text":"Hel"\}/);
    releaseError.resolve();
    const rest = await readUntil(reader, decoder, /event: error/);

    assert.match(beforeError, /"delta":\{"type":"text_delta","text":"Hel"\}/);
    assert.match(rest, /event: error/);
    assert.match(rest, /"type":"error"/);
    assert.match(rest, /"error":\{"type":"api_error","message":"Current account quota exhausted"\}/);
    assert.match(rest, /"code":"QUOTA_EXHAUSTED"/);
  });
});

test("POST /v1/chat/completions stream true returns SSE chunks", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions(body) {
        calls.push(body);
        return {
          status: 200,
          body: {
            id: "chatcmpl_stream_test",
            object: "chat.completion",
            created: 1782961200,
            model: "tabbit/priority",
            choices: [{ index: 0, message: { role: "assistant", content: "hello stream" }, finish_reason: "stop" }],
          },
        };
      },
      async handleResponses() { throw new Error("not used"); },
    },
  });

  await withServer(server, async (baseUrl) => {
    const requestBody = { model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] };
    const response = await requestText(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 200);
    assert.ok(response.contentType?.startsWith("text/event-stream"));
    assert.deepEqual(calls, [requestBody]);
    assert.match(response.body, /data: .*"object":"chat.completion.chunk"/);
    assert.match(response.body, /data: .*"delta":{"content":"hello stream"}/);
    assert.ok(response.body.endsWith("data: [DONE]\n\n"));
  });
});

test("POST /v1/responses stream true returns SSE events", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses(body) {
        calls.push(body);
        return {
          status: 200,
          body: {
            id: "resp_stream_test",
            object: "response",
            created_at: 1782961201,
            model: "tabbit/priority",
            output_text: "hello responses stream",
            output: [
              {
                id: "msg_resp_stream_test",
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "hello responses stream" }],
              },
            ],
          },
        };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const requestBody = { model: "tabbit/priority", stream: true, input: "hello" };
    const response = await requestText(baseUrl, "/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 200);
    assert.ok(response.contentType?.startsWith("text/event-stream"));
    assert.deepEqual(calls, [requestBody]);
    assert.match(response.body, /event: response.created/);
    assert.match(response.body, /event: response.output_text.delta/);
    assert.match(response.body, /"delta":"hello responses stream"/);
    assert.match(response.body, /event: response.completed/);
    assert.ok(response.body.endsWith("data: [DONE]\n\n"));
  });
});

test("OpenAI stream true routes keep non-2xx handler errors as JSON", async () => {
  const chatError = {
    error: { message: "chat validation failed", type: "invalid_request_error", code: "bad_chat" },
  };
  const responsesError = {
    error: { message: "responses validation failed", type: "invalid_request_error", code: "bad_response" },
  };
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { return { status: 400, body: chatError }; },
      async handleResponses() { return { status: 429, body: responsesError }; },
    },
  });

  await withServer(server, async (baseUrl) => {
    const chatResponse = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, messages: [] }),
    });
    assert.equal(chatResponse.status, 400);
    assert.ok(chatResponse.contentType?.startsWith("application/json"));
    assert.deepEqual(chatResponse.body, chatError);

    const responsesResponse = await requestJson(baseUrl, "/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, input: "hello" }),
    });
    assert.equal(responsesResponse.status, 429);
    assert.ok(responsesResponse.contentType?.startsWith("application/json"));
    assert.deepEqual(responsesResponse.body, responsesError);
  });
});

test("POST /v1/messages stream true returns Anthropic SSE events", async () => {
  const calls = [];
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages(body) {
        calls.push(body);
        return {
          status: 200,
          body: {
            id: "msg_stream_test",
            type: "message",
            role: "assistant",
            model: "tabbit/priority",
            content: [{ type: "text", text: "hello anthropic stream" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
            metadata: { created_at: "1782961202" },
          },
        };
      },
    },
  });

  await withServer(server, async (baseUrl) => {
    const requestBody = { model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] };
    const response = await requestText(baseUrl, "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    assert.equal(response.status, 200);
    assert.ok(response.contentType?.startsWith("text/event-stream"));
    assert.deepEqual(calls, [requestBody]);
    assert.match(response.body, /event: message_start/);
    assert.match(response.body, /"type":"message_start"/);
    assert.match(response.body, /event: content_block_start/);
    assert.match(response.body, /event: content_block_delta/);
    assert.match(response.body, /"delta":{"type":"text_delta","text":"hello anthropic stream"}/);
    assert.match(response.body, /event: content_block_stop/);
    assert.match(response.body, /event: message_delta/);
    assert.match(response.body, /"stop_reason":"end_turn"/);
    assert.match(response.body, /event: message_stop/);
  });
});

test("Anthropic stream true route keeps non-2xx handler errors as JSON", async () => {
  const errorBody = {
    type: "error",
    error: { type: "api_error", message: "anthropic stream failed" },
    metadata: { code: "UPSTREAM_FAILED" },
  };
  const server = createProtocolPoolServer({
    compat: {
      async handleChatCompletions() { throw new Error("not used"); },
      async handleResponses() { throw new Error("not used"); },
      async handleMessages() { return { status: 503, body: errorBody }; },
    },
  });

  await withServer(server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tabbit/priority", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 503);
    assert.ok(response.contentType?.startsWith("application/json"));
    assert.deepEqual(response.body, errorBody);
  });
});
