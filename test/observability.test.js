import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalibrationReadinessSnapshot,
  buildProtocolFixtureAudit,
  buildReadinessDoctorReport,
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

test("buildProtocolFixtureAudit supports auth fixture scope", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "auth",
    fixtures: [
      {
        operation: "sendVerificationCode",
        status: "success",
        input: { email: "new-user@example.test" },
        result: { codeSent: true, raw: { token: "secret-token" } },
      },
      {
        operation: "submitRegistrationOrLogin",
        status: "failed",
        input: { email: "new-user@example.test", code: "123456" },
        error: { category: "code_invalid", message: "new-user@example.test code 123456 token=secret" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "auth");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.sendVerificationCode, 1);
  assert.equal(audit.counts.submitRegistrationOrLogin, 1);
  assert.equal(audit.counts.successfulSendVerificationCode, 1);
  assert.equal(audit.counts.successfulSendVerificationCodeWithDeliverySignal, 1);
  assert.equal(audit.counts.successfulSubmitRegistrationOrLogin, 0);
  assert.equal(audit.coverage.authSendVerificationCode.status, "ready");
  assert.equal(audit.coverage.authSubmitRegistrationOrLogin.status, "missing");
  assert.deepEqual(audit.missing, ["successful_submitRegistrationOrLogin_fixture"]);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("new-user@example.test"), false);
  assert.equal(serialized.includes("123456"), false);
  assert.equal(serialized.includes("secret-token"), false);
});

test("buildProtocolFixtureAudit requires delivery evidence for auth send success", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "auth",
    fixtures: [
      {
        operation: "sendVerificationCode",
        status: "success",
        input: { email: "new-user@example.test", code: "123456", rawPayload: "private auth payload" },
        result: {
          ok: true,
          status: "success",
          result: "success",
          raw: { token: "secret-token" },
        },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "auth");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.sendVerificationCode, 1);
  assert.equal(audit.counts.successfulSendVerificationCode, 1);
  assert.equal(audit.counts.successfulSendVerificationCodeWithDeliverySignal, 0);
  assert.equal(audit.coverage.authSendVerificationCode.status, "missing");
  assert.equal(audit.coverage.authSendVerificationCode.count, 0);
  assert.deepEqual(audit.missing, ["successful_sendVerificationCode_fixture", "successful_submitRegistrationOrLogin_fixture"]);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("new-user@example.test"), false);
  assert.equal(serialized.includes("123456"), false);
  assert.equal(serialized.includes("private auth payload"), false);
  assert.equal(serialized.includes("secret-token"), false);
});

test("buildProtocolFixtureAudit requires session material for auth submit success evidence", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "auth",
    fixtures: [
      {
        operation: "sendVerificationCode",
        status: "success",
        input: { email: "new-user@example.test" },
        result: { codeSent: true },
      },
      {
        operation: "submitRegistrationOrLogin",
        status: "success",
        input: { email: "new-user@example.test", code: "123456" },
        result: { ok: true, userId: "user_without_session" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "auth");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.successfulSendVerificationCode, 1);
  assert.equal(audit.counts.successfulSendVerificationCodeWithDeliverySignal, 1);
  assert.equal(audit.counts.successfulSubmitRegistrationOrLogin, 1);
  assert.equal(audit.counts.successfulSubmitRegistrationOrLoginWithSessionMaterial, 0);
  assert.equal(audit.coverage.authSendVerificationCode.status, "ready");
  assert.equal(audit.coverage.authSubmitRegistrationOrLogin.status, "missing");
  assert.deepEqual(audit.missing, ["successful_submitRegistrationOrLogin_fixture"]);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("new-user@example.test"), false);
  assert.equal(serialized.includes("123456"), false);
  assert.equal(serialized.includes("user_without_session"), false);
});

test("buildProtocolFixtureAudit ignores nested raw auth submit token as importable session material", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "auth",
    fixtures: [
      {
        operation: "sendVerificationCode",
        status: "success",
        result: { codeSent: true },
      },
      {
        operation: "submitRegistrationOrLogin",
        status: "success",
        result: { ok: true, raw: { token: "secret-token" } },
      },
      {
        operation: "sendMessage",
        status: "success",
        result: { content: "ok" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.total, 2);
  assert.equal(audit.counts.success, 2);
  assert.equal(audit.counts.failed, 0);
  assert.equal(audit.counts.successfulSendVerificationCodeWithDeliverySignal, 1);
  assert.equal(audit.counts.successfulSubmitRegistrationOrLogin, 1);
  assert.equal(audit.counts.successfulSubmitRegistrationOrLoginWithSessionMaterial, 0);
  assert.equal(audit.coverage.authSubmitRegistrationOrLogin.status, "missing");
  assert.deepEqual(audit.missing, ["successful_submitRegistrationOrLogin_fixture"]);
  assert.equal(JSON.stringify(audit).includes("secret-token"), false);
});

test("buildProtocolFixtureAudit supports benefits side-effect fixture scope", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "benefits",
    fixtures: [
      {
        operation: "dailySignIn",
        status: "success",
        input: { email: "benefit-user@example.test", requestNo: "request-123456" },
        result: { signInResult: "success", signedToday: true, raw: { token: "secret-token" } },
      },
      {
        operation: "participateResetCouponActivity",
        status: "success",
        input: { payload: { request_no: "reset-123456" } },
        result: { participationResult: "already_participated", activityId: 10001 },
      },
      {
        operation: "participateActivity",
        status: "failed",
        input: { body: { prompt: "synthetic private prompt" } },
        error: { category: "forbidden", message: "benefit-user@example.test token=secret" },
      },
      {
        operation: "drawLottery",
        status: "failed",
        input: { body: { activityId: "lottery-123456" } },
        error: { category: "quota_exhausted", message: "no chance for benefit-user@example.test" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "benefits");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.dailySignIn, 1);
  assert.equal(audit.counts.participateResetCouponActivity, 1);
  assert.equal(audit.counts.participateActivity, 1);
  assert.equal(audit.counts.drawLottery, 1);
  assert.equal(audit.counts.successfulDailySignIn, 1);
  assert.equal(audit.counts.successfulProActivity, 0);
  assert.equal(audit.counts.successfulResetCouponConsumption, 0);
  assert.equal(audit.counts.successfulLotteryDraw, 0);
  assert.equal(audit.coverage.dailySignIn.status, "ready");
  assert.equal(audit.coverage.proActivitySuccess.status, "missing");
  assert.equal(audit.coverage.resetCouponConsumption.status, "missing");
  assert.equal(audit.coverage.lotteryDrawSuccess.status, "missing");
  assert.deepEqual(audit.missing, [
    "successful_pro_activity_fixture",
    "successful_reset_coupon_consumption_fixture",
    "successful_lottery_draw_fixture",
  ]);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("benefit-user@example.test"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("token=secret"), false);
  assert.equal(serialized.includes("synthetic private prompt"), false);
  assert.equal(serialized.includes("request-123456"), false);
});

test("buildProtocolFixtureAudit requires Pro-specific evidence for activity success", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "benefits",
    fixtures: [
      {
        operation: "participateActivity",
        status: "success",
        input: { body: { userId: "synthetic-user", prompt: "private pro prompt" } },
        result: {
          ok: true,
          status: "success",
          result: "success",
          raw: { token: "secret-token" },
        },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "benefits");
  assert.equal(audit.counts.participateActivity, 1);
  assert.equal(audit.counts.successfulProActivity, 0);
  assert.equal(audit.coverage.proActivitySuccess.status, "missing");
  assert.equal(audit.coverage.proActivitySuccess.count, 0);
  assert.ok(audit.missing.includes("successful_pro_activity_fixture"));
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("synthetic-user"), false);
  assert.equal(serialized.includes("private pro prompt"), false);
  assert.equal(serialized.includes("secret-token"), false);
});

