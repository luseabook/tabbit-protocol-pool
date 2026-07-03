import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalibrationReadinessSnapshot,
  buildProtocolFixtureAudit,
  buildHealthSnapshot,
  classifyForbiddenSignal,
  createGatewayHealthProvider,
  formatMaintenanceActionLog,
  protocolProbeAdvice,
  redactAccountForDisplay,
  redactAccountsForDisplay,
  summarizeAccounts,
} from "../src/observability.js";

const NOW = 1782961200000;
const NOW_ISO = "2026-07-02T03:00:00.000Z";

const accounts = [
  {
    id: "acct_active",
    email: "alpha-user@example.test",
    status: "active",
    accessTier: "pro",
    cookieJarRef: "secrets/acct_active.cookie",
    cookieHeader: "tabbit_session=secret",
    quotaState: [{ model: "tabbit/priority", remaining: 12, limit: 20, unit: "requests", exhausted: false }],
    lastError: null,
  },
  {
    id: "acct_cooldown",
    email: "cooldown-user@example.test",
    status: "cooldown",
    cooldownUntil: "2026-07-02T03:01:00.000Z",
    token: "secret-token",
    lastError: {
      category: "protocol_changed",
      code: "PARSE_FAILED",
      message: "parser failed for cooldown-user@example.test with session=secret",
      retryable: false,
      cooldownMs: 0,
    },
  },
  {
    id: "acct_quota",
    email: "quota-user@example.test",
    status: "quota_exhausted",
    session: "secret-session",
    quotaState: [{ model: "tabbit/priority", remaining: 0, limit: 20, unit: "requests", exhausted: true }],
    lastError: { category: "quota_exhausted", message: "quota used" },
  },
];

test("summarizeAccounts counts statuses and raises actionable alerts", () => {
  const summary = summarizeAccounts(accounts);

  assert.equal(summary.total, 3);
  assert.equal(summary.active, 1);
  assert.equal(summary.unavailable, 2);
  assert.equal(summary.byStatus.active, 1);
  assert.equal(summary.byStatus.cooldown, 1);
  assert.equal(summary.byStatus.quota_exhausted, 1);
  assert.equal(summary.health, "degraded");
  assert.deepEqual(summary.alerts.map((alert) => alert.code), ["protocol_changed_errors"]);

  const noActive = summarizeAccounts(accounts.filter((account) => account.status !== "active"));
  assert.equal(noActive.health, "unhealthy");
  assert.ok(noActive.alerts.some((alert) => alert.code === "no_active_accounts"));

  const allQuota = summarizeAccounts([
    { id: "a", status: "quota_exhausted" },
    { id: "b", status: "quota_exhausted" },
  ]);
  assert.equal(allQuota.health, "unhealthy");
  assert.ok(allQuota.alerts.some((alert) => alert.code === "all_accounts_quota_exhausted"));
});

test("redactAccountForDisplay keeps useful metadata and removes raw secrets", () => {
  const display = redactAccountForDisplay(accounts[1]);

  assert.deepEqual(Object.keys(display).sort(), [
    "accessTier",
    "cooldownUntil",
    "email",
    "failureStreak",
    "id",
    "lastError",
    "quotaState",
    "resetCouponCount",
    "status",
  ]);
  assert.equal(display.id, "acct_cooldown");
  assert.equal(display.email, "co***@example.test");
  assert.equal(display.status, "cooldown");
  assert.equal(display.lastError.category, "protocol_changed");
  assert.equal(display.lastError.code, "PARSE_FAILED");
  assert.doesNotMatch(display.lastError.message, /cooldown-user@example\.test/);
  assert.doesNotMatch(display.lastError.message, /secret/);
  assert.equal(display.cookieJarRef, undefined);
  assert.equal(display.cookieHeader, undefined);
  assert.equal(display.token, undefined);
  assert.equal(display.session, undefined);

  const list = redactAccountsForDisplay(accounts);
  assert.equal(list.length, 3);
  assert.equal(list[0].email, "al***@example.test");
});

