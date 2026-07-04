import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AccountProvisioner } from "../src/account-provisioner.js";
import { createProtocolPoolCliDependencies, runProtocolPoolCli } from "../src/ops-cli.js";
import { FileProtocolFixtureStore } from "../src/protocol-probe.js";

const NOW = "2026-07-02T03:00:00.000Z";

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

function manualCookieReadyFixtures() {
  return [
    {
      operation: "verifySession",
      status: "success",
      observedAt: "2026-07-02T03:00:00.000Z",
      result: { ok: true, userId: "user_123" },
    },
    {
      operation: "verifySession",
      status: "failed",
      observedAt: "2026-07-03T03:00:00.000Z",
      error: { category: "login_required", status: 401, message: "expired beta-user@example.test token=secret" },
    },
    {
      operation: "sendMessage",
      status: "success",
      result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["ok"] },
    },
    {
      operation: "sendMessage",
      status: "failed",
      input: { tools: [{ type: "function", function: { name: "lookup_private_data" } }] },
      result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
    },
    {
      operation: "sendMessage",
      status: "failed",
      result: { ok: false, error: { category: "forbidden", status: 403 } },
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

test("readiness doctor --json explains state, protocol env, and remaining work without touching network", async () => {
  const stream = io();
  const calls = [];
  const stateDir = path.join(tmpdir(), "tabbit-readiness-doctor-test");
  const result = await runProtocolPoolCli(["readiness", "doctor", "--json"], {
    config: {
      stateDir,
      apiKey: "secret-local-key",
      compat: {
        stripClientTools: true,
        toolLoopMode: "client_executes_tools_first",
      },
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
        authSendCodePath: "/api/auth/send-code",
        authSubmitCodePath: "/api/auth/submit-code",
        signInPath: "/api/commerce/activity/v1/sign-in",
        benefitCouponUsePath: "/api/commerce/benefit/v1/coupon/use",
        activityParticipatePath: "/api/commerce/activity/v1/participate",
        lotteryDrawPath: "/api/commerce/lottery/v1/draw",
        reqCtx: "browser-context-secret",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return [
          { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
          { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
        ];
      },
    },
    readinessStateStore: memoryReadinessStore({}, calls),
    accountVerifier: {
      async verifyAccount() {
        calls.push(["verifyAccount"]);
        throw new Error("readiness doctor must not verify accounts");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push(["probeAccount"]);
        throw new Error("readiness doctor must not run protocol probes");
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.stateDir, stateDir);
  assert.equal(body.protocol.enabled, true);
  assert.equal(body.protocol.baseUrlConfigured, true);
  assert.equal(body.protocol.sendPathConfigured, true);
  assert.equal(body.protocol.sessionVerifyPathConfigured, true);
  assert.equal(body.protocol.compatStripClientTools, true);
  assert.equal(body.readiness.status, "blocked");
  assert.equal(body.fixtureAudit.status, "blocked");
  assert.ok(Array.isArray(body.remainingWork));
  assert.ok(body.remainingWork.some((action) => action.includes("403")));
  assert.match(body.commands.setStateDir, /\$env:TABBIT_POOL_STATE_DIR/);
  assert.match(body.commands.fixturesAudit, /fixtures audit --json/);
  assert.doesNotMatch(text, /alpha-user@example\.test|beta-user@example\.test/);
  assert.doesNotMatch(text, /tabbit_session|secret-token|secret-local-key|browser-context-secret|cookieJarRef/);
});

test("readiness doctor --json includes auth and benefits backlog without running probes", async () => {
  const stream = io();
  const calls = [];
  const stateDir = path.join(tmpdir(), "tabbit-readiness-doctor-backlog-test");
  const result = await runProtocolPoolCli(["readiness", "doctor", "--json"], {
    config: {
      stateDir,
      apiKey: "secret-local-key",
      compat: {
        stripClientTools: true,
        toolLoopMode: "client_executes_tools_first",
      },
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
        authSendCodePath: "/api/auth/send-code",
        authSubmitCodePath: "/api/auth/submit-code",
        signInPath: "/api/commerce/activity/v1/sign-in",
        benefitCouponUsePath: "/api/commerce/benefit/v1/coupon/use",
        activityParticipatePath: "/api/commerce/activity/v1/participate",
        lotteryDrawPath: "/api/commerce/lottery/v1/draw",
        reqCtx: "browser-context-secret",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return [
          { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
          { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
          {
            operation: "sendMessage",
            status: "failed",
            input: { tools: [{ type: "function", function: { name: "lookup_private_data" } }] },
            result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
          },
          { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
        ];
      },
    },
    readinessStateStore: memoryReadinessStore({
      codex: { verified: true },
      claude: { verified: true },
    }, calls),
    accountVerifier: {
      async verifyAccount() {
        calls.push(["verifyAccount"]);
        throw new Error("readiness doctor must not verify accounts");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push(["probeAccount"]);
        throw new Error("readiness doctor must not run protocol probes");
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "ready");
  assert.equal(body.protocol.authSendCodePathConfigured, true);
  assert.equal(body.protocol.authSubmitCodePathConfigured, true);
  assert.deepEqual(body.remainingWork, []);
  assert.equal(body.calibrationBacklog?.status, "blocked");
  assert.equal(body.calibrationBacklog.scopes.auth.status, "blocked");
  assert.equal(body.calibrationBacklog.scopes.benefits.status, "blocked");
  assert.equal(body.calibrationBacklog.scopes.session.status, "blocked");
  assert.equal(body.calibrationBacklog.scopes.upstream.status, "blocked");
  assert.ok(body.calibrationBacklog.missing.includes("successful_sendVerificationCode_fixture"));
  assert.ok(body.calibrationBacklog.missing.includes("successful_lottery_draw_fixture"));
  assert.ok(body.calibrationBacklog.missing.includes("expired_verifySession_fixture"));
  assert.ok(body.calibrationBacklog.missing.includes("automated_session_refresh_strategy"));
  assert.ok(body.calibrationBacklog.missing.includes("real_upstream_error_frame_fixture"));
  assert.ok(body.calibrationBacklog.missing.includes("real_upstream_cancellation_fixture"));
  assert.ok(body.calibrationBacklog.missing.includes("real_upstream_backpressure_fixture"));
  assert.ok(Array.isArray(body.calibrationBacklog.captureCommands));
  const sendCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "successful_sendVerificationCode_fixture");
  assert.ok(sendCapture);
  assert.ok(sendCapture.templateCommand.includes("probe template --operation sendVerificationCode --json"));
  assert.ok(sendCapture.probeCommand.includes("probe protocol --account <account-id> --operation sendVerificationCode --input-file <redacted-input.json> --write-fixture --json"));
  assert.equal(sendCapture.writeFixtureCommand, null);
  assert.equal(sendCapture.prerequisitesStatus, "ready");
  assert.deepEqual(sendCapture.prerequisites, [{
    name: "auth_send_code_endpoint",
    env: "TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH",
    status: "configured",
  }]);
  const dailyCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "successful_daily_sign_in_fixture");
  assert.equal(dailyCapture.prerequisitesStatus, "ready");
  assert.deepEqual(dailyCapture.prerequisites, [{
    name: "daily_sign_in_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SIGN_IN_PATH",
    status: "configured",
  }]);
  const proCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "successful_pro_activity_fixture");
  assert.equal(proCapture.prerequisitesStatus, "ready");
  assert.deepEqual(proCapture.prerequisites, [{
    name: "activity_participate_endpoint",
    env: "TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH",
    status: "configured",
  }]);
  const resetCouponCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "successful_reset_coupon_consumption_fixture");
  assert.equal(resetCouponCapture.scope, "benefits");
  assert.equal(resetCouponCapture.operation, "useResetCoupon");
  assert.equal(resetCouponCapture.sideEffect, true);
  assert.ok(resetCouponCapture.templateCommand.includes("probe template --operation useResetCoupon --json"));
  assert.ok(resetCouponCapture.validateCommand.includes("probe validate --operation useResetCoupon --input-file <redacted-input.json> --json"));
  assert.ok(resetCouponCapture.confirmedValidateCommand.includes("probe validate --operation useResetCoupon --input-file <redacted-input.json> --require-confirmed-side-effect --json"));
  assert.ok(resetCouponCapture.probeCommand.includes("probe protocol --account <account-id> --operation useResetCoupon --input-file <redacted-input.json> --write-fixture --json"));
  assert.equal(resetCouponCapture.writeFixtureCommand, null);
  assert.equal(resetCouponCapture.prerequisitesStatus, "ready");
  assert.deepEqual(resetCouponCapture.prerequisites, [{
    name: "benefit_coupon_use_endpoint",
    env: "TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_USE_PATH",
    status: "configured",
  }]);
  assert.match(resetCouponCapture.reason, /coupon use/i);
  const lotteryCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "successful_lottery_draw_fixture");
  assert.equal(lotteryCapture.prerequisitesStatus, "ready");
  assert.deepEqual(lotteryCapture.prerequisites, [{
    name: "lottery_draw_endpoint",
    env: "TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH",
    status: "configured",
  }]);
  const expiredSessionCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "expired_verifySession_fixture");
  assert.equal(expiredSessionCapture.prerequisitesStatus, "ready");
  assert.deepEqual(expiredSessionCapture.prerequisites, [{
    name: "session_verify_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH",
    status: "configured",
  }]);
  const upstreamErrorCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "real_upstream_error_frame_fixture");
  assert.equal(upstreamErrorCapture.scope, "upstream");
  assert.equal(upstreamErrorCapture.operation, "sendMessage");
  assert.equal(upstreamErrorCapture.sideEffect, false);
  assert.equal(upstreamErrorCapture.prerequisitesStatus, "ready");
  assert.deepEqual(upstreamErrorCapture.prerequisites, [{
    name: "protocol_send_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
    status: "configured",
  }]);
  assert.match(upstreamErrorCapture.probeCommand, /probe protocol --account <account-id> --operation sendMessage --input-file <redacted-input\.json> --write-fixture --json/);
  const upstreamCancelCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "real_upstream_cancellation_fixture");
  assert.equal(upstreamCancelCapture.scope, "upstream");
  assert.equal(upstreamCancelCapture.operation, "sendMessage");
  assert.equal(upstreamCancelCapture.prerequisitesStatus, "ready");
  assert.deepEqual(upstreamCancelCapture.prerequisites, [{
    name: "protocol_send_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
    status: "configured",
  }]);
  const upstreamBackpressureCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "real_upstream_backpressure_fixture");
  assert.equal(upstreamBackpressureCapture.scope, "upstream");
  assert.equal(upstreamBackpressureCapture.operation, "sendMessage");
  assert.equal(upstreamBackpressureCapture.prerequisitesStatus, "ready");
  assert.deepEqual(upstreamBackpressureCapture.prerequisites, [{
    name: "protocol_send_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
    status: "configured",
  }]);
  const recoveryCapture = body.calibrationBacklog.captureCommands.find((item) => item.missing === "automated_session_refresh_strategy");
  assert.equal(recoveryCapture.operation, "recoverSession");
  assert.ok(recoveryCapture.templateCommand.includes("probe template --operation recoverSession --json"));
  assert.ok(recoveryCapture.validateCommand.includes("probe validate --operation recoverSession --input-file <redacted-input.json> --json"));
  assert.equal(recoveryCapture.confirmedValidateCommand, null);
  assert.equal(recoveryCapture.probeCommand, null);
  assert.ok(recoveryCapture.writeFixtureCommand.includes("probe validate --operation recoverSession --input-file <redacted-input.json> --write-fixture --json"));
  assert.match(body.commands.authFixturesAudit, /fixtures audit --scope auth --json/);
  assert.match(body.commands.benefitsFixturesAudit, /fixtures audit --scope benefits --json/);
  assert.match(body.commands.sessionFixturesAudit, /fixtures audit --scope session --json/);
  assert.match(body.commands.upstreamFixturesAudit, /fixtures audit --scope upstream --json/);
  assert.doesNotMatch(text, /alpha-user@example\.test|beta-user@example\.test/);
  assert.doesNotMatch(text, /tabbit_session|secret-token|secret-local-key|browser-context-secret|cookieJarRef/);
  assert.doesNotMatch(text, /lookup_private_data/);
});

test("production preflight --json blocks the default API key without leaking it", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["production", "preflight", "--json"], {
    config: {
      stateDir: path.join(tmpdir(), "tabbit-production-preflight-default-key-test"),
      apiKey: "sk-tabbit-local",
      compat: { toolLoopMode: "client_executes_tools_first" },
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return manualCookieReadyFixtures();
      },
    },
    readinessStateStore: memoryReadinessStore({
      codex: { verified: true },
      claude: { verified: true },
    }, calls),
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "blocked");
  assert.equal(body.checks.gatewayApiKey.status, "blocked");
  assert.deepEqual(body.checks.gatewayApiKey.missing, ["non_default_api_key"]);
  assert.equal(body.checks.readinessDoctor.status, "ready");
  assert.equal(body.checks.manualCookieMode.status, "ready");
  assert.deepEqual(body.missing, ["non_default_api_key"]);
  assert.deepEqual(body.commands, {
    initGatewayKey: "node bin\\tabbit-pool.js production init-key --json",
  });
  assert.ok(body.nextActions.some((item) => item.includes("secrets/gateway-api-key.txt")));
  assert.doesNotMatch(text, /sk-tabbit-local|tabbit_session|secret-token|alpha-user@example\.test|lookup_private_data/);
});