test("buildProtocolFixtureAudit ignores unrelated fixtures in benefits scope", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "benefits",
    fixtures: [
      {
        operation: "dailySignIn",
        status: "success",
        result: { signInResult: "success" },
      },
      {
        operation: "verifySession",
        status: "success",
        result: { ok: true, userId: "user_123" },
      },
      {
        operation: "sendMessage",
        status: "failed",
        error: { category: "forbidden", message: "token=secret" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "benefits");
  assert.equal(audit.counts.total, 1);
  assert.equal(audit.counts.dailySignIn, 1);
  assert.equal(audit.counts.success, 1);
  assert.equal(audit.counts.failed, 0);
  assert.equal(audit.coverage.dailySignIn.status, "ready");
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("user_123"), false);
  assert.equal(serialized.includes("token=secret"), false);
});

test("buildProtocolFixtureAudit treats already_signed daily sign-in as calibrated success", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "benefits",
    fixtures: [
      {
        operation: "dailySignIn",
        status: "success",
        result: {
          signInResult: "already_signed",
          raw: { token: "secret-token" },
        },
      },
      {
        operation: "participateActivity",
        status: "success",
        result: { participationResult: "already_participated" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "benefits");
  assert.equal(audit.counts.dailySignIn, 1);
  assert.equal(audit.counts.successfulDailySignIn, 1);
  assert.equal(audit.coverage.dailySignIn.status, "ready");
  assert.equal(audit.counts.successfulProActivity, 0);
  assert.equal(audit.coverage.proActivitySuccess.status, "missing");
  assert.equal(JSON.stringify(audit).includes("secret-token"), false);
});

test("buildProtocolFixtureAudit never treats reset activity participation as coupon consumption", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "benefits",
    fixtures: [
      {
        operation: "participateResetCouponActivity",
        status: "success",
        input: { payload: { user_id: "synthetic-user", request_no: "reset-123456" } },
        result: {
          resetCouponConsumed: true,
          consumeResult: "success",
          couponConsumed: true,
          raw: { token: "secret-token" },
        },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "benefits");
  assert.equal(audit.counts.participateResetCouponActivity, 1);
  assert.equal(audit.counts.successfulResetCouponConsumption, 0);
  assert.equal(audit.coverage.resetCouponConsumption.status, "missing");
  assert.equal(audit.coverage.resetCouponConsumption.count, 0);
  assert.ok(audit.missing.includes("successful_reset_coupon_consumption_fixture"));
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("synthetic-user"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("reset-123456"), false);
});

test("buildProtocolFixtureAudit requires sanitized hash evidence for reset coupon consumption success", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "benefits",
    fixtures: [
      {
        operation: "consumeResetCoupon",
        status: "success",
        result: { resetCouponConsumed: true, consumeResult: "success" },
      },
      {
        operation: "consumeResetCoupon",
        status: "success",
        evidence: {
          endpointHash: "sha256:endpoint-private-shape",
          bodyHash: "sha256:body-private-shape",
          resultHash: "sha256:result-private-shape",
          safe: true,
          sanitized: false,
          rawPayload: false,
        },
        result: { resetCouponConsumed: true, consumeResult: "success" },
      },
      {
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
        result: { resetCouponConsumed: true, consumeResult: "success" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "benefits");
  assert.equal(audit.counts.consumeResetCoupon, 3);
  assert.equal(audit.counts.successfulResetCouponConsumption, 1);
  assert.equal(audit.coverage.resetCouponConsumption.status, "ready");
  assert.equal(audit.coverage.resetCouponConsumption.count, 1);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("endpoint-private-shape"), false);
  assert.equal(serialized.includes("body-private-shape"), false);
  assert.equal(serialized.includes("result-private-shape"), false);
});

test("buildProtocolFixtureAudit requires draw-specific evidence for lottery success", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "benefits",
    fixtures: [
      {
        operation: "drawLottery",
        status: "success",
        input: { body: { userId: "synthetic-user", prompt: "private lottery prompt" } },
        result: {
          status: "success",
          result: "success",
          ok: true,
          raw: { token: "secret-token" },
        },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "benefits");
  assert.equal(audit.counts.drawLottery, 1);
  assert.equal(audit.counts.successfulLotteryDraw, 0);
  assert.equal(audit.coverage.lotteryDrawSuccess.status, "missing");
  assert.equal(audit.coverage.lotteryDrawSuccess.count, 0);
  assert.ok(audit.missing.includes("successful_lottery_draw_fixture"));
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("synthetic-user"), false);
  assert.equal(serialized.includes("private lottery prompt"), false);
  assert.equal(serialized.includes("secret-token"), false);
});