test("buildHealthSnapshot combines account summary and model cache without leaking accounts", () => {
  const snapshot = buildHealthSnapshot({
    accounts,
    modelCache: { cached: true, stale: false, ageMs: 1000, lastRefreshAt: "2026-07-02T02:59:59.000Z" },
    startedAt: NOW - 10_000,
    now: () => NOW,
  });

  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.mode, "protocol-pool");
  assert.equal(snapshot.uptimeMs, 10_000);
  assert.equal(snapshot.accounts.total, 3);
  assert.equal(snapshot.accounts.active, 1);
  assert.deepEqual(snapshot.modelCache, { cached: true, stale: false, ageMs: 1000, lastRefreshAt: "2026-07-02T02:59:59.000Z" });
  assert.equal(snapshot.accountList, undefined);
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("alpha-user@example.test"), false);
});

test("formatMaintenanceActionLog emits redacted action events", () => {
  const events = formatMaintenanceActionLog({
    accountId: "acct_a",
    actions: [
      { name: "refreshQuota", status: "success", changed: true },
      {
        name: "dailyCheckin",
        status: "failed",
        changed: false,
        error: { category: "mail_timeout", code: "MAIL_TIMEOUT", message: "code 123456 for beta-user@example.test token=secret" },
      },
    ],
    requestId: "req_1",
    now: () => NOW,
  });

  assert.deepEqual(events, [
    {
      observedAt: NOW_ISO,
      requestId: "req_1",
      accountId: "acct_a",
      action: "refreshQuota",
      status: "success",
      changed: true,
    },
    {
      observedAt: NOW_ISO,
      requestId: "req_1",
      accountId: "acct_a",
      action: "dailyCheckin",
      status: "failed",
      changed: false,
      error: {
        category: "mail_timeout",
        code: "MAIL_TIMEOUT",
        message: "code *** for be***@example.test token=***",
      },
    },
  ]);
});

test("protocolProbeAdvice maps common failures to next steps", () => {
  assert.match(protocolProbeAdvice({ category: "protocol_changed" }).recommendation, /capture a fresh fixture/i);
  assert.match(protocolProbeAdvice({ category: "login_required" }).recommendation, /refresh or import/i);
  assert.match(protocolProbeAdvice({ status: 403 }).recommendation, /cookie/i);
  assert.match(protocolProbeAdvice({ category: "rate_limited" }).recommendation, /wait/i);
  assert.match(protocolProbeAdvice({ category: "network_error" }).recommendation, /network/i);
});

test("classifyForbiddenSignal separates 403 risk, signature, session, and entitlement causes", () => {
  assert.deepEqual(classifyForbiddenSignal({
    status: 403,
    body: { message: "request rejected by risk control" },
  }), {
    kind: "risk_control",
    severity: "error",
    accountAction: "suspect",
    retryable: false,
    recommendation: "Isolate this account, avoid immediate retries, capture a redacted sendMessage fixture, and verify the session in Tabbit Web before returning it to the pool.",
  });

  assert.deepEqual(classifyForbiddenSignal({
    category: "forbidden",
    code: "INVALID_SIGNATURE",
    message: "signature timestamp invalid",
  }), {
    kind: "signature_or_protocol",
    severity: "warning",
    accountAction: "protocol_probe",
    retryable: false,
    recommendation: "Treat this as a protocol calibration issue first: refresh sign-key fixture, compare signed payload fields, and update signature/request-body tests before rotating accounts.",
  });

  assert.equal(classifyForbiddenSignal({ status: 403, message: "login cookie expired" }).kind, "session_or_cookie");
  assert.equal(classifyForbiddenSignal({ status: 403, message: "premium required for this model" }).kind, "entitlement_or_model");
  assert.equal(classifyForbiddenSignal({ status: 403, message: "Forbidden" }).kind, "unknown_forbidden");
  assert.equal(classifyForbiddenSignal({ status: 401 }).kind, "not_forbidden");
});

test("protocolProbeAdvice includes sanitized forbidden detail without raw probe text", () => {
  const advice = protocolProbeAdvice({
    status: 403,
    message: "risk control for beta-user@example.test token=secret code 123456",
  });

  assert.equal(advice.category, "forbidden");
  assert.equal(advice.forbidden.kind, "risk_control");
  assert.equal(advice.forbidden.accountAction, "suspect");
  assert.doesNotMatch(JSON.stringify(advice), /beta-user@example\.test/);
  assert.doesNotMatch(JSON.stringify(advice), /123456/);
  assert.doesNotMatch(JSON.stringify(advice), /token=secret/);
});