test("production preflight --json blocks incomplete manual cookie evidence", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["production", "preflight", "--json"], {
    config: {
      stateDir: path.join(tmpdir(), "tabbit-production-preflight-manual-cookie-test"),
      apiKey: "prod-local-key",
      compat: { toolLoopMode: "client_executes_tools_first" },
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return manualCookieReadyFixtures().filter((fixture) => fixture.error?.category !== "login_required");
      },
    },
    readinessStateStore: memoryReadinessStore({
      codex: { verified: true },
      claude: { verified: true },
    }, calls),
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "blocked");
  assert.equal(body.checks.gatewayApiKey.status, "ready");
  assert.equal(body.checks.readinessDoctor.status, "ready");
  assert.equal(body.checks.manualCookieMode.status, "blocked");
  assert.deepEqual(body.checks.manualCookieMode.missing, ["expired_verifySession_fixture"]);
  assert.deepEqual(body.missing, ["expired_verifySession_fixture"]);
  assert.doesNotMatch(text, /prod-local-key|tabbit_session|secret-token|beta-user@example\.test|lookup_private_data/);
});

test("production preflight --json passes only ready doctor and manual cookie state", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["production", "preflight", "--json"], {
    config: {
      stateDir: path.join(tmpdir(), "tabbit-production-preflight-ready-test"),
      apiKey: "prod-local-key",
      compat: { toolLoopMode: "client_executes_tools_first" },
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return manualCookieReadyFixtures();
      },
    },
    readinessStateStore: memoryReadinessStore({
      codex: { verified: true },
      claude: { verified: true },
    }, calls),
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "ready");
  assert.equal(body.checks.gatewayApiKey.status, "ready");
  assert.equal(body.checks.readinessDoctor.status, "ready");
  assert.equal(body.checks.manualCookieMode.status, "ready");
  assert.deepEqual(body.missing, []);
  assert.doesNotMatch(text, /prod-local-key|tabbit_session|secret-token|user_123|lookup_private_data/);
});