test("buildProtocolFixtureAudit supports session lifecycle fixture scope", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "session",
    fixtures: [
      {
        operation: "verifySession",
        status: "success",
        observedAt: "2026-07-02T03:00:00.000Z",
        result: { ok: true, userId: "user_123", raw: { token: "secret-token" } },
      },
      {
        operation: "verifySession",
        status: "failed",
        observedAt: "2026-07-03T03:00:00.000Z",
        error: { category: "login_required", status: 401, message: "expired beta-user@example.test token=secret" },
      },
      {
        operation: "verifySession",
        status: "failed",
        observedAt: "2026-07-03T04:00:00.000Z",
        error: { category: "session_missing", message: "local secret missing token=secret" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "session");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.verifySession, 3);
  assert.equal(audit.counts.successfulVerifySession, 1);
  assert.equal(audit.counts.expiredVerifySession, 1);
  assert.equal(audit.counts.sessionMissing, 1);
  assert.equal(audit.coverage.successfulSessionVerify.status, "ready");
  assert.equal(audit.coverage.expiredSessionSignal.status, "ready");
  assert.equal(audit.lifecycle.lastSuccessfulAt, "2026-07-02T03:00:00.000Z");
  assert.equal(audit.lifecycle.lastExpiredAt, "2026-07-03T03:00:00.000Z");
  assert.equal(audit.lifecycle.observedWindowMs, 86_400_000);
  assert.equal(audit.recoveryStrategy.status, "blocked");
  assert.equal(audit.recoveryStrategy.current, "manual_reimport_then_probe");
  assert.equal(audit.recoveryStrategy.automatedRefresh, "not_calibrated");
  assert.equal(audit.manualCookieOperations.status, "ready");
  assert.equal(audit.manualCookieOperations.mode, "manual_reimport_then_probe");
  assert.equal(audit.manualCookieOperations.expiredSessionAction, "login_expired_then_manual_reimport");
  assert.equal(audit.manualCookieOperations.automatedRefreshRequired, false);
  assert.deepEqual(audit.manualCookieOperations.missing, []);
  assert.deepEqual(audit.manualCookieOperations.blockingMissing, []);
  assert.deepEqual(audit.manualCookieOperations.backlogMissing, ["automated_session_refresh_strategy"]);
  assert.deepEqual(audit.missing, ["automated_session_refresh_strategy"]);
  assert.ok(audit.nextActions.some((action) => action.includes("session refresh")));
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("beta-user@example.test"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("token=secret"), false);
  assert.equal(serialized.includes("user_123"), false);
});

test("buildProtocolFixtureAudit keeps session scope blocked until refresh strategy is calibrated", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "session",
    fixtures: [
      {
        operation: "verifySession",
        status: "success",
        observedAt: "2026-07-02T03:00:00.000Z",
        result: { ok: true, userId: "user_123", raw: { token: "secret-token" } },
      },
      {
        operation: "verifySession",
        status: "failed",
        observedAt: "2026-07-03T03:00:00.000Z",
        error: { category: "login_required", status: 401, message: "expired beta-user@example.test token=secret" },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.coverage.successfulSessionVerify.status, "ready");
  assert.equal(audit.coverage.expiredSessionSignal.status, "ready");
  assert.equal(audit.recoveryStrategy.current, "manual_reimport_then_probe");
  assert.equal(audit.recoveryStrategy.automatedRefresh, "not_calibrated");
  assert.equal(audit.recoveryStrategy.status, "blocked");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.manualCookieOperations.status, "ready");
  assert.deepEqual(audit.manualCookieOperations.missing, []);
  assert.deepEqual(audit.manualCookieOperations.blockingMissing, []);
  assert.deepEqual(audit.manualCookieOperations.backlogMissing, ["automated_session_refresh_strategy"]);
  assert.deepEqual(audit.missing, ["automated_session_refresh_strategy"]);
  assert.ok(audit.nextActions.some((action) => action.includes("refresh")));
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("beta-user@example.test"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("user_123"), false);
});

test("buildProtocolFixtureAudit accepts explicit session recovery strategy evidence", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "session",
    fixtures: [
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
        error: { category: "login_required", status: 401, message: "expired token=secret" },
      },
      {
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
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "session");
  assert.equal(audit.status, "ready");
  assert.equal(audit.counts.total, 2);
  assert.equal(audit.counts.recoveryStrategyEvidence, 1);
  assert.equal(audit.coverage.successfulSessionVerify.status, "ready");
  assert.equal(audit.coverage.expiredSessionSignal.status, "ready");
  assert.equal(audit.recoveryStrategy.status, "ready");
  assert.equal(audit.recoveryStrategy.current, "automated_reauth");
  assert.equal(audit.recoveryStrategy.automatedRefresh, "calibrated_reauth_probe");
  assert.equal(audit.recoveryStrategy.observedWindowMs, 86_400_000);
  assert.equal(audit.manualCookieOperations.status, "ready");
  assert.deepEqual(audit.manualCookieOperations.missing, []);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.nextActions, []);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("user_123"), false);
  assert.equal(serialized.includes("token=secret"), false);
});

test("buildProtocolFixtureAudit rejects marker-only session recovery evidence", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "session",
    fixtures: [
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
        error: { category: "login_required", status: 401, message: "expired token=secret" },
      },
      {
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
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "session");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.coverage.successfulSessionVerify.status, "ready");
  assert.equal(audit.coverage.expiredSessionSignal.status, "ready");
  assert.equal(audit.counts.recoveryStrategyEvidence, 0);
  assert.equal(audit.recoveryStrategy.status, "blocked");
  assert.equal(audit.recoveryStrategy.current, "manual_reimport_then_probe");
  assert.equal(audit.recoveryStrategy.automatedRefresh, "not_calibrated");
  assert.equal(audit.manualCookieOperations.status, "ready");
  assert.deepEqual(audit.manualCookieOperations.missing, []);
  assert.deepEqual(audit.missing, ["automated_session_refresh_strategy"]);
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes("user_123"), false);
  assert.equal(serialized.includes("token=secret"), false);
  assert.equal(serialized.includes("tabbit_session=secret"), false);
});

test("buildProtocolFixtureAudit reports rejected session recovery evidence without satisfying recovery readiness", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "session",
    fixtures: [
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
        error: { category: "login_required", status: 401, message: "expired token=secret" },
      },
      {
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
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "session");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.coverage.successfulSessionVerify.status, "ready");
  assert.equal(audit.coverage.expiredSessionSignal.status, "ready");
  assert.equal(audit.counts.recoveryStrategyEvidence, 0);
  assert.equal(audit.counts.rejectedRecoveryStrategyEvidence, 1);
  assert.equal(audit.recoveryStrategy.status, "blocked");
  assert.equal(audit.recoveryStrategy.current, "manual_reimport_then_probe");
  assert.equal(audit.recoveryStrategy.automatedRefresh, "not_calibrated");
  assert.deepEqual(audit.missing, ["automated_session_refresh_strategy"]);
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, /user_123|token=secret|tabbit_session=secret/);
});

test("buildProtocolFixtureAudit keeps local session_missing separate from upstream expiration", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "session",
    fixtures: [
      {
        operation: "verifySession",
        status: "success",
        observedAt: "2026-07-02T03:00:00.000Z",
        result: { ok: true },
      },
      {
        operation: "verifySession",
        status: "failed",
        observedAt: "2026-07-03T03:00:00.000Z",
        error: { category: "session_missing", status: 401, code: "SESSION_MISSING" },
      },
      {
        operation: "sendMessage",
        status: "success",
        observedAt: "2026-07-04T03:00:00.000Z",
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.total, 2);
  assert.equal(audit.counts.verifySession, 2);
  assert.equal(audit.counts.successfulVerifySession, 1);
  assert.equal(audit.counts.expiredVerifySession, 0);
  assert.equal(audit.counts.sessionMissing, 1);
  assert.equal(audit.counts.success, 1);
  assert.equal(audit.counts.failed, 1);
  assert.equal(audit.coverage.expiredSessionSignal.status, "missing");
  assert.deepEqual(audit.manualCookieOperations.blockingMissing, ["expired_verifySession_fixture"]);
  assert.deepEqual(audit.manualCookieOperations.backlogMissing, ["automated_session_refresh_strategy"]);
  assert.deepEqual(audit.missing, ["expired_verifySession_fixture", "automated_session_refresh_strategy"]);
});