test("buildProtocolFixtureAudit summarizes calibration fixture coverage", () => {
  const audit = buildProtocolFixtureAudit({
    fixtures: [
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "success", result: { contentBlocks: [{ type: "text", text: "ok" }] } },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["he", "llo"] } },
      { operation: "sendMessage", status: "success", result: { contentBlocks: [{ type: "tool_use", name: "read_file", input: { path: "README.md" } }] } },
      { operation: "sendMessage", status: "failed", adviceCategory: "forbidden", error: { status: 403, message: "risk control" } },
    ],
    now: () => NOW,
  });

  assert.equal(audit.status, "ready");
  assert.equal(audit.observedAt, NOW_ISO);
  assert.equal(audit.counts.total, 5);
  assert.equal(audit.coverage.sessionVerify.count, 1);
  assert.equal(audit.coverage.successfulSendMessage.count, 3);
  assert.equal(audit.coverage.streamingText.count, 1);
  assert.equal(audit.coverage.toolCall.count, 1);
  assert.equal(audit.coverage.forbidden403.count, 1);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.nextActions, []);
  assert.equal(JSON.stringify(audit).includes("risk control"), false);
});

test("buildProtocolFixtureAudit treats explicit unsupported native tool evidence as tool coverage", () => {
  const audit = buildProtocolFixtureAudit({
    fixtures: [
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "success", result: { contentBlocks: [{ type: "text", text: "ok" }] } },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["ok"] } },
      {
        operation: "sendMessage",
        status: "failed",
        input: { model: "tabbit/priority", messages: [{ role: "user", content: "call tool" }], tools: [{ type: "function", function: { name: "read_file" } }] },
        error: { code: "TOOL_FIELDS_UNSUPPORTED", message: "tool calls are not supported for beta-user@example.test token=secret" },
        advice: { category: "invalid_request" },
      },
      { operation: "sendMessage", status: "failed", adviceCategory: "forbidden", error: { status: 403, message: "risk control" } },
    ],
    now: () => NOW,
  });

  assert.equal(audit.status, "ready");
  assert.equal(audit.coverage.toolCall.count, 1);
  assert.deepEqual(audit.missing, []);
  assert.doesNotMatch(JSON.stringify(audit), /beta-user@example.test|token=secret/);
});

test("buildProtocolFixtureAudit treats sanitized protocol-client tool unsupported result as tool coverage", () => {
  const audit = buildProtocolFixtureAudit({
    fixtures: [
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "success", result: { contentBlocks: [{ type: "text", text: "ok" }] } },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["ok"] } },
      {
        operation: "sendMessage",
        status: "failed",
        input: {
          model: "tabbit/priority",
          messages: [{ role: "user", content: "call tool" }],
          tools: [{ type: "function", function: { name: "read_file" } }],
          tool_choice: "auto",
        },
        error: { category: "protocol_changed", code: "***", message: "protocol probe failed" },
        result: {
          ok: false,
          error: {
            category: "unsupported_feature",
            code: "***",
          },
        },
      },
      { operation: "sendMessage", status: "failed", adviceCategory: "forbidden", error: { status: 403, message: "risk control" } },
    ],
    now: () => NOW,
  });

  assert.equal(audit.status, "ready");
  assert.equal(audit.coverage.toolCall.count, 1);
  assert.deepEqual(audit.missing, []);
});

test("buildProtocolFixtureAudit treats sanitized protocol-client forbidden result as 403 coverage", () => {
  const audit = buildProtocolFixtureAudit({
    fixtures: [
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "success", result: { contentBlocks: [{ type: "text", text: "ok" }] } },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["ok"] } },
      {
        operation: "sendMessage",
        status: "failed",
        input: { model: "tabbit/priority", messages: [{ role: "user", content: "call tool" }], tools: [{ type: "function", function: { name: "read_file" } }] },
        result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
      },
      {
        operation: "sendMessage",
        status: "failed",
        error: { category: "protocol_changed", code: "***", message: "protocol probe failed" },
        result: { ok: false, error: { category: "forbidden", status: 403 } },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.status, "ready");
  assert.equal(audit.coverage.forbidden403.count, 1);
  assert.deepEqual(audit.missing, []);
});