test("production init-key --json writes a gateway API key secret without printing it", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-production-init-key-"));
  await mkdir(path.join(stateDir, "fixtures", "protocol-probes"), { recursive: true });
  await mkdir(path.join(stateDir, "secrets"), { recursive: true });
  await writeFile(path.join(stateDir, "accounts.json"), JSON.stringify({ version: 1, accounts: [] }), "utf8");
  await writeFile(path.join(stateDir, "readiness.json"), JSON.stringify({ codex: { verified: true } }), "utf8");
  const stream = io();

  const result = await runProtocolPoolCli(["production", "init-key", "--json"], {
    env: { TABBIT_POOL_STATE_DIR: stateDir },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.changed, true);
  assert.equal(body.stateDir, stateDir);
  assert.equal(body.secretRef, "secrets/gateway-api-key.txt");
  const key = (await readFile(path.join(stateDir, "secrets", "gateway-api-key.txt"), "utf8")).trim();
  assert.match(key, /^sk-tabbit-pool-[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(text, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("production init-key reports write failures without leaking generated keys", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["production", "init-key", "--json"], {
    config: {
      stateDir: path.join(tmpdir(), "tabbit-production-init-key-denied-test"),
      apiKey: "sk-tabbit-local",
      productionState: { source: "auto_discovered", apiKeySource: "default" },
      compat: { toolLoopMode: "client_executes_tools_first" },
      protocol: { enabled: true },
    },
    secretStore: {
      async writeSecret() {
        throw new Error("permission denied for sk-tabbit-pool-leaked-key-material");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(stream.stdout.length, 0);
  const text = stream.stderr.join("");
  assert.match(text, /Unable to write gateway API key secret/);
  assert.doesNotMatch(text, /sk-tabbit-pool-leaked-key-material/);
});

test("readiness doctor prints calibration backlog in plain output", async () => {
  const stream = io();
  const calls = [];
  const stateDir = path.join(tmpdir(), "tabbit-readiness-doctor-plain-backlog-test");
  const result = await runProtocolPoolCli(["readiness", "doctor"], {
    config: {
      stateDir,
      apiKey: "secret-local-key",
      compat: {
        stripClientTools: true,
        toolLoopMode: "client_executes_tools_first",
      },
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
        authSendCodePath: "/api/auth/send-code",
        authSubmitCodePath: "/api/auth/submit-code",
        signInPath: "/api/commerce/activity/v1/sign-in",
        benefitCouponUsePath: "/api/commerce/benefit/v1/coupon/use",
        activityParticipatePath: "/api/commerce/activity/v1/participate",
        lotteryDrawPath: "/api/commerce/lottery/v1/draw",
        reqCtx: "browser-context-secret",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return [
          { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
          { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
          {
            operation: "sendMessage",
            status: "failed",
            input: { tools: [{ type: "function", function: { name: "lookup_private_data" } }] },
            result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
          },
          { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
        ];
      },
    },
    readinessStateStore: memoryReadinessStore({
      codex: { verified: true },
      claude: { verified: true },
    }, calls),
    accountVerifier: {
      async verifyAccount() {
        calls.push(["verifyAccount"]);
        throw new Error("readiness doctor must not verify accounts");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push(["probeAccount"]);
        throw new Error("readiness doctor must not run protocol probes");
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const text = stream.stdout.join("");
  assert.match(text, /^status\tready/m);
  assert.match(text, /^auth_send_endpoint\tconfigured/m);
  assert.match(text, /^auth_submit_endpoint\tconfigured/m);
  assert.match(text, /^remaining_work\t0/m);
  assert.match(text, /^manual_cookie_mode\tblocked\tmode=manual_reimport_then_probe\tautomated_refresh=backlog\tmissing=expired_verifySession_fixture\trelease_blocking_missing=expired_verifySession_fixture\tbacklog_missing=automated_session_refresh_strategy/m);
  assert.match(text, /^preflight_command\taccount_read_only\tnode bin\\tabbit-pool\.js accounts probe <account-id> --read-only --json/m);
  assert.match(text, /^calibration_backlog\tblocked\tmissing=11/m);
  assert.match(text, /^auth_backlog\tblocked\tmissing=2/m);
  assert.match(text, /^benefits_backlog\tblocked\tmissing=4/m);
  assert.match(text, /^session_backlog\tblocked\tmissing=2/m);
  assert.match(text, /^upstream_backlog\tblocked\tmissing=3/m);
  assert.match(text, /^capture_command\tsuccessful_sendVerificationCode_fixture.*\tprereq=TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH:configured/m);
  assert.match(text, /^capture_command\tsuccessful_daily_sign_in_fixture.*\tprereq=TABBIT_POOL_PROTOCOL_SIGN_IN_PATH:configured/m);
  assert.match(text, /^capture_command\tsuccessful_pro_activity_fixture.*\tprereq=TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH:configured/m);
  assert.match(text, /^capture_command\tsuccessful_lottery_draw_fixture.*\tprereq=TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH:configured/m);
  assert.match(text, /^capture_command\texpired_verifySession_fixture.*\tprereq=TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH:configured/m);
  assert.match(text, /^capture_command\treal_upstream_error_frame_fixture\tupstream\tside_effect=false\ttemplate=node bin\\tabbit-pool\.js probe template --operation sendMessage --stream-evidence error_frame --json.*\tstream_evidence=error_frame:2\treview=replace_redacted_message_content\tprereq=TABBIT_POOL_PROTOCOL_SEND_PATH:configured/m);
  assert.match(text, /^capture_command\treal_upstream_cancellation_fixture\tupstream\tside_effect=false\ttemplate=node bin\\tabbit-pool\.js probe template --operation sendMessage --stream-evidence cancel_after_first_delta --json.*\tstream_evidence=cancel_after_first_delta:2\treview=replace_redacted_message_content\tprereq=TABBIT_POOL_PROTOCOL_SEND_PATH:configured/m);
  assert.match(text, /^capture_command\treal_upstream_backpressure_fixture\tupstream\tside_effect=false\ttemplate=node bin\\tabbit-pool\.js probe template --operation sendMessage --stream-evidence first_token_backpressure --json.*\tstream_evidence=first_token_backpressure:2\treview=replace_redacted_message_content\tprereq=TABBIT_POOL_PROTOCOL_SEND_PATH:configured/m);
  assert.match(text, /^capture_command\tsuccessful_sendVerificationCode_fixture\tauth\tside_effect=true\ttemplate=node bin\\tabbit-pool\.js probe template --operation sendVerificationCode --json\tvalidate=node bin\\tabbit-pool\.js probe validate --operation sendVerificationCode --input-file <redacted-input\.json> --json\tconfirm_validate=node bin\\tabbit-pool\.js probe validate --operation sendVerificationCode --input-file <redacted-input\.json> --require-confirmed-side-effect --json\tprobe=node bin\\tabbit-pool\.js probe protocol --account <account-id> --operation sendVerificationCode --input-file <redacted-input\.json> --write-fixture --json/m);
  assert.match(text, /^capture_command\tsuccessful_reset_coupon_consumption_fixture\tbenefits\tside_effect=true\ttemplate=node bin\\tabbit-pool\.js probe template --operation useResetCoupon --json\tvalidate=node bin\\tabbit-pool\.js probe validate --operation useResetCoupon --input-file <redacted-input\.json> --json\tconfirm_validate=node bin\\tabbit-pool\.js probe validate --operation useResetCoupon --input-file <redacted-input\.json> --require-confirmed-side-effect --json\tprobe=node bin\\tabbit-pool\.js probe protocol --account <account-id> --operation useResetCoupon --input-file <redacted-input\.json> --write-fixture --json\twrite_fixture=\tprereq=TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_USE_PATH:configured\treason=/m);
  assert.match(text, /^capture_command\tautomated_session_refresh_strategy\tsession\tside_effect=false\ttemplate=node bin\\tabbit-pool\.js probe template --operation recoverSession --json\tvalidate=node bin\\tabbit-pool\.js probe validate --operation recoverSession --input-file <redacted-input\.json> --json\tconfirm_validate=\tprobe=\twrite_fixture=node bin\\tabbit-pool\.js probe validate --operation recoverSession --input-file <redacted-input\.json> --write-fixture --json\tprereq=\treason=/m);
  assert.doesNotMatch(text, /alpha-user@example\.test|beta-user@example\.test/);
  assert.doesNotMatch(text, /tabbit_session|secret-token|secret-local-key|browser-context-secret|cookieJarRef/);
  assert.doesNotMatch(text, /lookup_private_data/);
});

test("readiness doctor prints forbidden 403 capture command in plain output", async () => {
  const stream = io();
  const calls = [];
  const stateDir = path.join(tmpdir(), "tabbit-readiness-doctor-forbidden-capture-test");
  const result = await runProtocolPoolCli(["readiness", "doctor"], {
    config: {
      stateDir,
      apiKey: "secret-local-key",
      compat: {
        stripClientTools: true,
        toolLoopMode: "client_executes_tools_first",
      },
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
        reqCtx: "browser-context-secret",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return [
          { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
          { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
          {
            operation: "sendMessage",
            status: "failed",
            input: { tools: [{ type: "function", function: { name: "lookup_private_data" } }] },
            result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
          },
        ];
      },
    },
    readinessStateStore: memoryReadinessStore({
      codex: { verified: true },
      claude: { verified: true },
    }, calls),
    accountVerifier: {
      async verifyAccount() {
        calls.push(["verifyAccount"]);
        throw new Error("readiness doctor must not verify accounts");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push(["probeAccount"]);
        throw new Error("readiness doctor must not run protocol probes");
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const text = stream.stdout.join("");
  assert.match(text, /^capture_command\tforbidden_403_fixture\tprotocol\tside_effect=false\ttemplate=node bin\\tabbit-pool\.js probe template --operation verifySession --json\tvalidate=node bin\\tabbit-pool\.js probe validate --operation verifySession --input-file <redacted-input\.json> --json\tconfirm_validate=\tprobe=node bin\\tabbit-pool\.js probe protocol --account <account-id> --operation verifySession --input-file <redacted-input\.json> --write-fixture --json\twrite_fixture=\tprereq=TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH:configured\treason=/m);
  assert.doesNotMatch(text, /https:\/\/web\.tabbit\.ai|\/api\/v0\/user\/base-info|secret-local-key|browser-context-secret|tabbit_session|Bearer\s+|lookup_private_data/i);
});

test("readiness doctor prints default send capture commands in plain output", async () => {
  const stream = io();
  const calls = [];
  const stateDir = path.join(tmpdir(), "tabbit-readiness-doctor-default-send-capture-test");
  const result = await runProtocolPoolCli(["readiness", "doctor"], {
    config: {
      stateDir,
      apiKey: "secret-local-key",
      compat: {
        stripClientTools: true,
        toolLoopMode: "client_executes_tools_first",
      },
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
        reqCtx: "browser-context-secret",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return [
          { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
          { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
        ];
      },
    },
    readinessStateStore: memoryReadinessStore({
      codex: { verified: true },
      claude: { verified: true },
    }, calls),
    accountVerifier: {
      async verifyAccount() {
        calls.push(["verifyAccount"]);
        throw new Error("readiness doctor must not verify accounts");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push(["probeAccount"]);
        throw new Error("readiness doctor must not run protocol probes");
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const text = stream.stdout.join("");
  assert.match(text, /^capture_command\tsuccessful_sendMessage_fixture\tprotocol\tside_effect=false\ttemplate=node bin\\tabbit-pool\.js probe template --operation sendMessage --json\tvalidate=node bin\\tabbit-pool\.js probe validate --operation sendMessage --input-file <redacted-input\.json> --json\tconfirm_validate=\tprobe=node bin\\tabbit-pool\.js probe protocol --account <account-id> --operation sendMessage --input-file <redacted-input\.json> --write-fixture --json\twrite_fixture=\treview=replace_redacted_message_content\tprereq=TABBIT_POOL_PROTOCOL_SEND_PATH:configured\treason=/m);
  assert.match(text, /^capture_command\tstreaming_text_fixture\tprotocol\tside_effect=false\ttemplate=node bin\\tabbit-pool\.js probe template --operation sendMessage --json\tvalidate=node bin\\tabbit-pool\.js probe validate --operation sendMessage --input-file <redacted-input\.json> --json\tconfirm_validate=\tprobe=node bin\\tabbit-pool\.js probe protocol --account <account-id> --operation sendMessage --input-file <redacted-input\.json> --write-fixture --json\twrite_fixture=\treview=replace_redacted_message_content\tprereq=TABBIT_POOL_PROTOCOL_SEND_PATH:configured\treason=/m);
  assert.match(text, /^capture_command\ttool_call_fixture\tprotocol\tside_effect=false\ttemplate=node bin\\tabbit-pool\.js probe template --operation sendMessage --json\tvalidate=node bin\\tabbit-pool\.js probe validate --operation sendMessage --input-file <redacted-input\.json> --json\tconfirm_validate=\tprobe=node bin\\tabbit-pool\.js probe protocol --account <account-id> --operation sendMessage --input-file <redacted-input\.json> --write-fixture --json\twrite_fixture=\treview=replace_redacted_message_content\tprereq=TABBIT_POOL_PROTOCOL_SEND_PATH:configured\treason=.*unsupported-native-tool/m);
  assert.doesNotMatch(text, /https:\/\/web\.tabbit\.ai|\/api\/v1\/chat\/completion|\/api\/v0\/user\/base-info|secret-local-key|browser-context-secret|tabbit_session|Bearer\s+|lookup_private_data/i);
});

test("readiness doctor prints E2E mark commands in plain output", async () => {
  const stream = io();
  const calls = [];
  const stateDir = path.join(tmpdir(), "tabbit-readiness-doctor-e2e-mark-test");
  const result = await runProtocolPoolCli(["readiness", "doctor"], {
    config: {
      stateDir,
      apiKey: "secret-local-key",
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
        reqCtx: "browser-context-secret",
      },
    },
    accountStore: memoryStore(baseAccounts(), calls),
    protocolFixtureStore: {
      async listFixtures() {
        calls.push(["listFixtures"]);
        return [
          { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
          { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
          { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
        ];
      },
    },
    readinessStateStore: memoryReadinessStore({}, calls),
    accountVerifier: {
      async verifyAccount() {
        calls.push(["verifyAccount"]);
        throw new Error("readiness doctor must not verify accounts");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push(["probeAccount"]);
        throw new Error("readiness doctor must not run protocol probes");
      },
    },
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, [["loadAccounts"], ["listFixtures"], ["readReadinessState"]]);
  const text = stream.stdout.join("");
  assert.match(text, /^mark_command\tcodex_e2e\tnode bin\\tabbit-pool\.js readiness mark --codex-verified --json/m);
  assert.match(text, /^mark_command\tclaude_code_e2e\tnode bin\\tabbit-pool\.js readiness mark --claude-verified --json/m);
  assert.match(text, /^mark_command\tcombined_e2e\tnode bin\\tabbit-pool\.js readiness mark --codex-verified --claude-verified --json/m);
  assert.doesNotMatch(text, /writeReadinessState|https:\/\/web\.tabbit\.ai|\/api\/v1\/chat\/completion|\/api\/v0\/user\/base-info|secret-local-key|browser-context-secret|tabbit_session|Bearer\s+|user_123/i);
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
    messages: [{ role: "user", content: "<redacted-message-content>" }],
    stream: true,
  });
  assert.equal(JSON.stringify(body).includes("token"), false);
  assert.equal(JSON.stringify(body).includes("cookie"), false);
  assert.equal(JSON.stringify(body).includes("ping"), false);
});

test("probe template --operation sendMessage can include streamEvidence mode", async () => {
  const templateStream = io();
  const templateResult = await runProtocolPoolCli([
    "probe",
    "template",
    "--operation",
    "sendMessage",
    "--stream-evidence",
    "error_frame",
    "--json",
  ], {
    stdout: (line) => templateStream.stdout.push(line),
    stderr: (line) => templateStream.stderr.push(line),
  });

  assert.equal(templateResult.exitCode, 0);
  assert.equal(templateStream.stderr.length, 0);
  const template = JSON.parse(templateStream.stdout.join(""));
  assert.deepEqual(template, {
    model: "tabbit/priority",
    messages: [{ role: "user", content: "<redacted-message-content>" }],
    stream: true,
    streamEvidence: { mode: "error_frame", maxDeltas: 2 },
  });

  const validateStream = io();
  const validateResult = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "sendMessage",
    "--input-json",
    JSON.stringify(template),
    "--json",
  ], {
    stdout: (line) => validateStream.stdout.push(line),
    stderr: (line) => validateStream.stderr.push(line),
  });

  assert.equal(validateResult.exitCode, 0);
  assert.equal(validateStream.stderr.length, 0);
  const preview = JSON.parse(validateStream.stdout.join(""));
  assert.equal(preview.status, "valid");
  assert.equal(preview.operation, "sendMessage");
  assert.deepEqual(preview.streamEvidence, { mode: "error_frame", maxDeltas: 2 });

  const serialized = templateStream.stdout.join("") + validateStream.stdout.join("");
  assert.doesNotMatch(serialized, /cookie|session|token|api[_-]?key|Bearer\s+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|rawPayload|prompt|user@example/i);
  assert.doesNotMatch(serialized, /\bping\b/);
});

test("probe template rejects invalid streamEvidence template options", async () => {
  const cases = [
    {
      args: ["probe", "template", "--operation", "sendMessage", "--stream-evidence", "full_raw_stream", "--json"],
      message: /streamEvidence\.mode/,
    },
    {
      args: ["probe", "template", "--operation", "sendMessage", "--stream-evidence", "error_frame", "--max-deltas", "0", "--json"],
      message: /maxDeltas/,
    },
    {
      args: ["probe", "template", "--operation", "verifySession", "--stream-evidence", "error_frame", "--json"],
      message: /sendMessage/,
    },
    {
      args: ["probe", "template", "--operation", "sendMessage", "--max-deltas", "2", "--json"],
      message: /--stream-evidence/,
    },
  ];

  for (const item of cases) {
    const stream = io();
    const result = await runProtocolPoolCli(item.args, {
      stdout: (line) => stream.stdout.push(line),
      stderr: (line) => stream.stderr.push(line),
    });

    assert.equal(result.exitCode, 2);
    assert.equal(stream.stdout.length, 0);
    assert.match(stream.stderr.join(""), item.message);
    assert.doesNotMatch(stream.stderr.join(""), /cookie|session|api[_-]?key|Bearer\s+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|rawPayload|prompt|user@example|token=|secret-token/i);
  }
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

  const useResetCouponStream = io();
  const useResetCoupon = await runProtocolPoolCli(["probe", "template", "--operation", "useResetCoupon", "--json"], {
    stdout: (line) => useResetCouponStream.stdout.push(line),
    stderr: (line) => useResetCouponStream.stderr.push(line),
  });

  assert.equal(useResetCoupon.exitCode, 0);
  assert.deepEqual(JSON.parse(useResetCouponStream.stdout.join("")), {
    confirmSideEffect: false,
    couponCode: "coupon-code",
    couponType: "weekly_reset_coupon",
    requestNo: "reset-coupon-use-probe",
  });
});

test("probe template for sendMessage defaults to stream capture input", async () => {
  const templateStream = io();
  const templateResult = await runProtocolPoolCli(["probe", "template", "--operation", "sendMessage", "--json"], {
    stdout: (line) => templateStream.stdout.push(line),
    stderr: (line) => templateStream.stderr.push(line),
  });

  assert.equal(templateResult.exitCode, 0);
  assert.equal(templateStream.stderr.length, 0);
  const template = JSON.parse(templateStream.stdout.join(""));
  assert.deepEqual(template, {
    model: "tabbit/priority",
    messages: [{ role: "user", content: "<redacted-message-content>" }],
    stream: true,
  });

  const validateStream = io();
  const validateResult = await runProtocolPoolCli([
    "probe", "validate",
    "--operation", "sendMessage",
    "--input-json", JSON.stringify(template),
    "--json",
  ], {
    stdout: (line) => validateStream.stdout.push(line),
    stderr: (line) => validateStream.stderr.push(line),
  });

  assert.equal(validateResult.exitCode, 0);
  assert.equal(validateStream.stderr.length, 0);
  const preview = JSON.parse(validateStream.stdout.join(""));
  assert.equal(preview.status, "valid");
  assert.equal(preview.operation, "sendMessage");
  assert.equal(preview.sideEffect, false);
  assert.equal(preview.fields.messages, "array");
  assert.equal(preview.fields.stream, true);

  const serialized = templateStream.stdout.join("") + validateStream.stdout.join("");
  assert.doesNotMatch(serialized, /cookie|session|token|api[_-]?key|Bearer\s+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|rawPayload|prompt|user@example/i);
  assert.doesNotMatch(serialized, /\bping\b/);
});

test("probe validate --operation sendMessage accepts streamEvidence capture options", async () => {
  const stream = io();
  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "sendMessage",
    "--input-json",
    JSON.stringify({
      model: "tabbit/priority",
      messages: [{ role: "user", content: "private prompt should not print" }],
      stream: true,
      streamEvidence: {
        mode: "first_token_backpressure",
        maxDeltas: 2,
      },
    }),
    "--json",
  ], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "valid");
  assert.equal(body.operation, "sendMessage");
  assert.deepEqual(body.sendMessageReview, {
    requiresReviewedInput: true,
    reviewRequirement: "replace_redacted_message_content",
    redactedMessageContentPresent: false,
    protocolDispatchReady: true,
  });
  assert.deepEqual(body.streamEvidence, {
    mode: "first_token_backpressure",
    maxDeltas: 2,
  });
  assert.doesNotMatch(stream.stdout.join(""), /private prompt/);
});

test("probe validate accepts sendMessage placeholder templates but protocol rejects them before dispatch", async () => {
  const template = {
    model: "tabbit/priority",
    messages: [{ role: "user", content: "<redacted-message-content>" }],
    stream: true,
  };
  const validateStream = io();
  const validateResult = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "sendMessage",
    "--input-json",
    JSON.stringify(template),
    "--json",
  ], {
    stdout: (line) => validateStream.stdout.push(line),
    stderr: (line) => validateStream.stderr.push(line),
  });

  assert.equal(validateResult.exitCode, 0);
  assert.equal(validateStream.stderr.length, 0);
  const validateBody = JSON.parse(validateStream.stdout.join(""));
  assert.equal(validateBody.status, "valid");
  assert.deepEqual(validateBody.sendMessageReview, {
    requiresReviewedInput: true,
    reviewRequirement: "replace_redacted_message_content",
    redactedMessageContentPresent: true,
    protocolDispatchReady: false,
  });
  assert.doesNotMatch(validateStream.stdout.join(""), /tabbit\/priority|<redacted-message-content>|cookie|session|token|Bearer|api[_-]?key/i);

  const protocolStream = io();
  const calls = [];
  const protocolResult = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_placeholder",
    "--operation",
    "sendMessage",
    "--input-json",
    JSON.stringify(template),
    "--write-fixture",
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("placeholder sendMessage input must be rejected before dispatch");
      },
    },
    stdout: (line) => protocolStream.stdout.push(line),
    stderr: (line) => protocolStream.stderr.push(line),
  });

  assert.equal(protocolResult.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(protocolStream.stdout.length, 0);
  assert.match(protocolStream.stderr.join(""), /replac.*redacted message content/i);
  assert.doesNotMatch(protocolStream.stderr.join(""), /tabbit\/priority|<redacted-message-content>|cookie|session|token|Bearer|api[_-]?key/i);
});

test("probe protocol rejects omitted sendMessage input before dispatch", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_placeholder",
    "--operation",
    "sendMessage",
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("omitted sendMessage input must be rejected before dispatch");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  assert.match(stream.stderr.join(""), /explicit reviewed messages/i);
  assert.doesNotMatch(stream.stderr.join(""), /tabbit\/priority|cookie|session|token|Bearer|api[_-]?key/i);
});

test("probe validate --operation sendMessage rejects invalid streamEvidence capture options", async () => {
  const invalidInputs = [
    {
      input: { streamEvidence: { mode: "full_raw_stream", maxDeltas: 2 } },
      message: /streamEvidence\.mode/,
    },
    {
      input: { streamEvidence: { mode: "first_token_backpressure", maxDeltas: 0 } },
      message: /streamEvidence\.maxDeltas/,
    },
    {
      input: { streamEvidence: { mode: "first_token_backpressure", maxDeltas: 6 } },
      message: /streamEvidence\.maxDeltas/,
    },
  ];

  for (const { input, message } of invalidInputs) {
    const stream = io();
    const result = await runProtocolPoolCli([
      "probe",
      "validate",
      "--operation",
      "sendMessage",
      "--input-json",
      JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "private prompt should not print" }],
        stream: true,
        ...input,
      }),
      "--json",
    ], {
      protocolProbeRunner: {
        async probeAccount() {
          throw new Error("probe validate must not run protocol probes");
        },
      },
      stdout: (line) => stream.stdout.push(line),
      stderr: (line) => stream.stderr.push(line),
    });

    assert.equal(result.exitCode, 2);
    assert.equal(stream.stdout.length, 0);
    assert.match(stream.stderr.join(""), message);
    assert.doesNotMatch(stream.stderr.join(""), /private prompt/);
  }
});

test("probe template prints auth inputs with confirmation disabled", async () => {
  const sendStream = io();
  const send = await runProtocolPoolCli(["probe", "template", "--operation", "sendVerificationCode", "--json"], {
    stdout: (line) => sendStream.stdout.push(line),
    stderr: (line) => sendStream.stderr.push(line),
  });
  const submitStream = io();
  const submit = await runProtocolPoolCli(["probe", "template", "--operation", "submitRegistrationOrLogin", "--json"], {
    stdout: (line) => submitStream.stdout.push(line),
    stderr: (line) => submitStream.stderr.push(line),
  });

  assert.equal(send.exitCode, 0);
  assert.equal(submit.exitCode, 0);
  const authUuid = "0000000000000000000000000000000000000000000000000000000000000000";
  assert.deepEqual(JSON.parse(sendStream.stdout.join("")), {
    confirmSideEffect: false,
    mobile: "10000000000",
    uuid: authUuid,
    body: { uuid: authUuid, platform: "1", version: "", app: "1000", mobile: "10000000000" },
  });
  assert.deepEqual(JSON.parse(submitStream.stdout.join("")), {
    confirmSideEffect: false,
    mobile: "10000000000",
    code: "000000",
    uuid: authUuid,
    body: { uuid: authUuid, platform: "1", version: "", app: "1000", mobile: "10000000000", smsCode: "000000" },
  });
  const serialized = sendStream.stdout.join("") + submitStream.stdout.join("");
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("cookie"), false);
  assert.equal(serialized.includes("session"), false);
});

test("probe validate accepts calibrated auth mobile input without email", async () => {
  const stream = io();
  const calls = [];
  const authUuid = "0000000000000000000000000000000000000000000000000000000000000000";
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-validate-auth-mobile-")), "auth-submit.json");
  await writeFile(inputFile, JSON.stringify({
    confirmSideEffect: true,
    mobile: "10000000000",
    code: "000000",
    uuid: authUuid,
    body: { uuid: authUuid, platform: "1", version: "", app: "1000", mobile: "10000000000", smsCode: "000000" },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "submitRegistrationOrLogin",
    "--input-file",
    inputFile,
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, []);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "valid");
  assert.equal(body.fields.mobile, "present");
  assert.equal(body.fields.email, "missing");
  assert.equal(body.fields.code, "present");
  assert.equal(body.fields.uuid, "present");
  assert.deepEqual(body.bodyKeys, ["app", "mobile", "platform", "smsCode", "uuid", "version"]);
  assert.doesNotMatch(text, /10000000000|0000000000000000000000000000000000000000000000000000000000000000|000000/);
});

test("probe template --operation recoverSession prints safe session recovery evidence input", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "recoverSession", "--json"], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.deepEqual(body, {
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      observedWindowMs: 86400000,
      resultHash: "sha256:<redacted-recovery-result>",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      expiredBeforeRecovery: true,
      recoveredVerifySession: true,
    },
  });
  const serialized = stream.stdout.join("");
  assert.doesNotMatch(serialized, /cookie|Bearer\s+|api[_-]?key|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|prompt|user@example/i);
});

test("probe template --operation consumeResetCoupon prints safe reset coupon consumption evidence input", async () => {
  const stream = io();
  const result = await runProtocolPoolCli(["probe", "template", "--operation", "consumeResetCoupon", "--json"], {
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.deepEqual(body, {
    kind: "reset_coupon_consumption_evidence",
    operation: "consumeResetCoupon",
    status: "success",
    evidence: {
      endpointHash: "sha256:<redacted-endpoint>",
      bodyHash: "sha256:<redacted-body>",
      resultHash: "sha256:<redacted-result>",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      resetCouponConsumed: true,
      consumeResult: "success",
    },
  });
  const serialized = stream.stdout.join("");
  assert.doesNotMatch(serialized, /cookie|Bearer\s+|api[_-]?key|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.|prompt|user@example/i);
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

test("accounts probe --read-only --json verifies without persisting account changes", async () => {
  const calls = [];
  const stream = io();
  const result = await runProtocolPoolCli(["accounts", "probe", "acct_b", "--read-only", "--json"], {
    accountStore: memoryStore(baseAccounts()),
    accountVerifier: {
      async verifyAccount(accountId, options = {}) {
        calls.push([accountId, options]);
        return {
          readOnly: Boolean(options.readOnly),
          changed: false,
          wouldChange: true,
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
            changed: false,
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
  assert.deepEqual(calls, [["acct_b", { readOnly: true }]]);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.readOnly, true);
  assert.equal(body.changed, false);
  assert.equal(body.wouldChange, true);
  assert.equal(body.account.status, "login_expired");
  assert.equal(body.account.cookieJarRef, undefined);
  assert.equal(body.account.token, undefined);
  assert.equal(body.events[0].error.message, "be***@example.test token=*** code ***");
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

test("default CLI dependencies can keep protocol fixtures in a separate writable directory", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-readonly-state-"));
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-writable-fixtures-"));
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_FIXTURE_DIR: fixtureDir,
    },
    now: () => Date.parse(NOW),
  });

  const ref = await deps.protocolFixtureStore.writeFixture({
    version: 1,
    kind: "protocol_probe",
    observedAt: NOW,
    operation: "dailySignIn",
    status: "success",
    result: { token: "secret-token", signInResult: "success" },
  });

  assert.equal(ref, "fixtures/protocol-probes/2026-07-02T030000000Z-account-dailySignIn.json");
  await assert.rejects(() => readFile(path.join(stateDir, ref), "utf8"), { code: "ENOENT" });
  const saved = await readFile(path.join(fixtureDir, "2026-07-02T030000000Z-account-dailySignIn.json"), "utf8");
  assert.equal(saved.includes("secret-token"), false);
  assert.deepEqual((await deps.protocolFixtureStore.listFixtures()).map((item) => item.ref), [ref]);
});

test("createProtocolPoolCliDependencies wires configured auth operations for AccountProvisioner", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-auth-wiring-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH: "/api/auth/send-code",
      TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH: "/api/auth/submit-code",
    },
    now: () => Date.parse("2026-07-04T02:00:00.000Z"),
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET", body: options.body || "" });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-auth");
      if (url.endsWith("/api/auth/send-code")) {
        return jsonResponse({ codeSent: true, deliveryResult: "sent" });
      }
      if (url.endsWith("/api/auth/submit-code")) {
        return jsonResponse({
          data: {
            cookie: "fixture-cookie",
            user_id: "user_auth_wired",
            access_tier: "free",
          },
        });
      }
      throw new Error("unexpected auth wiring request: " + url);
    },
  });
  const provisioner = new AccountProvisioner({
    accountStore: deps.accountStore,
    secretStore: deps.secretStore,
    protocolClient: deps.accountProtocolClient,
    idGenerator: () => "acct_auth_wired",
    now: () => new Date("2026-07-04T02:00:00.000Z"),
    mailProvider: {
      async createInbox() {
        return { id: "inbox_auth_wired", address: "auth-wired@example.test" };
      },
      async waitForVerificationCode() {
        return { code: "654321" };
      },
    },
  });

  const result = await provisioner.createAccount({
    authSendCodeBody: { email_address: "auth-wired@example.test", scene: "login" },
    authSubmitCodeBody: { email_address: "auth-wired@example.test", verify_code: "654321" },
  });

  assert.equal(result.account.status, "active");
  assert.equal(result.account.userId, "user_auth_wired");
  assert.equal(result.account.accessTier, "free");
  assert.deepEqual(result.actions.map((item) => [item.name, item.status]), [
    ["createInbox", "success"],
    ["sendVerificationCode", "success"],
    ["waitForVerificationCode", "success"],
    ["submitRegistrationOrLogin", "success"],
    ["saveSession", "success"],
  ]);
  assert.equal(await deps.secretStore.readSecret("secrets/acct_auth_wired.cookie"), "fixture-cookie");
  assert.deepEqual(calls.map((call) => call.url).filter((url) => url.includes("/api/auth/")), [
    "https://web.tabbit.ai/api/auth/send-code",
    "https://web.tabbit.ai/api/auth/submit-code",
  ]);
  const serializedResult = JSON.stringify(result);
  assert.equal(serializedResult.includes("tabbit_session=auth-wired-secret"), false);
  assert.equal(serializedResult.includes("654321"), false);
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
  await deps.secretStore.writeSecret("secrets/acct_sign_in_status_env.cookie", "tabbit_session=sin");

  const result = await deps.benefitsMaintainer.maintainAllAccounts();

  assert.equal(result.changed, true);
  assert.equal(result.accounts[0].lastCheckinAt, "2026-07-03T09:45:00.000Z");
  assert.equal(result.results[0].actions.find((item) => item.name === "dailyCheckin")?.status, "success");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/activity/v1/sign-in/status?scene_codes=desktop_pet");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=sin");
  assert.equal(JSON.stringify(result).includes("tabbit_session=sin"), false);
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
  assert.equal(result.fixture.result.userId, "***");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=probe-env");
  assert.equal(JSON.stringify(result).includes("tabbit_session=probe-env"), false);
  assert.equal(JSON.stringify(result).includes("user_probe"), false);
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

test("configured reset coupon use env wires protocol probe runner with explicit confirmation", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-pool-reset-coupon-use-env-"));
  const calls = [];
  const deps = createProtocolPoolCliDependencies({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_USE_PATH: "/api/commerce/benefit/v1/coupon/use",
    },
    now: () => 1700000000000,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        coupon_result: "success",
        used: true,
      });
    },
  });
  await deps.accountStore.saveAccounts([{
    id: "acct_reset_coupon_use_probe",
    status: "active",
    userId: "user_reset_coupon_use",
    cookieJarRef: "secrets/acct_reset_coupon_use_probe.cookie",
  }]);
  await deps.secretStore.writeSecret("secrets/acct_reset_coupon_use_probe.cookie", "tabbit_session=reset-coupon-use");

  const result = await deps.protocolProbeRunner.probeAccount({
    accountId: "acct_reset_coupon_use_probe",
    operation: "useResetCoupon",
    input: {
      confirmSideEffect: true,
      couponCode: "coupon-code",
      couponType: "weekly_reset_coupon",
      requestNo: "reset-coupon-use-probe",
    },
  });

  assert.equal(result.status, "success");
  assert.equal(result.fixture.operation, "useResetCoupon");
  assert.equal(result.fixture.result.source, "tabbit-reset-coupon-use");
  assert.equal(result.fixture.result.evidence.safe, true);
  assert.equal(result.fixture.result.evidence.sanitized, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/benefit/v1/coupon/use");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=reset-coupon-use");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    user_id: "user_reset_coupon_use",
    coupon_code: "coupon-code",
    coupon_type: "weekly_reset_coupon",
    request_no: "reset-coupon-use-probe",
  });
  assert.equal(JSON.stringify(result).includes("tabbit_session=reset-coupon-use"), false);
});


test("probe validate --json validates auth input without leaking values", async () => {
  const stream = io();
  const calls = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-validate-")), "auth-submit.json");
  await writeFile(inputFile, JSON.stringify({
    confirmSideEffect: true,
    email: "real-user@example.test",
    code: "654321",
    body: {
      email: "real-user@example.test",
      code: "654321",
      scene: "registration",
      captchaToken: "captcha-secret-value",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "submitRegistrationOrLogin",
    "--input-file",
    inputFile,
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, []);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "valid");
  assert.equal(body.operation, "submitRegistrationOrLogin");
  assert.equal(body.source, "input");
  assert.equal(body.sideEffect, true);
  assert.equal(body.confirmSideEffect, true);
  assert.equal(body.fields.email, "present");
  assert.equal(body.fields.code, "present");
  assert.equal(body.fields.body, "object");
  assert.deepEqual(body.bodyKeys, ["captchaToken", "code", "email", "scene"]);
  assert.doesNotMatch(text, /real-user@example\.test|654321|captcha-secret-value/);
  assert.doesNotMatch(text, /cookie|session|secret-value/);
});

test("probe validate rejects invalid auth input before touching dependencies", async () => {
  const stream = io();
  const calls = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-validate-invalid-")), "auth-submit.json");
  await writeFile(inputFile, JSON.stringify({
    confirmSideEffect: "yes",
    email: "invalid-user@example.test",
    code: "987654",
    body: {
      email: "invalid-user@example.test",
      code: "987654",
      scene: "registration",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "submitRegistrationOrLogin",
    "--input-file",
    inputFile,
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  const errorText = stream.stderr.join("");
  assert.match(errorText, /confirmSideEffect.*boolean/);
  assert.doesNotMatch(errorText, /invalid-user@example\.test|987654|registration/);
});

test("probe validate --require-confirmed-side-effect rejects unconfirmed side-effect input", async () => {
  const stream = io();
  const calls = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-validate-confirm-")), "auth-send.json");
  await writeFile(inputFile, JSON.stringify({
    confirmSideEffect: false,
    email: "unconfirmed-user@example.test",
    body: {
      email: "unconfirmed-user@example.test",
      scene: "registration",
      captchaToken: "synthetic-captcha-value",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "sendVerificationCode",
    "--input-file",
    inputFile,
    "--require-confirmed-side-effect",
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  const errorText = stream.stderr.join("");
  assert.match(errorText, /confirmSideEffect:true/);
  assert.doesNotMatch(errorText, /unconfirmed-user@example\.test|registration|synthetic-captcha-value/);
});

test("probe validate --operation useResetCoupon enforces confirmation and calibrated fields", async () => {
  const stream = io();
  const calls = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-use-reset-coupon-")), "use-reset-coupon.json");
  await writeFile(inputFile, JSON.stringify({
    confirmSideEffect: false,
    couponCode: "coupon-code",
    couponType: "weekly_reset_coupon",
    requestNo: "reset-coupon-use-probe",
  }), "utf8");

  const rejected = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "useResetCoupon",
    "--input-file",
    inputFile,
    "--require-confirmed-side-effect",
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(rejected.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  assert.match(stream.stderr.join(""), /confirmSideEffect:true/);

  await writeFile(inputFile, JSON.stringify({
    confirmSideEffect: true,
    couponCode: "coupon-code",
    couponType: "weekly_reset_coupon",
    requestNo: "reset-coupon-use-probe",
  }), "utf8");
  const acceptedStream = io();
  const accepted = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "useResetCoupon",
    "--input-file",
    inputFile,
    "--require-confirmed-side-effect",
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => acceptedStream.stdout.push(line),
    stderr: (line) => acceptedStream.stderr.push(line),
  });

  assert.equal(accepted.exitCode, 0);
  assert.deepEqual(calls, []);
  assert.equal(acceptedStream.stderr.length, 0);
  const body = JSON.parse(acceptedStream.stdout.join(""));
  assert.equal(body.status, "valid");
  assert.equal(body.sideEffect, true);
  assert.equal(body.fields.couponCode, "present");
  assert.equal(body.fields.couponType, "present");
  assert.equal(body.fields.requestNo, "present");
});

test("probe validate --require-confirmed-side-effect allows read-only operations", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "verifySession",
    "--require-confirmed-side-effect",
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, []);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "valid");
  assert.equal(body.operation, "verifySession");
  assert.equal(body.sideEffect, false);
});

test("probe validate --operation recoverSession validates offline evidence without leaking values", async () => {
  const stream = io();
  const calls = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-recover-session-")), "recover-session.json");
  await writeFile(inputFile, JSON.stringify({
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      observedWindowMs: 86400000,
      resultHash: "sha256:recovery-result-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      expiredBeforeRecovery: true,
      recoveredVerifySession: true,
    },
    ignoredRaw: {
      cookie: "<raw-cookie-redacted>",
      prompt: "placeholder prompt should stay hidden",
      recoveredValue: "placeholder-recovered-value",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "recoverSession",
    "--input-file",
    inputFile,
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, []);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "valid");
  assert.equal(body.operation, "recoverSession");
  assert.equal(body.sideEffect, false);
  assert.equal(body.fields.kind, "present");
  assert.equal(body.fields.status, "present");
  assert.equal(body.fields.evidence, "object");
  assert.deepEqual(body.evidenceKeys, ["automatedRefresh", "observedWindowMs", "rawPayload", "resultHash", "safe", "sanitized", "strategy"]);
  assert.deepEqual(body.sessionRecovery, {
    strategy: "automated_reauth",
    automatedRefresh: "calibrated_reauth_probe",
    observedWindowMs: true,
    resultHash: true,
    safe: true,
    sanitized: true,
    rawPayload: false,
    expiredBeforeRecovery: true,
    recoveredVerifySession: true,
  });
  assert.doesNotMatch(text, /tabbit_session=secret|placeholder prompt|placeholder-recovered-value/);
});

test("probe validate --operation recoverSession rejects marker-only evidence", async () => {
  const stream = io();
  const calls = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-recover-session-marker-only-")), "recover-session.json");
  await writeFile(inputFile, JSON.stringify({
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    ignoredRaw: {
      cookie: "<raw-cookie-redacted>",
      prompt: "unsafe placeholder prompt",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "recoverSession",
    "--input-file",
    inputFile,
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  const errorText = stream.stderr.join("");
  assert.match(errorText, /observedWindowMs/);
  assert.match(errorText, /resultHash/);
  assert.match(errorText, /post-recovery verifySession/);
  assert.doesNotMatch(errorText, /tabbit_session=secret|unsafe placeholder prompt/);
});

test("probe validate --operation recoverSession rejects unsafe evidence before touching dependencies", async () => {
  const stream = io();
  const calls = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-recover-session-invalid-")), "recover-session.json");
  await writeFile(inputFile, JSON.stringify({
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      safe: true,
      sanitized: true,
      rawPayload: true,
    },
    ignoredRaw: {
      prompt: "unsafe placeholder prompt",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "recoverSession",
    "--input-file",
    inputFile,
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  const errorText = stream.stderr.join("");
  assert.match(errorText, /rawPayload:false/);
  assert.doesNotMatch(errorText, /unsafe placeholder prompt/);
});

test("probe validate --operation recoverSession requires explicit evidence input", async () => {
  const stream = io();
  const calls = [];

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "recoverSession",
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  assert.match(stream.stderr.join(""), /requires explicit sanitized evidence input/);
});

test("probe validate --operation consumeResetCoupon validates offline evidence without leaking values", async () => {
  const stream = io();
  const calls = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-consume-reset-coupon-")), "consume-reset-coupon.json");
  await writeFile(inputFile, JSON.stringify({
    kind: "reset_coupon_consumption_evidence",
    operation: "consumeResetCoupon",
    status: "success",
    evidence: {
      endpointHash: "sha256:endpoint-private-shape",
      bodyHash: "sha256:body-private-shape",
      resultHash: "sha256:result-private-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      resetCouponConsumed: true,
      consumeResult: "success",
    },
    ignoredRaw: {
      cookie: "tabbit_session=secret",
      prompt: "placeholder prompt should stay hidden",
      payload: "raw endpoint/body/result payload should stay hidden",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "consumeResetCoupon",
    "--input-file",
    inputFile,
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(calls, []);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "valid");
  assert.equal(body.operation, "consumeResetCoupon");
  assert.equal(body.sideEffect, false);
  assert.equal(body.fields.kind, "present");
  assert.equal(body.fields.status, "present");
  assert.equal(body.fields.evidence, "object");
  assert.deepEqual(body.evidenceKeys, ["bodyHash", "endpointHash", "rawPayload", "resultHash", "safe", "sanitized"]);
  assert.deepEqual(body.resetCouponConsumption, {
    endpointHash: true,
    bodyHash: true,
    resultHash: true,
    safe: true,
    sanitized: true,
    rawPayload: false,
    consumptionSignal: true,
    nonConsumptionSignal: false,
  });
  assert.doesNotMatch(text, /endpoint-private-shape|body-private-shape|result-private-shape|tabbit_session=secret|placeholder prompt|raw endpoint\/body\/result payload/);
});

test("probe validate --operation consumeResetCoupon rejects unsafe or non-consumption evidence before touching dependencies", async () => {
  const cases = [
    {
      name: "missing-hash",
      input: {
        kind: "reset_coupon_consumption_evidence",
        operation: "consumeResetCoupon",
        status: "success",
        evidence: {
          endpointHash: "sha256:endpoint-private-shape",
          bodyHash: "sha256:body-private-shape",
          safe: true,
          sanitized: true,
          rawPayload: false,
        },
        result: { resetCouponConsumed: true },
      },
      expected: /endpointHash, bodyHash, and resultHash/,
    },
    {
      name: "raw-payload",
      input: {
        kind: "reset_coupon_consumption_evidence",
        operation: "consumeResetCoupon",
        status: "success",
        evidence: {
          endpointHash: "sha256:endpoint-private-shape",
          bodyHash: "sha256:body-private-shape",
          resultHash: "sha256:result-private-shape",
          safe: true,
          sanitized: true,
          rawPayload: true,
        },
        result: { resetCouponConsumed: true },
      },
      expected: /rawPayload:false/,
    },
    {
      name: "already-participated",
      input: {
        kind: "reset_coupon_consumption_evidence",
        operation: "consumeResetCoupon",
        status: "success",
        evidence: {
          endpointHash: "sha256:endpoint-private-shape",
          bodyHash: "sha256:body-private-shape",
          resultHash: "sha256:result-private-shape",
          safe: true,
          sanitized: true,
          rawPayload: false,
        },
        result: {
          resetCouponConsumed: true,
          consumeResult: "already_participated",
        },
      },
      expected: /non-consumption/,
    },
  ];

  for (const item of cases) {
    const stream = io();
    const calls = [];
    const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-consume-reset-coupon-invalid-")), item.name + ".json");
    await writeFile(inputFile, JSON.stringify({
      ...item.input,
      ignoredRaw: {
        cookie: "tabbit_session=secret",
        prompt: "unsafe placeholder prompt",
      },
    }), "utf8");

    const result = await runProtocolPoolCli([
      "probe",
      "validate",
      "--operation",
      "consumeResetCoupon",
      "--input-file",
      inputFile,
      "--json",
    ], {
      accountStore: {
        async loadAccounts() {
          calls.push("loadAccounts");
          throw new Error("probe validate must not read accounts");
        },
      },
      secretStore: {
        async readSecret() {
          calls.push("readSecret");
          throw new Error("probe validate must not read secrets");
        },
      },
      protocolFixtureStore: {
        async listFixtures() {
          calls.push("listFixtures");
          throw new Error("probe validate must not read fixtures");
        },
      },
      protocolProbeRunner: {
        async probeAccount() {
          calls.push("probeAccount");
          throw new Error("probe validate must not run protocol probes");
        },
      },
      stdout: (line) => stream.stdout.push(line),
      stderr: (line) => stream.stderr.push(line),
    });

    assert.equal(result.exitCode, 2, item.name);
    assert.deepEqual(calls, [], item.name);
    assert.equal(stream.stdout.length, 0, item.name);
    const errorText = stream.stderr.join("");
    assert.match(errorText, item.expected, item.name);
    assert.doesNotMatch(errorText, /tabbit_session=secret|unsafe placeholder prompt|endpoint-private-shape|body-private-shape|result-private-shape/, item.name);
  }
});

test("probe validate --operation consumeResetCoupon requires explicit evidence input", async () => {
  const stream = io();
  const calls = [];

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "consumeResetCoupon",
    "--json",
  ], {
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate must not read fixtures");
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  assert.match(stream.stderr.join(""), /requires explicit sanitized reset coupon consumption evidence input/);
});

test("probe validate --write-fixture persists recoverSession offline evidence without reading runtime state", async () => {
  const stream = io();
  const calls = [];
  const written = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-recover-session-write-")), "recover-session.json");
  await writeFile(inputFile, JSON.stringify({
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      observedWindowMs: 86400000,
      resultHash: "sha256:recovery-result-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      expiredBeforeRecovery: true,
      recoveredVerifySession: true,
    },
    ignoredRaw: {
      cookie: "tabbit_session=secret",
      token: "secret-token",
      prompt: "placeholder prompt should not be stored",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "recoverSession",
    "--input-file",
    inputFile,
    "--write-fixture",
    "--json",
  ], {
    now: () => Date.parse("2026-07-04T04:00:00.000Z"),
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate --write-fixture must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate --write-fixture must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate --write-fixture must not read fixtures");
      },
      async readFixture() {
        calls.push("readFixture");
        throw new Error("probe validate --write-fixture must not read fixture bodies");
      },
      async writeFixture(fixture) {
        calls.push("writeFixture");
        written.push(fixture);
        return "fixtures/protocol-probes/recover-session.json";
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate --write-fixture must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["writeFixture"]);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(written, [{
    kind: "session_recovery_strategy",
    observedAt: "2026-07-04T04:00:00.000Z",
    operation: "recoverSession",
    status: "success",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      observedWindowMs: 86400000,
      resultHash: "sha256:recovery-result-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      expiredBeforeRecovery: true,
      recoveredVerifySession: true,
    },
  }]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "valid");
  assert.equal(body.operation, "recoverSession");
  assert.equal(body.fixtureRef, "fixtures/protocol-probes/recover-session.json");
  assert.equal(body.fixture.operation, "recoverSession");
  assert.equal(body.fixture.kind, "session_recovery_strategy");
  assert.doesNotMatch(text, /tabbit_session=secret|secret-token|placeholder prompt/);
});

test("probe validate --write-fixture persists consumeResetCoupon evidence without leaking hash values", async () => {
  const stream = io();
  const calls = [];
  const written = [];
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-consume-reset-coupon-write-")), "consume-reset-coupon.json");
  await writeFile(inputFile, JSON.stringify({
    kind: "reset_coupon_consumption_evidence",
    operation: "consumeResetCoupon",
    status: "success",
    evidence: {
      endpointHash: "sha256:endpoint-private-shape",
      bodyHash: "sha256:body-private-shape",
      resultHash: "sha256:result-private-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      resetCouponConsumed: true,
      consumeResult: "success",
    },
    ignoredRaw: {
      cookie: "tabbit_session=secret",
      payload: "raw endpoint/body/result payload should not be stored",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "consumeResetCoupon",
    "--input-file",
    inputFile,
    "--write-fixture",
    "--json",
  ], {
    now: () => Date.parse("2026-07-04T04:05:00.000Z"),
    accountStore: {
      async loadAccounts() {
        calls.push("loadAccounts");
        throw new Error("probe validate --write-fixture must not read accounts");
      },
    },
    secretStore: {
      async readSecret() {
        calls.push("readSecret");
        throw new Error("probe validate --write-fixture must not read secrets");
      },
    },
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        throw new Error("probe validate --write-fixture must not read fixtures");
      },
      async readFixture() {
        calls.push("readFixture");
        throw new Error("probe validate --write-fixture must not read fixture bodies");
      },
      async writeFixture(fixture) {
        calls.push("writeFixture");
        written.push(fixture);
        return "fixtures/protocol-probes/consume-reset-coupon.json";
      },
    },
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("probe validate --write-fixture must not run protocol probes");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, ["writeFixture"]);
  assert.equal(stream.stderr.length, 0);
  assert.deepEqual(written, [{
    kind: "reset_coupon_consumption_evidence",
    observedAt: "2026-07-04T04:05:00.000Z",
    operation: "consumeResetCoupon",
    status: "success",
    evidence: {
      endpointHash: "sha256:endpoint-private-shape",
      bodyHash: "sha256:body-private-shape",
      resultHash: "sha256:result-private-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      resetCouponConsumed: true,
      consumeResult: "success",
    },
  }]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.status, "valid");
  assert.equal(body.operation, "consumeResetCoupon");
  assert.equal(body.fixtureRef, "fixtures/protocol-probes/consume-reset-coupon.json");
  assert.equal(body.fixture.operation, "consumeResetCoupon");
  assert.equal(body.fixture.kind, "reset_coupon_consumption_evidence");
  assert.deepEqual(body.fixture.evidence, {
    endpointHash: true,
    bodyHash: true,
    resultHash: true,
    safe: true,
    sanitized: true,
    rawPayload: false,
  });
  assert.doesNotMatch(text, /endpoint-private-shape|body-private-shape|result-private-shape|tabbit_session=secret|raw endpoint\/body\/result payload/);
});

test("probe validate --write-fixture rejects non-offline evidence operations before touching fixture store", async () => {
  const stream = io();
  const calls = [];

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "sendMessage",
    "--input-json",
    JSON.stringify({ model: "tabbit/priority", messages: [{ role: "user", content: "ping" }] }),
    "--write-fixture",
    "--json",
  ], {
    protocolFixtureStore: {
      async writeFixture() {
        calls.push("writeFixture");
        throw new Error("probe validate --write-fixture must reject before writing non-offline evidence");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  assert.match(stream.stderr.join(""), /offline evidence/i);
  assert.doesNotMatch(stream.stderr.join(""), /ping|tabbit\/priority/);
});

test("probe validate --write-fixture prints plain offline fixture refs without raw evidence", async () => {
  const stream = io();
  const inputFile = path.join(await mkdtemp(path.join(tmpdir(), "tabbit-probe-recover-session-write-plain-")), "recover-session.json");
  await writeFile(inputFile, JSON.stringify({
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      observedWindowMs: 86400000,
      resultHash: "sha256:recovery-result-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      expiredBeforeRecovery: true,
      recoveredVerifySession: true,
    },
    ignoredRaw: {
      cookie: "tabbit_session=secret",
    },
  }), "utf8");

  const result = await runProtocolPoolCli([
    "probe",
    "validate",
    "--operation",
    "recoverSession",
    "--input-file",
    inputFile,
    "--write-fixture",
  ], {
    now: () => Date.parse("2026-07-04T04:10:00.000Z"),
    protocolFixtureStore: {
      async writeFixture() {
        return "fixtures/protocol-probes/recover-session-plain.json";
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  assert.match(text, /^status\tvalid/m);
  assert.match(text, /^operation\trecoverSession/m);
  assert.match(text, /^fixture_ref\tfixtures\/protocol-probes\/recover-session-plain\.json/m);
  assert.doesNotMatch(text, /tabbit_session=secret|automated_reauth|calibrated_reauth_probe/);
});

test("probe protocol --operation recoverSession rejects offline evidence dispatch", async () => {
  const stream = io();
  const calls = [];
  const input = {
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      observedWindowMs: 86400000,
      resultHash: "sha256:recovery-result-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      expiredBeforeRecovery: true,
      recoveredVerifySession: true,
    },
  };

  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_recover_session",
    "--operation",
    "recoverSession",
    "--input-json",
    JSON.stringify(input),
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("recoverSession must stay offline");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  assert.match(stream.stderr.join(""), /offline evidence/i);
});

test("probe protocol --operation consumeResetCoupon rejects offline evidence dispatch", async () => {
  const stream = io();
  const calls = [];
  const input = {
    kind: "reset_coupon_consumption_evidence",
    operation: "consumeResetCoupon",
    status: "success",
    evidence: {
      endpointHash: "sha256:endpoint-private-shape",
      bodyHash: "sha256:body-private-shape",
      resultHash: "sha256:result-private-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      resetCouponConsumed: true,
      consumeResult: "success",
    },
  };

  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_consume_reset_coupon",
    "--operation",
    "consumeResetCoupon",
    "--input-json",
    JSON.stringify(input),
    "--json",
  ], {
    protocolProbeRunner: {
      async probeAccount() {
        calls.push("probeAccount");
        throw new Error("consumeResetCoupon must stay offline");
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  assert.match(stream.stderr.join(""), /offline evidence/i);
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

test("probe protocol --json sanitizes runner output before printing", async () => {
  const stream = io();
  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "sendMessage",
    "--input-json",
    JSON.stringify({
      model: "tabbit/priority",
      messages: [{ role: "user", content: "private prompt should not print" }],
      stream: true,
    }),
    "--json",
  ], {
    accountStore: memoryStore(baseAccounts()),
    protocolProbeRunner: {
      async probeAccount(input) {
        return {
          status: "success",
          advice: { category: "unknown", severity: "info", recommendation: "ok" },
          fixtureRef: "fixtures/protocol-probes/live.json",
          fixture: {
            version: 1,
            kind: "protocol_probe",
            operation: input.operation,
            status: "success",
            input: {
              messages: [{ role: "user", content: "private prompt should not print" }],
              body: { prompt: "nested private prompt should not print" },
            },
            result: {
              content: "private assistant text should not print",
              streamDeltas: ["private", " stream", " text"],
              raw: {
                events: [{ event: "message", data: "private SSE data should not print" }],
              },
            },
          },
          rawDebug: {
            authorization: "Bearer abc",
            cookieHeader: "session=abc",
            session: "raw-session",
          },
        };
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const body = JSON.parse(stream.stdout.join(""));
  assert.equal(body.status, "success");
  assert.equal(body.fixtureRef, "fixtures/protocol-probes/live.json");
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /private prompt|nested private prompt|private assistant|private SSE data/);
  assert.doesNotMatch(serialized, /Bearer abc|session=abc|raw-session/);
  assert.equal(body.fixture.input.messages[0].content, "***");
  assert.deepEqual(body.fixture.result.streamDeltas, ["***", "***", "***"]);
  assert.equal(body.rawDebug.authorization, "***");
  assert.equal(body.rawDebug.cookieHeader, "***");
  assert.equal(body.rawDebug.session, "***");
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

test("probe protocol --input-json passes valid auth probe input to the runner", async () => {
  const calls = [];
  const stream = io();
  const probeInput = {
    email: "new-user@example.test",
    code: "000000",
    body: { email: "new-user@example.test", code: "000000" },
    confirmSideEffect: true,
  };

  const result = await runProtocolPoolCli([
    "probe",
    "protocol",
    "--account",
    "acct_a",
    "--operation",
    "submitRegistrationOrLogin",
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
    operation: "submitRegistrationOrLogin",
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

test("probe protocol rejects invalid auth probe input before calling the runner", async () => {
  const cases = [
    {
      operation: "sendVerificationCode",
      payload: { email: "", confirmSideEffect: true, token: "secret-token", code: "123456" },
      pattern: /email/i,
    },
    {
      operation: "sendVerificationCode",
      payload: { email: "new-user@example.test", confirmSideEffect: "yes" },
      pattern: /confirmSideEffect/i,
    },
    {
      operation: "sendVerificationCode",
      payload: { email: "new-user@example.test", body: [], confirmSideEffect: true },
      pattern: /body/i,
    },
    {
      operation: "submitRegistrationOrLogin",
      payload: { email: "new-user@example.test", confirmSideEffect: true, code: "" },
      pattern: /code/i,
    },
  ];

  for (const item of cases) {
    const stream = io();
    const calls = [];
    const rawPayload = JSON.stringify(item.payload);
    const result = await runProtocolPoolCli([
      "probe",
      "protocol",
      "--account",
      "acct_a",
      "--operation",
      item.operation,
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
    assert.match(stderr, item.pattern);
    assert.equal(stderr.includes("new-user@example.test"), false);
    assert.equal(stderr.includes("secret-token"), false);
    assert.equal(stderr.includes("123456"), false);
    assert.equal(stderr.includes(rawPayload), false);
  }
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

test("fixtures audit --scope auth reports auth evidence coverage", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/auth-send.json", {
      operation: "sendVerificationCode",
      status: "success",
      input: { email: "new-user@example.test" },
      result: { ok: true, raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/auth-submit.json", {
      operation: "submitRegistrationOrLogin",
      status: "success",
      input: { email: "new-user@example.test", code: "123456" },
      result: { ok: true, userId: "user_without_session" },
    }],
    ["fixtures/protocol-probes/send-message.json", {
      operation: "sendMessage",
      status: "success",
      result: { content: "unrelated auth audit fixture" },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "auth", "--json"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/auth-send.json",
    "readFixture:fixtures/protocol-probes/auth-submit.json",
  ]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.scope, "auth");
  assert.equal(body.status, "blocked");
  assert.equal(body.counts.successfulSendVerificationCode, 1);
  assert.equal(body.counts.successfulSendVerificationCodeWithDeliverySignal, 0);
  assert.equal(body.coverage.authSendVerificationCode.count, 0);
  assert.equal(body.counts.successfulSubmitRegistrationOrLogin, 1);
  assert.equal(body.counts.successfulSubmitRegistrationOrLoginWithSessionMaterial, 0);
  assert.equal(body.coverage.authSubmitRegistrationOrLogin.count, 0);
  assert.deepEqual(body.missing, ["successful_sendVerificationCode_fixture", "successful_submitRegistrationOrLogin_fixture"]);
  assert.doesNotMatch(text, /new-user@example.test|secret-token|123456|user_without_session|unrelated auth audit fixture/);
});

test("fixtures audit --scope auth prints transport and strict evidence counts in plain output", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/auth-send.json", {
      operation: "sendVerificationCode",
      status: "success",
      input: { email: "new-user@example.test" },
      result: { ok: true, raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/auth-submit.json", {
      operation: "submitRegistrationOrLogin",
      status: "success",
      input: { email: "new-user@example.test", code: "123456" },
      result: { ok: true, userId: "user_without_session" },
    }],
    ["fixtures/protocol-probes/send-message.json", {
      operation: "sendMessage",
      status: "success",
      result: { content: "unrelated auth audit fixture" },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "auth"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/auth-send.json",
    "readFixture:fixtures/protocol-probes/auth-submit.json",
  ]);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  assert.match(text, /^status\tblocked/m);
  assert.match(text, /^successful_sendVerificationCode_fixture\tmissing\t0/m);
  assert.match(text, /^sendVerificationCode_transport_success\t1/m);
  assert.match(text, /^sendVerificationCode_delivery_success\t0/m);
  assert.match(text, /^submitRegistrationOrLogin_transport_success\t1/m);
  assert.match(text, /^submitRegistrationOrLogin_session_material_success\t0/m);
  assert.match(text, /^missing\tsuccessful_sendVerificationCode_fixture,successful_submitRegistrationOrLogin_fixture/m);
  assert.doesNotMatch(text, /new-user@example.test|secret-token|123456|user_without_session|unrelated auth audit fixture/);
});

test("fixtures audit --scope benefits reports side-effect evidence coverage", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/daily-sign-in.json", {
      operation: "dailySignIn",
      status: "success",
      input: { email: "benefit-user@example.test", requestNo: "request-123456" },
      result: { signInResult: "already_signed", raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/reset-activity.json", {
      operation: "participateResetCouponActivity",
      status: "success",
      input: { payload: { request_no: "reset-123456" } },
      result: { participationResult: "already_participated", activityId: 10001 },
    }],
    ["fixtures/protocol-probes/reset-activity-consumed-looking.json", {
      operation: "participateResetCouponActivity",
      status: "success",
      input: { payload: { user_id: "synthetic-user", request_no: "reset-abcdef" } },
      result: { resetCouponConsumed: true, consumeResult: "success", couponConsumed: true, raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/pro-activity.json", {
      operation: "participateActivity",
      status: "failed",
      input: { body: { prompt: "synthetic private prompt" } },
      error: { category: "forbidden", message: "benefit-user@example.test token=secret" },
    }],
    ["fixtures/protocol-probes/pro-activity-generic-success.json", {
      operation: "participateActivity",
      status: "success",
      input: { body: { userId: "synthetic-user", prompt: "private pro prompt" } },
      result: { ok: true, status: "success", result: "success", raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/lottery-draw.json", {
      operation: "drawLottery",
      status: "failed",
      input: { body: { activityId: "lottery-123456" } },
      error: { category: "quota_exhausted", message: "no chance for benefit-user@example.test" },
    }],
    ["fixtures/protocol-probes/lottery-draw-generic-success.json", {
      operation: "drawLottery",
      status: "success",
      input: { body: { userId: "synthetic-user", prompt: "private lottery prompt" } },
      result: { status: "success", result: "success", ok: true, raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/send-message.json", {
      operation: "sendMessage",
      status: "success",
      result: { content: "unrelated benefits audit fixture token=secret" },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "benefits", "--json"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/daily-sign-in.json",
    "readFixture:fixtures/protocol-probes/reset-activity.json",
    "readFixture:fixtures/protocol-probes/reset-activity-consumed-looking.json",
    "readFixture:fixtures/protocol-probes/pro-activity.json",
    "readFixture:fixtures/protocol-probes/pro-activity-generic-success.json",
    "readFixture:fixtures/protocol-probes/lottery-draw.json",
    "readFixture:fixtures/protocol-probes/lottery-draw-generic-success.json",
  ]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.scope, "benefits");
  assert.equal(body.status, "blocked");
  assert.equal(body.counts.total, 7);
  assert.equal(body.counts.success, 5);
  assert.equal(body.counts.failed, 2);
  assert.equal(body.counts.participateResetCouponActivity, 2);
  assert.equal(body.counts.participateActivity, 2);
  assert.equal(body.counts.drawLottery, 2);
  assert.equal(body.counts.successfulProActivity, 0);
  assert.equal(body.counts.successfulResetCouponConsumption, 0);
  assert.equal(body.counts.successfulLotteryDraw, 0);
  assert.equal(body.coverage.dailySignIn.count, 1);
  assert.equal(body.coverage.proActivitySuccess.count, 0);
  assert.equal(body.coverage.resetCouponConsumption.count, 0);
  assert.equal(body.coverage.lotteryDrawSuccess.count, 0);
  assert.deepEqual(body.missing, [
    "successful_pro_activity_fixture",
    "successful_reset_coupon_consumption_fixture",
    "successful_lottery_draw_fixture",
  ]);
  assert.doesNotMatch(text, /benefit-user@example.test|secret-token|token=secret|synthetic private prompt|private pro prompt|private lottery prompt|request-123456|synthetic-user|reset-abcdef|unrelated benefits audit fixture/);
});

test("fixtures audit --scope benefits prints strict side-effect counts in plain output", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/daily-sign-in.json", {
      operation: "dailySignIn",
      status: "success",
      input: { email: "benefit-user@example.test", requestNo: "request-123456" },
      result: { signInResult: "success", signedToday: true, raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/reset-activity-consumed-looking.json", {
      operation: "participateResetCouponActivity",
      status: "success",
      input: { payload: { user_id: "synthetic-user", request_no: "reset-abcdef" } },
      result: { resetCouponConsumed: true, consumeResult: "success", couponConsumed: true, raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/pro-activity-generic-success.json", {
      operation: "participateActivity",
      status: "success",
      input: { body: { userId: "synthetic-user", prompt: "private pro prompt" } },
      result: { ok: true, status: "success", result: "success", raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/lottery-draw-generic-success.json", {
      operation: "drawLottery",
      status: "success",
      input: { body: { userId: "synthetic-user", prompt: "private lottery prompt" } },
      result: { status: "success", result: "success", ok: true, raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/send-message.json", {
      operation: "sendMessage",
      status: "success",
      result: { content: "unrelated benefits audit fixture token=secret" },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "benefits"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/daily-sign-in.json",
    "readFixture:fixtures/protocol-probes/reset-activity-consumed-looking.json",
    "readFixture:fixtures/protocol-probes/pro-activity-generic-success.json",
    "readFixture:fixtures/protocol-probes/lottery-draw-generic-success.json",
  ]);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  assert.match(text, /^status\tblocked/m);
  assert.match(text, /^dailySignIn\t1/m);
  assert.match(text, /^participateActivity\t1/m);
  assert.match(text, /^participateResetCouponActivity\t1/m);
  assert.match(text, /^drawLottery\t1/m);
  assert.match(text, /^successful_daily_sign_in\t1/m);
  assert.match(text, /^successful_pro_activity\t0/m);
  assert.match(text, /^successful_reset_coupon_consumption\t0/m);
  assert.match(text, /^successful_lottery_draw\t0/m);
  assert.match(text, /^missing\tsuccessful_pro_activity_fixture,successful_reset_coupon_consumption_fixture,successful_lottery_draw_fixture/m);
  assert.doesNotMatch(text, /benefit-user@example.test|secret-token|token=secret|private pro prompt|private lottery prompt|request-123456|synthetic-user|reset-abcdef|unrelated benefits audit fixture/);
});

test("fixtures audit --scope session reports session lifecycle evidence", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/session-success.json", {
      operation: "verifySession",
      status: "success",
      observedAt: "2026-07-02T03:00:00.000Z",
      result: { ok: true, userId: "user_123", raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/session-expired.json", {
      operation: "verifySession",
      status: "failed",
      observedAt: "2026-07-03T03:00:00.000Z",
      result: { ok: false, error: { category: "login_required", status: 401, message: "expired beta-user@example.test token=secret" } },
    }],
    ["fixtures/protocol-probes/send-success.json", {
      operation: "sendMessage",
      status: "success",
      observedAt: "2026-07-04T03:00:00.000Z",
      result: { content: "non-session fixture should not be inspected" },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "session", "--json"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/session-success.json",
    "readFixture:fixtures/protocol-probes/session-expired.json",
  ]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.scope, "session");
  assert.equal(body.status, "blocked");
  assert.equal(body.coverage.successfulSessionVerify.count, 1);
  assert.equal(body.coverage.expiredSessionSignal.count, 1);
  assert.equal(body.counts.total, 2);
  assert.equal(body.counts.success, 1);
  assert.equal(body.counts.failed, 1);
  assert.equal(body.lifecycle.observedWindowMs, 86_400_000);
  assert.equal(body.recoveryStrategy.status, "blocked");
  assert.equal(body.manualCookieOperations.status, "ready");
  assert.equal(body.manualCookieOperations.mode, "manual_reimport_then_probe");
  assert.equal(body.manualCookieOperations.expiredSessionAction, "login_expired_then_manual_reimport");
  assert.equal(body.manualCookieOperations.automatedRefreshRequired, false);
  assert.deepEqual(body.manualCookieOperations.missing, []);
  assert.deepEqual(body.manualCookieOperations.blockingMissing, []);
  assert.deepEqual(body.manualCookieOperations.backlogMissing, ["automated_session_refresh_strategy"]);
  assert.deepEqual(body.missing, ["automated_session_refresh_strategy"]);
  assert.doesNotMatch(text, /beta-user@example.test|secret-token|token=secret|user_123/);
});

test("fixtures audit --scope session reports calibrated recovery strategy evidence", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/session-success.json", {
      operation: "verifySession",
      status: "success",
      observedAt: "2026-07-02T03:00:00.000Z",
      result: { ok: true, userId: "user_123", raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/session-expired.json", {
      operation: "verifySession",
      status: "failed",
      observedAt: "2026-07-03T03:00:00.000Z",
      result: { ok: false, error: { category: "login_required", status: 401, message: "expired beta-user@example.test token=secret" } },
    }],
    ["fixtures/protocol-probes/session-recovery.json", {
      kind: "session_recovery_strategy",
      operation: "recoverSession",
      status: "success",
      evidence: {
        strategy: "automated_reauth",
        automatedRefresh: "calibrated_reauth_probe",
        observedWindowMs: 86400000,
        resultHash: "sha256:recovery-result-shape",
        safe: true,
        sanitized: true,
        rawPayload: false,
      },
      result: {
        expiredBeforeRecovery: true,
        recoveredVerifySession: true,
        raw: { cookie: "***" },
      },
    }],
    ["fixtures/protocol-probes/send-success.json", {
      operation: "sendMessage",
      status: "success",
      observedAt: "2026-07-04T03:00:00.000Z",
      result: { content: "non-session fixture should not be inspected" },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "session", "--json"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/session-success.json",
    "readFixture:fixtures/protocol-probes/session-expired.json",
    "readFixture:fixtures/protocol-probes/session-recovery.json",
  ]);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.scope, "session");
  assert.equal(body.status, "ready");
  assert.equal(body.counts.total, 2);
  assert.equal(body.counts.recoveryStrategyEvidence, 1);
  assert.equal(body.recoveryStrategy.status, "ready");
  assert.equal(body.recoveryStrategy.current, "automated_reauth");
  assert.equal(body.recoveryStrategy.automatedRefresh, "calibrated_reauth_probe");
  assert.deepEqual(body.missing, []);
  assert.doesNotMatch(text, /beta-user@example.test|secret-token|token=secret|user_123|tabbit_session|non-session fixture/);
});

test("fixtures audit --scope session uses real fixture store session recovery evidence", async () => {
  const stream = io();
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-cli-session-recovery-"));
  const fixtureDir = path.join(stateDir, "fixtures", "protocol-probes");
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, "session-success.json"), JSON.stringify({
    kind: "protocol_probe",
    operation: "verifySession",
    status: "success",
    observedAt: "2026-07-02T03:00:00.000Z",
    result: { ok: true, userId: "user_123", raw: { token: "secret-token" } },
  }), "utf8");
  await writeFile(path.join(fixtureDir, "session-expired.json"), JSON.stringify({
    kind: "protocol_probe",
    operation: "verifySession",
    status: "failed",
    observedAt: "2026-07-03T03:00:00.000Z",
    result: { ok: false, error: { category: "login_required", status: 401, message: "expired beta-user@example.test token=secret" } },
  }), "utf8");
  await writeFile(path.join(fixtureDir, "session-recovery.json"), JSON.stringify({
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    observedAt: "2026-07-04T03:00:00.000Z",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      observedWindowMs: 86400000,
      resultHash: "sha256:recovery-result-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      expiredBeforeRecovery: true,
      recoveredVerifySession: true,
      raw: { cookie: "***" },
    },
  }), "utf8");
  await writeFile(path.join(fixtureDir, "send-success.json"), JSON.stringify({
    kind: "protocol_probe",
    operation: "sendMessage",
    status: "success",
    observedAt: "2026-07-04T04:00:00.000Z",
    result: { content: "non-session fixture should not be inspected" },
  }), "utf8");

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "session", "--json"], {
    protocolFixtureStore: new FileProtocolFixtureStore({ stateDir }),
    now: () => Date.parse("2026-07-02T03:00:00.000Z"),
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.scope, "session");
  assert.equal(body.status, "ready");
  assert.equal(body.counts.total, 2);
  assert.equal(body.counts.recoveryStrategyEvidence, 1);
  assert.equal(body.recoveryStrategy.status, "ready");
  assert.equal(body.recoveryStrategy.current, "automated_reauth");
  assert.equal(body.recoveryStrategy.automatedRefresh, "calibrated_reauth_probe");
  assert.deepEqual(body.missing, []);
  assert.doesNotMatch(text, /beta-user@example.test|secret-token|token=secret|user_123|tabbit_session|non-session fixture/);
});

test("fixtures audit --scope session prints refresh strategy gap in plain output", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/session-success.json", {
      operation: "verifySession",
      status: "success",
      observedAt: "2026-07-02T03:00:00.000Z",
      result: { ok: true, userId: "user_123", raw: { token: "secret-token" } },
    }],
    ["fixtures/protocol-probes/session-expired.json", {
      operation: "verifySession",
      status: "failed",
      observedAt: "2026-07-03T03:00:00.000Z",
      result: { ok: false, error: { category: "login_required", status: 401, message: "expired beta-user@example.test token=secret" } },
    }],
    ["fixtures/protocol-probes/session-recovery-marker-only.json", {
      kind: "session_recovery_strategy",
      operation: "recoverSession",
      status: "success",
      evidence: {
        strategy: "automated_reauth",
        automatedRefresh: "calibrated_reauth_probe",
        safe: true,
        sanitized: true,
        rawPayload: false,
      },
      result: {
        raw: { cookie: "***" },
      },
    }],
    ["fixtures/protocol-probes/send-success.json", {
      operation: "sendMessage",
      status: "success",
      observedAt: "2026-07-04T03:00:00.000Z",
      result: { content: "non-session fixture should not be inspected" },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "session"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/session-success.json",
    "readFixture:fixtures/protocol-probes/session-expired.json",
    "readFixture:fixtures/protocol-probes/session-recovery-marker-only.json",
  ]);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  assert.match(text, /^status\tblocked/m);
  assert.match(text, /^successful_verifySession_fixture\tready\t1/m);
  assert.match(text, /^expired_verifySession_fixture\tready\t1/m);
  assert.match(text, /^session_lifecycle\tlast_successful_at=2026-07-02T03:00:00.000Z\tlast_expired_at=2026-07-03T03:00:00.000Z\tobserved_window_ms=86400000/m);
  assert.match(text, /^manual_cookie_mode\tready\tmode=manual_reimport_then_probe\texpired_session_action=login_expired_then_manual_reimport\tautomated_refresh_required=false\trelease_blocking_missing=\tbacklog_missing=automated_session_refresh_strategy/m);
  assert.match(text, /^recovery_strategy\tblocked\tmanual_reimport_then_probe\tnot_calibrated/m);
  assert.match(text, /^recovery_strategy_rejected\t1/m);
  assert.match(text, /^missing\tautomated_session_refresh_strategy/m);
  assert.doesNotMatch(text, /beta-user@example.test|secret-token|token=secret|user_123|tabbit_session|non-session fixture/);
});

test("fixtures audit --scope upstream reports real upstream boundary evidence", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/upstream-error.json", {
      kind: "protocol_probe",
      operation: "sendMessage",
      status: "failed",
      source: "protocol-client",
      result: {
        raw: {
          kind: "stream",
          format: "sse",
          upstream: true,
          events: [{ event: "error", data: { error: { code: "QUOTA_EXHAUSTED", message: "redacted quota frame" } } }],
        },
        error: { category: "quota_exhausted", code: "QUOTA_EXHAUSTED", message: "beta-user@example.test token=secret" },
      },
    }],
    ["fixtures/protocol-probes/upstream-cancel.json", {
      kind: "protocol_probe",
      operation: "sendMessage",
      status: "success",
      upstreamEvidence: { source: "tabbit-live", cancellation: true },
      result: { raw: { kind: "stream", format: "sse", async: true } },
    }],
    ["fixtures/protocol-probes/upstream-backpressure.json", {
      kind: "protocol_probe",
      operation: "sendMessage",
      status: "success",
      upstreamEvidence: { source: "tabbit-live", backpressure: true, firstTokenFlush: true, delayedSecondChunk: true },
      result: { raw: { kind: "stream", format: "sse", async: true } },
    }],
    ["fixtures/protocol-probes/local-stream.json", {
      operation: "sendMessage",
      status: "success",
      source: "local-http-test",
      result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["local-only fixture"] },
    }],
    ["fixtures/protocol-probes/session-success.json", {
      operation: "verifySession",
      status: "success",
      result: { ok: true, userId: "user_123" },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "upstream", "--json"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/upstream-error.json",
    "readFixture:fixtures/protocol-probes/upstream-cancel.json",
    "readFixture:fixtures/protocol-probes/upstream-backpressure.json",
    "readFixture:fixtures/protocol-probes/local-stream.json",
  ]);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.scope, "upstream");
  assert.equal(body.status, "ready");
  assert.equal(body.counts.total, 4);
  assert.equal(body.counts.realUpstream, 3);
  assert.equal(body.coverage.upstreamErrorFrame.count, 1);
  assert.equal(body.coverage.upstreamCancellation.count, 1);
  assert.equal(body.coverage.upstreamBackpressure.count, 1);
  assert.deepEqual(body.missing, []);
  assert.doesNotMatch(text, /beta-user@example.test|token=secret|local-only fixture|user_123/);
});

test("fixtures audit --scope upstream requires stream metadata for real upstream markers", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/non-stream-upstream-marker.json", {
      kind: "protocol_probe",
      operation: "sendMessage",
      status: "success",
      upstreamEvidence: {
        source: "tabbit-live",
        real: true,
        cancellation: true,
        backpressure: true,
      },
      result: { contentBlocks: [{ type: "text", text: "secret response text" }] },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "upstream", "--json"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/non-stream-upstream-marker.json",
  ]);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  const body = JSON.parse(text);
  assert.equal(body.scope, "upstream");
  assert.equal(body.status, "blocked");
  assert.equal(body.counts.total, 1);
  assert.equal(body.counts.realUpstream, 0);
  assert.equal(body.counts.upstreamErrorFrame, 0);
  assert.equal(body.counts.upstreamCancellation, 0);
  assert.equal(body.counts.upstreamBackpressure, 0);
  assert.equal(body.coverage.upstreamErrorFrame.status, "missing");
  assert.equal(body.coverage.upstreamCancellation.status, "missing");
  assert.equal(body.coverage.upstreamBackpressure.status, "missing");
  assert.deepEqual(body.missing, [
    "real_upstream_error_frame_fixture",
    "real_upstream_cancellation_fixture",
    "real_upstream_backpressure_fixture",
  ]);
  assert.doesNotMatch(text, /secret response text/);
});

test("fixtures audit --scope upstream prints boundary counts in plain output", async () => {
  const stream = io();
  const calls = [];
  const fixtures = new Map([
    ["fixtures/protocol-probes/upstream-error.json", {
      kind: "protocol_probe",
      operation: "sendMessage",
      status: "failed",
      source: "protocol-client",
      result: {
        raw: {
          kind: "stream",
          format: "sse",
          upstream: true,
          events: [{ type: "error", data: { error: { code: "QUOTA_EXHAUSTED", message: "redacted quota frame" } } }],
        },
      },
    }],
    ["fixtures/protocol-probes/local-stream.json", {
      operation: "sendMessage",
      status: "success",
      source: "local-http-test",
      result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["local-only fixture"] },
    }],
    ["fixtures/protocol-probes/missed-stream-evidence.json", {
      kind: "protocol_probe",
      operation: "sendMessage",
      status: "failed",
      input: { messages: [{ role: "user", content: "private diagnostic prompt" }] },
      result: {
        raw: {
          kind: "stream",
          format: "sse",
          async: true,
          events: [{ event: "message", data: "private missed stream text" }],
        },
        upstreamEvidence: { source: "tabbit-live", real: true, stream: true },
      },
      error: {
        category: "protocol_changed",
        code: "STREAM_EVIDENCE_NOT_CAPTURED",
        message: "stream evidence was requested but not captured for token=secret",
      },
    }],
    ["fixtures/protocol-probes/session-success.json", {
      operation: "verifySession",
      status: "success",
      result: { ok: true, userId: "user_123" },
    }],
  ]);

  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "upstream"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return Array.from(fixtures.entries()).map(([ref, fixture]) => ({
          ref,
          operation: fixture.operation,
          status: fixture.status,
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
    "readFixture:fixtures/protocol-probes/upstream-error.json",
    "readFixture:fixtures/protocol-probes/local-stream.json",
    "readFixture:fixtures/protocol-probes/missed-stream-evidence.json",
  ]);
  assert.equal(stream.stderr.length, 0);
  const text = stream.stdout.join("");
  assert.match(text, /^status\tblocked/m);
  assert.match(text, /^real_upstream_error_frame_fixture\tready\t1/m);
  assert.match(text, /^real_upstream_cancellation_fixture\tmissing\t0/m);
  assert.match(text, /^real_upstream_backpressure_fixture\tmissing\t0/m);
  assert.match(text, /^real_upstream\t2/m);
  assert.match(text, /^upstream_error_frame\t1/m);
  assert.match(text, /^upstream_cancellation\t0/m);
  assert.match(text, /^upstream_backpressure\t0/m);
  assert.match(text, /^stream_evidence_not_captured\t1/m);
  assert.match(text, /^missing\treal_upstream_cancellation_fixture,real_upstream_backpressure_fixture/m);
  assert.doesNotMatch(text, /local-only fixture|user_123|QUOTA_EXHAUSTED|private diagnostic prompt|private missed stream text|token=secret/);
});

test("fixtures audit rejects unsupported scopes before reading fixtures", async () => {
  const stream = io();
  const calls = [];
  const result = await runProtocolPoolCli(["fixtures", "audit", "--scope", "secrets", "--json"], {
    protocolFixtureStore: {
      async listFixtures() {
        calls.push("listFixtures");
        return [];
      },
    },
    stdout: (line) => stream.stdout.push(line),
    stderr: (line) => stream.stderr.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(calls, []);
  assert.equal(stream.stdout.length, 0);
  assert.match(stream.stderr.join("\n"), /scope/i);
  assert.doesNotMatch(stream.stderr.join("\n"), /token|cookie|session|secret-value/);
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