test("buildProtocolFixtureAudit supports upstream stream boundary fixture scope", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "upstream",
    fixtures: [
      {
        kind: "protocol_probe",
        operation: "sendMessage",
        status: "failed",
        source: "protocol-client",
        result: {
          raw: {
            kind: "stream",
            format: "sse",
            upstream: true,
            events: [{ event: "error", data: { error: { code: "QUOTA_EXHAUSTED", message: "redacted" } } }],
          },
          error: { category: "quota_exhausted", code: "QUOTA_EXHAUSTED", message: "redacted" },
        },
      },
      {
        kind: "protocol_probe",
        operation: "sendMessage",
        status: "success",
        upstreamEvidence: { source: "tabbit-live", cancellation: true },
        result: { raw: { kind: "stream", format: "sse", async: true } },
      },
      {
        kind: "protocol_probe",
        operation: "sendMessage",
        status: "success",
        upstreamEvidence: { source: "tabbit-live", backpressure: true, firstTokenFlush: true, delayedSecondChunk: true },
        result: { raw: { kind: "stream", format: "sse", async: true } },
      },
      {
        operation: "sendMessage",
        status: "success",
        source: "local-http-test",
        result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["local"] },
      },
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "upstream");
  assert.equal(audit.status, "ready");
  assert.equal(audit.counts.total, 4);
  assert.equal(audit.counts.sendMessage, 4);
  assert.equal(audit.counts.realUpstream, 3);
  assert.equal(audit.counts.upstreamErrorFrame, 1);
  assert.equal(audit.counts.upstreamCancellation, 1);
  assert.equal(audit.counts.upstreamBackpressure, 1);
  assert.equal(audit.coverage.upstreamErrorFrame.count, 1);
  assert.equal(audit.coverage.upstreamCancellation.count, 1);
  assert.equal(audit.coverage.upstreamBackpressure.count, 1);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.nextActions, []);
  assert.doesNotMatch(JSON.stringify(audit), /user_123|local/);
});

test("buildProtocolFixtureAudit requires stream metadata for real upstream boundary evidence", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "upstream",
    fixtures: [
      {
        kind: "protocol_probe",
        operation: "sendMessage",
        status: "success",
        upstreamEvidence: { source: "tabbit-live", real: true, cancellation: true, backpressure: true },
        result: { contentBlocks: [{ type: "text", text: "secret upstream text" }] },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "upstream");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.total, 1);
  assert.equal(audit.counts.realUpstream, 0);
  assert.equal(audit.counts.upstreamErrorFrame, 0);
  assert.equal(audit.counts.upstreamCancellation, 0);
  assert.equal(audit.counts.upstreamBackpressure, 0);
  assert.equal(audit.coverage.upstreamErrorFrame.status, "missing");
  assert.equal(audit.coverage.upstreamCancellation.status, "missing");
  assert.equal(audit.coverage.upstreamBackpressure.status, "missing");
  assert.deepEqual(audit.missing, [
    "real_upstream_error_frame_fixture",
    "real_upstream_cancellation_fixture",
    "real_upstream_backpressure_fixture",
  ]);
  assert.doesNotMatch(JSON.stringify(audit), /secret upstream text/);
});

test("buildProtocolFixtureAudit requires explicit upstream marker for stream boundary evidence", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "upstream",
    fixtures: [
      {
        kind: "protocol_probe",
        operation: "sendMessage",
        status: "success",
        result: {
          raw: {
            kind: "stream",
            format: "sse",
            events: [{ event: "message", data: "secret stream text" }],
          },
          streamDeltas: ["secret stream text"],
        },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "upstream");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.total, 1);
  assert.equal(audit.counts.realUpstream, 0);
  assert.equal(audit.counts.upstreamErrorFrame, 0);
  assert.equal(audit.counts.upstreamCancellation, 0);
  assert.equal(audit.counts.upstreamBackpressure, 0);
  assert.equal(audit.coverage.upstreamErrorFrame.status, "missing");
  assert.equal(audit.coverage.upstreamCancellation.status, "missing");
  assert.equal(audit.coverage.upstreamBackpressure.status, "missing");
  assert.deepEqual(audit.missing, [
    "real_upstream_error_frame_fixture",
    "real_upstream_cancellation_fixture",
    "real_upstream_backpressure_fixture",
  ]);
  assert.doesNotMatch(JSON.stringify(audit), /secret stream text/);
});

test("buildProtocolFixtureAudit rejects generic protocol source as real upstream marker", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "upstream",
    fixtures: [
      {
        operation: "sendMessage",
        status: "success",
        source: "protocol-client",
        upstreamEvidence: { cancellation: true },
        result: {
          raw: {
            kind: "stream",
            format: "sse",
            events: [{ event: "message", data: "secret protocol-client stream" }],
          },
          streamDeltas: ["secret protocol-client stream"],
        },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "upstream");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.total, 1);
  assert.equal(audit.counts.realUpstream, 0);
  assert.equal(audit.counts.upstreamCancellation, 0);
  assert.equal(audit.coverage.upstreamErrorFrame.status, "missing");
  assert.equal(audit.coverage.upstreamCancellation.status, "missing");
  assert.equal(audit.coverage.upstreamBackpressure.status, "missing");
  assert.deepEqual(audit.missing, [
    "real_upstream_error_frame_fixture",
    "real_upstream_cancellation_fixture",
    "real_upstream_backpressure_fixture",
  ]);
  assert.doesNotMatch(JSON.stringify(audit), /secret protocol-client stream/);
});

test("buildProtocolFixtureAudit keeps upstream scope blocked for local-only streams", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "upstream",
    fixtures: [
      {
        operation: "sendMessage",
        status: "success",
        source: "local-http-test",
        result: { raw: { kind: "stream", format: "sse" }, streamDeltas: ["local"] },
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "upstream");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.total, 1);
  assert.equal(audit.counts.realUpstream, 0);
  assert.equal(audit.coverage.upstreamErrorFrame.status, "missing");
  assert.equal(audit.coverage.upstreamCancellation.status, "missing");
  assert.equal(audit.coverage.upstreamBackpressure.status, "missing");
  assert.deepEqual(audit.missing, [
    "real_upstream_error_frame_fixture",
    "real_upstream_cancellation_fixture",
    "real_upstream_backpressure_fixture",
  ]);
  assert.doesNotMatch(JSON.stringify(audit), /local/);
});