test("buildProtocolFixtureAudit reports missing fixture coverage without leaking payloads", () => {
  const audit = buildProtocolFixtureAudit({
    fixtures: [
      {
        operation: "sendMessage",
        status: "failed",
        adviceCategory: "forbidden",
        error: { status: 403, message: "risk control beta-user@example.test token=secret code 123456" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.status, "blocked");
  assert.deepEqual(audit.missing, ["successful_verifySession_fixture", "successful_sendMessage_fixture", "streaming_text_fixture", "tool_call_fixture"]);
  assert.equal(audit.coverage.forbidden403.count, 1);
  assert.ok(audit.nextActions.some((action) => action.includes("sendMessage")));
  assert.doesNotMatch(JSON.stringify(audit), /beta-user@example.test|token=secret|123456/);
});

test("buildCalibrationReadinessSnapshot reports protocol, e2e, tool-loop, and 403 readiness", () => {
  const snapshot = buildCalibrationReadinessSnapshot({
    accounts,
    config: {
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
    fixtures: [
      {
        operation: "verifySession",
        status: "success",
        result: { ok: true, userId: "user_123" },
      },
      {
        operation: "sendMessage",
        status: "success",
        adviceCategory: "success",
      },
      {
        operation: "sendMessage",
        status: "failed",
        adviceCategory: "forbidden",
        error: { status: 403, message: "risk control" },
      },
    ],
    codexVerified: false,
    claudeVerified: false,
    now: () => NOW,
  });

  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.observedAt, NOW_ISO);
  assert.equal(snapshot.checks.protocolCalibration.status, "ready");
  assert.equal(snapshot.checks.protocolCalibration.evidence.activeAccounts, 1);
  assert.equal(snapshot.checks.protocolCalibration.evidence.successfulVerifySessionFixtures, 1);
  assert.equal(snapshot.checks.protocolCalibration.evidence.successfulSendFixtures, 1);
  assert.equal(snapshot.checks.codexClaudeE2E.status, "blocked");
  assert.deepEqual(snapshot.checks.codexClaudeE2E.missing, ["codex_e2e_verified", "claude_code_e2e_verified"]);
  assert.equal(snapshot.checks.toolLoopDecision.status, "ready");
  assert.equal(snapshot.checks.toolLoopDecision.decision, "disabled");
  assert.match(snapshot.checks.toolLoopDecision.recommendation, /will reject or pass through/i);
  assert.equal(snapshot.checks.forbidden403.status, "ready");
  assert.equal(snapshot.checks.forbidden403.evidence.forbiddenFixtures, 1);
  assert.ok(snapshot.nextActions.some((action) => action.includes("Codex")));
});

test("buildCalibrationReadinessSnapshot preserves local tool loop mode", () => {
  const snapshot = buildCalibrationReadinessSnapshot({
    accounts: [],
    config: { compat: { toolLoopMode: "local_executes_tools" } },
    fixtures: [],
    now: () => NOW,
  });

  assert.equal(snapshot.checks.toolLoopDecision.status, "ready");
  assert.equal(snapshot.checks.toolLoopDecision.decision, "local_executes_tools");
  assert.match(snapshot.checks.toolLoopDecision.recommendation, /injected local tool executor/i);
});

test("buildCalibrationReadinessSnapshot blocks protocol calibration without paths, accounts, and fixtures", () => {
  const snapshot = buildCalibrationReadinessSnapshot({
    accounts: [],
    config: { protocol: { enabled: false } },
    fixtures: [],
    now: () => NOW,
  });

  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.checks.protocolCalibration.status, "blocked");
  assert.deepEqual(snapshot.checks.protocolCalibration.missing, [
    "protocol_enabled",
    "protocol_send_path",
    "protocol_session_verify_path",
    "active_account",
    "successful_verifySession_fixture",
    "successful_sendMessage_fixture",
  ]);
  assert.equal(snapshot.checks.forbidden403.status, "blocked");
  assert.deepEqual(snapshot.checks.forbidden403.missing, ["forbidden_403_fixture"]);
});

test("createGatewayHealthProvider reads AccountPool safely", async () => {
  const provider = createGatewayHealthProvider({
    accountPool: {
      listAccounts() {
        return accounts;
      },
    },
    startedAt: NOW - 5000,
    now: () => NOW,
  });

  const health = await provider();

  assert.equal(health.status, "degraded");
  assert.equal(health.uptimeMs, 5000);
  assert.equal(health.accounts.total, 3);
  assert.equal(JSON.stringify(health).includes("cookie"), false);
  assert.equal(JSON.stringify(health).includes("alpha-user@example.test"), false);
});