test("buildProtocolFixtureAudit reports missed stream evidence captures without satisfying upstream coverage", () => {
  const audit = buildProtocolFixtureAudit({
    scope: "upstream",
    fixtures: [
      {
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
      },
    ],
    now: () => NOW,
  });

  assert.equal(audit.scope, "upstream");
  assert.equal(audit.status, "blocked");
  assert.equal(audit.counts.total, 1);
  assert.equal(audit.counts.realUpstream, 1);
  assert.equal(audit.counts.streamEvidenceNotCaptured, 1);
  assert.equal(audit.counts.upstreamErrorFrame, 0);
  assert.equal(audit.counts.upstreamCancellation, 0);
  assert.equal(audit.counts.upstreamBackpressure, 0);
  assert.equal(audit.coverage.upstreamErrorFrame.status, "missing");
  assert.equal(audit.coverage.upstreamCancellation.status, "missing");
  assert.equal(audit.coverage.upstreamBackpressure.status, "missing");
  assert.deepEqual(audit.missing, [
    "real_upstream_error_frame_fixture",
    "real_upstream_cancellation_fixture",
    "real_upstream_backpressure_fixture",
  ]);
  assert.doesNotMatch(JSON.stringify(audit), /private diagnostic prompt|private missed stream text|token=secret/);
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

test("buildReadinessDoctorReport combines readiness and fixture audit without leaking secrets", () => {
  const report = buildReadinessDoctorReport({
    accounts,
    config: {
      stateDir: "E:\\tabbit2api\\output\\tabbit-live-state",
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
        reqCtx: "browser-context-secret",
      },
    },
    fixtures: [
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
      { operation: "sendMessage", status: "failed", adviceCategory: "forbidden", error: { status: 403, message: "risk control alpha-user@example.test token=secret" } },
    ],
    readinessState: {},
    now: () => NOW,
  });

  assert.equal(report.status, "blocked");
  assert.equal(report.stateDir, "E:\\tabbit2api\\output\\tabbit-live-state");
  assert.deepEqual(report.protocol, {
    enabled: true,
    baseUrlConfigured: true,
    sendPathConfigured: true,
    sessionVerifyPathConfigured: true,
    authSendCodePathConfigured: true,
    authSubmitCodePathConfigured: true,
    compatStripClientTools: true,
    toolLoopMode: "client_executes_tools_first",
  });
  assert.equal(report.readiness.status, "partial");
  assert.equal(report.fixtureAudit.status, "blocked");
  assert.ok(report.remainingWork.some((action) => action.includes("Codex")));
  assert.ok(report.remainingWork.some((action) => action.includes("tools-enabled")));
  assert.match(report.commands.setStateDir, /\$env:TABBIT_POOL_STATE_DIR/);
  assert.match(report.commands.readiness, /readiness --json/);
  assert.match(report.commands.fixturesAudit, /fixtures audit --json/);
  assert.match(report.commands.serveGateway, /serve --host 127\.0\.0\.1 --port 50124/);

  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /alpha-user@example\.test|cooldown-user@example\.test|quota-user@example\.test/);
  assert.doesNotMatch(text, /tabbit_session|secret-local-key|browser-context-secret|secrets\/acct_active\.cookie|secret-token|secret-session/);
});

test("buildReadinessDoctorReport exposes auth and benefits calibration backlog separately from core readiness", () => {
  const report = buildReadinessDoctorReport({
    accounts,
    config: {
      stateDir: "E:\\tabbit2api\\output\\tabbit-live-state",
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
    fixtures: [
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
      {
        operation: "sendMessage",
        status: "failed",
        input: { tools: [{ type: "function", function: { name: "lookup_private_data" } }] },
        result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
      },
      { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
    ],
    readinessState: {
      codex: { verified: true },
      claude: { verified: true },
    },
    now: () => NOW,
  });

  assert.equal(report.status, "ready");
  assert.deepEqual(report.remainingWork, []);
  assert.equal(report.manualCookieMode.status, "blocked");
  assert.equal(report.manualCookieMode.mode, "manual_reimport_then_probe");
  assert.deepEqual(report.manualCookieMode.missing, ["expired_verifySession_fixture"]);
  assert.deepEqual(report.manualCookieMode.blockingMissing, ["expired_verifySession_fixture"]);
  assert.deepEqual(report.manualCookieMode.backlogMissing, ["automated_session_refresh_strategy"]);
  assert.equal(report.manualCookieMode.automatedSessionRefresh.requiredForCurrentRelease, false);
  assert.equal(report.manualCookieMode.automatedSessionRefresh.status, "backlog");
  assert.equal(report.calibrationBacklog?.status, "blocked");
  assert.equal(report.calibrationBacklog.scopes.auth.status, "blocked");
  assert.equal(report.calibrationBacklog.scopes.benefits.status, "blocked");
  assert.equal(report.calibrationBacklog.scopes.session.status, "blocked");
  assert.equal(report.calibrationBacklog.scopes.upstream.status, "blocked");
  assert.deepEqual(report.calibrationBacklog.missing, [
    "successful_sendVerificationCode_fixture",
    "successful_submitRegistrationOrLogin_fixture",
    "successful_daily_sign_in_fixture",
    "successful_pro_activity_fixture",
    "successful_reset_coupon_consumption_fixture",
    "successful_lottery_draw_fixture",
    "expired_verifySession_fixture",
    "automated_session_refresh_strategy",
    "real_upstream_error_frame_fixture",
    "real_upstream_cancellation_fixture",
    "real_upstream_backpressure_fixture",
  ]);
  assert.ok(report.calibrationBacklog.nextActions.some((action) => action.includes("sendVerificationCode")));
  assert.ok(report.calibrationBacklog.nextActions.some((action) => action.includes("reset coupon consumption")));
  assert.ok(report.calibrationBacklog.nextActions.some((action) => action.includes("401/login_required")));
  assert.ok(report.calibrationBacklog.nextActions.some((action) => action.includes("session refresh")));
  assert.ok(report.calibrationBacklog.nextActions.some((action) => action.includes("upstream backpressure")));

  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /alpha-user@example\.test|cooldown-user@example\.test|quota-user@example\.test/);
  assert.doesNotMatch(text, /tabbit_session|secret-local-key|browser-context-secret|secrets\/acct_active\.cookie|secret-token|secret-session/);
  assert.doesNotMatch(text, /lookup_private_data/);
});

test("buildReadinessDoctorReport marks manual cookie mode ready without automated refresh evidence", () => {
  const report = buildReadinessDoctorReport({
    accounts,
    config: {
      stateDir: "E:\\tabbit2api\\output\\tabbit-live-state",
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
    fixtures: [
      { operation: "verifySession", status: "success", observedAt: "2026-07-02T03:00:00.000Z", result: { ok: true, userId: "user_123" } },
      {
        operation: "verifySession",
        status: "failed",
        observedAt: "2026-07-03T03:00:00.000Z",
        result: { ok: false, error: { category: "login_required", status: 401, message: "expired beta-user@example.test token=secret" } },
      },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
      {
        operation: "sendMessage",
        status: "failed",
        input: { tools: [{ type: "function", function: { name: "lookup_private_data" } }] },
        result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
      },
      { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
    ],
    readinessState: {
      codex: { verified: true },
      claude: { verified: true },
    },
    now: () => NOW,
  });

  assert.equal(report.status, "ready");
  assert.deepEqual(report.remainingWork, []);
  assert.equal(report.manualCookieMode.status, "ready");
  assert.equal(report.manualCookieMode.mode, "manual_reimport_then_probe");
  assert.deepEqual(report.manualCookieMode.missing, []);
  assert.deepEqual(report.manualCookieMode.blockingMissing, []);
  assert.deepEqual(report.manualCookieMode.backlogMissing, ["automated_session_refresh_strategy"]);
  assert.equal(report.manualCookieMode.automatedSessionRefresh.requiredForCurrentRelease, false);
  assert.equal(report.manualCookieMode.automatedSessionRefresh.status, "backlog");
  assert.deepEqual(report.manualCookieMode.automatedSessionRefresh.missing, ["automated_session_refresh_strategy"]);
  assert.equal(report.calibrationBacklog.status, "blocked");
  assert.ok(report.calibrationBacklog.missing.includes("automated_session_refresh_strategy"));

  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /alpha-user@example\.test|beta-user@example\.test|cooldown-user@example\.test|quota-user@example\.test/);
  assert.doesNotMatch(text, /tabbit_session|secret-local-key|browser-context-secret|secrets\/acct_active\.cookie|secret-token|token=secret|secret-session/);
  assert.doesNotMatch(text, /lookup_private_data/);
});

test("buildReadinessDoctorReport includes safe calibration capture commands", () => {
  const report = buildReadinessDoctorReport({
    accounts,
    config: {
      stateDir: "E:\\tabbit2api\\output\\tabbit-live-state",
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
    fixtures: [
      { operation: "verifySession", status: "success", observedAt: "2026-07-02T03:00:00.000Z", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
      {
        operation: "sendMessage",
        status: "failed",
        input: { tools: [{ type: "function", function: { name: "lookup_private_data" } }] },
        result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
      },
      { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
    ],
    readinessState: {
      codex: { verified: true },
      claude: { verified: true },
    },
    now: () => NOW,
  });

  assert.equal(report.status, "ready");
  assert.deepEqual(report.remainingWork, []);
  assert.equal(
    report.commands.accountPreflightReadOnly,
    "node bin\\tabbit-pool.js accounts probe <account-id> --read-only --json",
  );
  assert.equal(report.calibrationBacklog.status, "blocked");
  assert.deepEqual(report.calibrationBacklog.missing, [
    "successful_sendVerificationCode_fixture",
    "successful_submitRegistrationOrLogin_fixture",
    "successful_daily_sign_in_fixture",
    "successful_pro_activity_fixture",
    "successful_reset_coupon_consumption_fixture",
    "successful_lottery_draw_fixture",
    "expired_verifySession_fixture",
    "automated_session_refresh_strategy",
    "real_upstream_error_frame_fixture",
    "real_upstream_cancellation_fixture",
    "real_upstream_backpressure_fixture",
  ]);
  const commands = report.calibrationBacklog.captureCommands;
  assert.ok(Array.isArray(commands));

  const byMissing = Object.fromEntries(commands.map((item) => [item.missing, item]));
  assert.equal(byMissing.successful_sendVerificationCode_fixture.scope, "auth");
  assert.equal(byMissing.successful_sendVerificationCode_fixture.operation, "sendVerificationCode");
  assert.equal(byMissing.successful_sendVerificationCode_fixture.sideEffect, true);
  assert.match(byMissing.successful_sendVerificationCode_fixture.templateCommand, /probe template --operation sendVerificationCode --json/);
  assert.match(byMissing.successful_sendVerificationCode_fixture.validateCommand, /probe validate --operation sendVerificationCode --input-file <redacted-input\.json> --json/);
  assert.match(byMissing.successful_sendVerificationCode_fixture.confirmedValidateCommand, /probe validate --operation sendVerificationCode --input-file <redacted-input\.json> --require-confirmed-side-effect --json/);
  assert.match(byMissing.successful_sendVerificationCode_fixture.probeCommand, /probe protocol --account <account-id> --operation sendVerificationCode --input-file <redacted-input\.json> --write-fixture --json/);
  assert.equal(byMissing.successful_sendVerificationCode_fixture.writeFixtureCommand, null);
  assert.equal(byMissing.successful_sendVerificationCode_fixture.prerequisitesStatus, "blocked");
  assert.deepEqual(byMissing.successful_sendVerificationCode_fixture.prerequisites, [{
    name: "auth_send_code_endpoint",
    env: "TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH",
    status: "missing",
  }]);

  assert.equal(byMissing.successful_submitRegistrationOrLogin_fixture.operation, "submitRegistrationOrLogin");
  assert.match(byMissing.successful_submitRegistrationOrLogin_fixture.confirmedValidateCommand, /--require-confirmed-side-effect/);
  assert.equal(byMissing.successful_submitRegistrationOrLogin_fixture.prerequisitesStatus, "blocked");
  assert.deepEqual(byMissing.successful_submitRegistrationOrLogin_fixture.prerequisites, [{
    name: "auth_submit_code_endpoint",
    env: "TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH",
    status: "missing",
  }]);
  assert.equal(byMissing.successful_daily_sign_in_fixture.operation, "dailySignIn");
  assert.match(byMissing.successful_daily_sign_in_fixture.confirmedValidateCommand, /--require-confirmed-side-effect/);
  assert.equal(byMissing.successful_daily_sign_in_fixture.prerequisitesStatus, "blocked");
  assert.deepEqual(byMissing.successful_daily_sign_in_fixture.prerequisites, [{
    name: "daily_sign_in_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SIGN_IN_PATH",
    status: "missing",
  }]);
  assert.equal(byMissing.successful_pro_activity_fixture.operation, "participateActivity");
  assert.match(byMissing.successful_pro_activity_fixture.confirmedValidateCommand, /--require-confirmed-side-effect/);
  assert.equal(byMissing.successful_pro_activity_fixture.prerequisitesStatus, "blocked");
  assert.deepEqual(byMissing.successful_pro_activity_fixture.prerequisites, [{
    name: "activity_participate_endpoint",
    env: "TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH",
    status: "missing",
  }]);
  assert.equal(byMissing.successful_reset_coupon_consumption_fixture.operation, "useResetCoupon");
  assert.match(byMissing.successful_reset_coupon_consumption_fixture.templateCommand, /probe template --operation useResetCoupon --json/);
  assert.match(byMissing.successful_reset_coupon_consumption_fixture.validateCommand, /probe validate --operation useResetCoupon --input-file <redacted-input\.json> --json/);
  assert.match(byMissing.successful_reset_coupon_consumption_fixture.confirmedValidateCommand, /--require-confirmed-side-effect/);
  assert.match(byMissing.successful_reset_coupon_consumption_fixture.probeCommand, /probe protocol --account <account-id> --operation useResetCoupon --input-file <redacted-input\.json> --write-fixture --json/);
  assert.equal(byMissing.successful_reset_coupon_consumption_fixture.writeFixtureCommand, null);
  assert.equal(byMissing.successful_reset_coupon_consumption_fixture.prerequisitesStatus, "blocked");
  assert.deepEqual(byMissing.successful_reset_coupon_consumption_fixture.prerequisites, [{
    name: "benefit_coupon_use_endpoint",
    env: "TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_USE_PATH",
    status: "missing",
  }]);
  assert.match(byMissing.successful_reset_coupon_consumption_fixture.reason, /coupon use/i);
  assert.equal(byMissing.successful_lottery_draw_fixture.operation, "drawLottery");
  assert.match(byMissing.successful_lottery_draw_fixture.confirmedValidateCommand, /--require-confirmed-side-effect/);
  assert.equal(byMissing.successful_lottery_draw_fixture.prerequisitesStatus, "blocked");
  assert.deepEqual(byMissing.successful_lottery_draw_fixture.prerequisites, [{
    name: "lottery_draw_endpoint",
    env: "TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH",
    status: "missing",
  }]);
  assert.equal(byMissing.expired_verifySession_fixture.operation, "verifySession");
  assert.match(byMissing.expired_verifySession_fixture.validateCommand, /probe validate --operation verifySession --input-file <redacted-input\.json> --json/);
  assert.equal(byMissing.expired_verifySession_fixture.confirmedValidateCommand, null);
  assert.equal(byMissing.expired_verifySession_fixture.prerequisitesStatus, "ready");
  assert.deepEqual(byMissing.expired_verifySession_fixture.prerequisites, [{
    name: "session_verify_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH",
    status: "configured",
  }]);
  assert.equal(byMissing.automated_session_refresh_strategy.operation, "recoverSession");
  assert.match(byMissing.automated_session_refresh_strategy.templateCommand, /probe template --operation recoverSession --json/);
  assert.match(byMissing.automated_session_refresh_strategy.validateCommand, /probe validate --operation recoverSession --input-file <redacted-input\.json> --json/);
  assert.equal(byMissing.automated_session_refresh_strategy.confirmedValidateCommand, null);
  assert.equal(byMissing.automated_session_refresh_strategy.probeCommand, null);
  assert.match(byMissing.automated_session_refresh_strategy.writeFixtureCommand, /probe validate --operation recoverSession --input-file <redacted-input\.json> --write-fixture --json/);
  assert.match(byMissing.automated_session_refresh_strategy.reason, /offline/i);
  assert.equal(byMissing.real_upstream_error_frame_fixture.scope, "upstream");
  assert.equal(byMissing.real_upstream_error_frame_fixture.operation, "sendMessage");
  assert.equal(byMissing.real_upstream_error_frame_fixture.sideEffect, false);
  assert.match(byMissing.real_upstream_error_frame_fixture.templateCommand, /probe template --operation sendMessage --stream-evidence error_frame --json/);
  assert.match(byMissing.real_upstream_error_frame_fixture.validateCommand, /probe validate --operation sendMessage --input-file <redacted-input\.json> --json/);
  assert.equal(byMissing.real_upstream_error_frame_fixture.confirmedValidateCommand, null);
  assert.match(byMissing.real_upstream_error_frame_fixture.probeCommand, /probe protocol --account <account-id> --operation sendMessage --input-file <redacted-input\.json> --write-fixture --json/);
  assert.equal(byMissing.real_upstream_error_frame_fixture.requiresReviewedInput, true);
  assert.equal(byMissing.real_upstream_error_frame_fixture.reviewRequirement, "replace_redacted_message_content");
  assert.deepEqual(byMissing.real_upstream_error_frame_fixture.recommendedInput, {
    stream: true,
    streamEvidence: { mode: "error_frame", maxDeltas: 2 },
  });
  assert.equal(byMissing.real_upstream_error_frame_fixture.prerequisitesStatus, "ready");
  assert.deepEqual(byMissing.real_upstream_error_frame_fixture.prerequisites, [{
    name: "protocol_send_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
    status: "configured",
  }]);
  assert.equal(byMissing.real_upstream_cancellation_fixture.scope, "upstream");
  assert.equal(byMissing.real_upstream_cancellation_fixture.operation, "sendMessage");
  assert.match(byMissing.real_upstream_cancellation_fixture.templateCommand, /probe template --operation sendMessage --stream-evidence cancel_after_first_delta --json/);
  assert.equal(byMissing.real_upstream_cancellation_fixture.requiresReviewedInput, true);
  assert.equal(byMissing.real_upstream_cancellation_fixture.reviewRequirement, "replace_redacted_message_content");
  assert.deepEqual(byMissing.real_upstream_cancellation_fixture.recommendedInput, {
    stream: true,
    streamEvidence: { mode: "cancel_after_first_delta", maxDeltas: 2 },
  });
  assert.equal(byMissing.real_upstream_cancellation_fixture.prerequisitesStatus, "ready");
  assert.deepEqual(byMissing.real_upstream_cancellation_fixture.prerequisites, [{
    name: "protocol_send_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
    status: "configured",
  }]);
  assert.equal(byMissing.real_upstream_backpressure_fixture.scope, "upstream");
  assert.equal(byMissing.real_upstream_backpressure_fixture.operation, "sendMessage");
  assert.match(byMissing.real_upstream_backpressure_fixture.templateCommand, /probe template --operation sendMessage --stream-evidence first_token_backpressure --json/);
  assert.equal(byMissing.real_upstream_backpressure_fixture.requiresReviewedInput, true);
  assert.equal(byMissing.real_upstream_backpressure_fixture.reviewRequirement, "replace_redacted_message_content");
  assert.deepEqual(byMissing.real_upstream_backpressure_fixture.recommendedInput, {
    stream: true,
    streamEvidence: { mode: "first_token_backpressure", maxDeltas: 2 },
  });
  assert.equal(byMissing.real_upstream_backpressure_fixture.prerequisitesStatus, "ready");
  assert.deepEqual(byMissing.real_upstream_backpressure_fixture.prerequisites, [{
    name: "protocol_send_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
    status: "configured",
  }]);

  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /alpha-user@example\.test|cooldown-user@example\.test|quota-user@example\.test/);
  assert.doesNotMatch(text, /tabbit_session|secret-local-key|browser-context-secret|secrets\/acct_active\.cookie|secret-token|secret-session|Bearer\s+/);
  assert.doesNotMatch(text, /lookup_private_data/);
});

test("buildReadinessDoctorReport includes forbidden 403 capture command", () => {
  const report = buildReadinessDoctorReport({
    accounts,
    config: {
      stateDir: "E:\\tabbit2api\\output\\tabbit-live-state",
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
    fixtures: [
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
      {
        operation: "sendMessage",
        status: "failed",
        input: { tools: [{ type: "function", function: { name: "lookup_private_data" } }] },
        result: { ok: false, error: { category: "unsupported_feature", code: "***" } },
      },
    ],
    readinessState: {
      codex: { verified: true },
      claude: { verified: true },
    },
    now: () => NOW,
  });

  assert.equal(report.fixtureAudit.coverage.forbidden403.status, "missing");
  const command = report.calibrationBacklog.captureCommands.find((item) => item.missing === "forbidden_403_fixture");
  assert.ok(command);
  assert.equal(command.scope, "protocol");
  assert.equal(command.operation, "verifySession");
  assert.equal(command.sideEffect, false);
  assert.match(command.templateCommand, /probe template --operation verifySession --json/);
  assert.match(command.validateCommand, /probe validate --operation verifySession --input-file <redacted-input\.json> --json/);
  assert.equal(command.confirmedValidateCommand, null);
  assert.match(command.probeCommand, /probe protocol --account <account-id> --operation verifySession --input-file <redacted-input\.json> --write-fixture --json/);
  assert.equal(command.writeFixtureCommand, null);
  assert.equal(command.prerequisitesStatus, "ready");
  assert.deepEqual(command.prerequisites, [{
    name: "session_verify_endpoint",
    env: "TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH",
    status: "configured",
  }]);
  const text = JSON.stringify(command);
  assert.doesNotMatch(text, /https:\/\/web\.tabbit\.ai|\/api\/v0\/user\/base-info|secret-local-key|browser-context-secret|tabbit_session|Bearer\s+|lookup_private_data/i);
});

test("buildReadinessDoctorReport includes default send capture commands", () => {
  const report = buildReadinessDoctorReport({
    accounts,
    config: {
      stateDir: "E:\\tabbit2api\\output\\tabbit-live-state",
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
    fixtures: [
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
    ],
    readinessState: {
      codex: { verified: true },
      claude: { verified: true },
    },
    now: () => NOW,
  });

  assert.deepEqual(report.fixtureAudit.missing, [
    "successful_sendMessage_fixture",
    "streaming_text_fixture",
    "tool_call_fixture",
  ]);
  const byMissing = Object.fromEntries(report.calibrationBacklog.captureCommands.map((item) => [item.missing, item]));

  for (const missing of ["successful_sendMessage_fixture", "streaming_text_fixture", "tool_call_fixture"]) {
    assert.ok(byMissing[missing]);
    assert.equal(byMissing[missing].scope, "protocol");
    assert.equal(byMissing[missing].operation, "sendMessage");
    assert.equal(byMissing[missing].sideEffect, false);
    assert.match(byMissing[missing].validateCommand, /probe validate --operation sendMessage --input-file <redacted-input\.json> --json/);
    assert.match(byMissing[missing].probeCommand, /probe protocol --account <account-id> --operation sendMessage --input-file <redacted-input\.json> --write-fixture --json/);
    assert.equal(byMissing[missing].confirmedValidateCommand, null);
    assert.equal(byMissing[missing].writeFixtureCommand, null);
    assert.equal(byMissing[missing].requiresReviewedInput, true);
    assert.equal(byMissing[missing].reviewRequirement, "replace_redacted_message_content");
    assert.equal(byMissing[missing].prerequisitesStatus, "ready");
    assert.deepEqual(byMissing[missing].prerequisites, [{
      name: "protocol_send_endpoint",
      env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
      status: "configured",
    }]);
  }

  assert.match(byMissing.successful_sendMessage_fixture.templateCommand, /probe template --operation sendMessage --json/);
  assert.match(byMissing.streaming_text_fixture.templateCommand, /probe template --operation sendMessage --json/);
  assert.deepEqual(byMissing.streaming_text_fixture.recommendedInput, { stream: true });
  assert.match(byMissing.tool_call_fixture.templateCommand, /probe template --operation sendMessage --json/);
  assert.match(byMissing.tool_call_fixture.reason, /unsupported-native-tool/i);
  assert.deepEqual(byMissing.tool_call_fixture.recommendedInput, { toolEvidence: "tool_call_or_unsupported_native_tool" });

  const text = JSON.stringify(report.calibrationBacklog.captureCommands);
  assert.doesNotMatch(text, /https:\/\/web\.tabbit\.ai|\/api\/v1\/chat\/completion|\/api\/v0\/user\/base-info|secret-local-key|browser-context-secret|tabbit_session|Bearer\s+|lookup_private_data/i);
});

test("buildReadinessDoctorReport includes E2E mark commands", () => {
  const report = buildReadinessDoctorReport({
    accounts,
    config: {
      stateDir: "E:\\tabbit2api\\output\\tabbit-live-state",
      apiKey: "secret-local-key",
      protocol: {
        enabled: true,
        baseUrl: "https://web.tabbit.ai",
        sendPath: "/api/v1/chat/completion",
        sessionVerifyPath: "/api/v0/user/base-info",
        reqCtx: "browser-context-secret",
      },
    },
    fixtures: [
      { operation: "verifySession", status: "success", result: { ok: true, userId: "user_123" } },
      { operation: "sendMessage", status: "success", result: { raw: { kind: "stream" }, streamDeltas: ["ok"] } },
      { operation: "sendMessage", status: "failed", result: { ok: false, error: { category: "forbidden", status: 403 } } },
    ],
    readinessState: {},
    now: () => NOW,
  });

  assert.equal(report.readiness.checks.codexClaudeE2E.status, "blocked");
  assert.deepEqual(report.readiness.checks.codexClaudeE2E.missing, ["codex_e2e_verified", "claude_code_e2e_verified"]);
  assert.equal(report.commands.codexE2EMark, "node bin\\tabbit-pool.js readiness mark --codex-verified --json");
  assert.equal(report.commands.claudeE2EMark, "node bin\\tabbit-pool.js readiness mark --claude-verified --json");
  assert.equal(report.commands.combinedE2EMark, "node bin\\tabbit-pool.js readiness mark --codex-verified --claude-verified --json");

  const text = JSON.stringify(report.commands);
  assert.doesNotMatch(text, /https:\/\/web\.tabbit\.ai|\/api\/v1\/chat\/completion|\/api\/v0\/user\/base-info|secret-local-key|browser-context-secret|tabbit_session|Bearer\s+|user_123/i);
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
