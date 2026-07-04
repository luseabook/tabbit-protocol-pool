import { redactSensitiveValue } from "./redact.js";

const KNOWN_STATUSES = [
  "active",
  "cooldown",
  "quota_exhausted",
  "login_expired",
  "disabled",
  "provisioning",
  "suspect",
  "unknown",
];

const DISPLAY_ACCOUNT_FIELDS = [
  "id",
  "email",
  "status",
  "accessTier",
  "quotaState",
  "resetCouponCount",
  "failureStreak",
  "cooldownUntil",
  "lastSuccessAt",
  "lastCheckinAt",
  "lastMaintainedAt",
  "lastProvisioningStage",
  "lastProvisionedAt",
  "lastVerifiedAt",
];

function nowMs(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value || Date.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function nowIso(now) {
  return new Date(nowMs(now)).toISOString();
}

function sanitizeText(value) {
  if (value === null || value === undefined) return value;
  return redactSensitiveValue(value).replace(/\b\d{4,8}\b/g, "***");
}

function compactError(error = null) {
  if (!error || typeof error !== "object") return null;
  return {
    ...(error.category ? { category: String(error.category) } : {}),
    ...(error.code ? { code: String(error.code) } : {}),
    ...(error.message ? { message: sanitizeText(error.message) } : {}),
    ...(Number.isFinite(error.cooldownMs) ? { cooldownMs: error.cooldownMs } : {}),
    ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
  };
}

function statusOf(account = {}) {
  return String(account.status || "unknown");
}

function alert(code, severity, message) {
  return { code, severity, message };
}

function collectSignalText(value, parts = []) {
  if (value === null || value === undefined) return parts;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    parts.push(String(value));
    return parts;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSignalText(item, parts);
    return parts;
  }
  if (typeof value === "object") {
    for (const key of ["category", "code", "errorCode", "type", "reason", "message", "error", "detail", "body", "data"]) {
      collectSignalText(value[key], parts);
    }
  }
  return parts;
}

export function classifyForbiddenSignal(input = {}) {
  const isForbidden = input?.category === "forbidden"
    || input?.status === 403
    || input?.httpStatus === 403
    || input?.lastError?.category === "forbidden"
    || input?.lastError?.status === 403;

  if (!isForbidden) {
    return {
      kind: "not_forbidden",
      severity: "info",
      accountAction: "none",
      retryable: false,
      recommendation: "This signal is not a 403/forbidden failure; use the generic protocol advice path.",
    };
  }

  const text = collectSignalText(input).join(" ").toLowerCase();
  const base = { severity: "error", retryable: false };

  if (/\b(risk|abuse|suspicious|blocked|captcha|robot|bot|human|security)\b|风控|安全验证|人机验证/.test(text)) {
    return {
      kind: "risk_control",
      ...base,
      accountAction: "suspect",
      recommendation: "Isolate this account, avoid immediate retries, capture a redacted sendMessage fixture, and verify the session in Tabbit Web before returning it to the pool.",
    };
  }

  if (/\b(signature|sign|sign-key|timestamp|nonce|csrf|digest|hmac|payload|canonical|invalid_signature)\b|签名/.test(text)) {
    return {
      kind: "signature_or_protocol",
      severity: "warning",
      accountAction: "protocol_probe",
      retryable: false,
      recommendation: "Treat this as a protocol calibration issue first: refresh sign-key fixture, compare signed payload fields, and update signature/request-body tests before rotating accounts.",
    };
  }

  if (/\b(cookie|session|login|auth|unauthorized|expired|token|credential)\b|登录|会话/.test(text)) {
    return {
      kind: "session_or_cookie",
      ...base,
      accountAction: "login_expired",
      recommendation: "Refresh or re-import the account session, then run accounts probe before serving traffic with this account again.",
    };
  }

  if (/\b(premium|pro|plan|tier|entitlement|privilege|permission|model|access denied|not allowed|required)\b|权益|权限|模型/.test(text)) {
    return {
      kind: "entitlement_or_model",
      severity: "warning",
      accountAction: "cooldown",
      retryable: false,
      recommendation: "Check the account tier, selected model, and quota/benefit state before retrying with the same account.",
    };
  }

  return {
    kind: "unknown_forbidden",
    ...base,
    accountAction: "suspect",
    recommendation: "Check whether the local cookie/session is blocked, expired, or missing required Tabbit privileges, then capture a redacted protocol fixture before retrying.",
  };
}

export function summarizeAccounts(accounts = [], { protocolChangedThreshold = 1 } = {}) {
  const list = Array.isArray(accounts) ? accounts : [];
  const byStatus = Object.fromEntries(KNOWN_STATUSES.map((status) => [status, 0]));
  for (const account of list) {
    const status = KNOWN_STATUSES.includes(statusOf(account)) ? statusOf(account) : "unknown";
    byStatus[status] += 1;
  }

  const total = list.length;
  const active = byStatus.active;
  const unavailable = Math.max(0, total - active);
  const alerts = [];

  if (total === 0) {
    alerts.push(alert("no_accounts_configured", "warning", "No accounts are configured."));
  }
  if (total > 0 && active === 0) {
    alerts.push(alert("no_active_accounts", "critical", "No active account can serve requests."));
  }
  if (total > 0 && byStatus.quota_exhausted === total) {
    alerts.push(alert("all_accounts_quota_exhausted", "critical", "All configured accounts are quota exhausted."));
  }

  const protocolChangedCount = list.filter((account) => account?.lastError?.category === "protocol_changed").length;
  if (protocolChangedCount >= protocolChangedThreshold) {
    alerts.push(alert("protocol_changed_errors", "warning", `${protocolChangedCount} account(s) recently reported protocol_changed.`));
  }

  let health = "ok";
  if (total === 0 || active === 0) health = "unhealthy";
  else if (alerts.length || unavailable > 0) health = "degraded";

  return {
    total,
    active,
    unavailable,
    byStatus,
    health,
    alerts,
  };
}

export function redactAccountForDisplay(account = {}) {
  const display = {};
  for (const field of DISPLAY_ACCOUNT_FIELDS) {
    if (account[field] !== undefined) display[field] = account[field];
  }
  if (!display.status) display.status = "unknown";
  if (!display.accessTier) display.accessTier = "unknown";
  if (!Array.isArray(display.quotaState)) display.quotaState = [];
  if (!Number.isFinite(display.resetCouponCount)) display.resetCouponCount = 0;
  if (!Number.isFinite(display.failureStreak)) display.failureStreak = 0;
  if (display.email) display.email = sanitizeText(display.email);
  const lastError = compactError(account.lastError);
  if (lastError) display.lastError = lastError;
  return display;
}

export function redactAccountsForDisplay(accounts = []) {
  return (Array.isArray(accounts) ? accounts : []).map((account) => redactAccountForDisplay(account));
}

export function buildHealthSnapshot({
  accounts = [],
  modelCache = null,
  startedAt = null,
  now = () => Date.now(),
  mode = "protocol-pool",
} = {}) {
  const observedAt = nowMs(now);
  const accountSummary = summarizeAccounts(accounts);
  return {
    status: accountSummary.health,
    mode,
    observedAt: new Date(observedAt).toISOString(),
    ...(startedAt !== null && startedAt !== undefined ? { uptimeMs: Math.max(0, observedAt - nowMs(startedAt)) } : {}),
    accounts: {
      total: accountSummary.total,
      active: accountSummary.active,
      unavailable: accountSummary.unavailable,
      byStatus: accountSummary.byStatus,
    },
    alerts: accountSummary.alerts,
    ...(modelCache ? { modelCache: { ...modelCache } } : {}),
  };
}

function checkStatus(missing = []) {
  return missing.length ? "blocked" : "ready";
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function powershellDoubleQuoted(value) {
  return '"' + String(value || "<state-dir>").replace(/`/g, "``").replace(/"/g, '`"') + '"';
}

function readinessVerified(state = {}, key) {
  const section = state?.[key];
  if (section && typeof section === "object") return Boolean(section.verified);
  return Boolean(state?.[key + "Verified"]);
}

function combinedDoctorStatus(readinessStatus, fixtureAuditStatus) {
  if (readinessStatus === "ready" && fixtureAuditStatus === "ready") return "ready";
  if (readinessStatus === "blocked" || fixtureAuditStatus === "blocked") return "blocked";
  return "partial";
}

function protocolDoctorSummary(config = {}) {
  const protocol = config?.protocol || {};
  const compat = config?.compat || {};
  return {
    enabled: Boolean(protocol.enabled),
    baseUrlConfigured: Boolean(protocol.baseUrl),
    sendPathConfigured: Boolean(protocol.sendPath),
    sessionVerifyPathConfigured: Boolean(protocol.sessionVerifyPath),
    authSendCodePathConfigured: Boolean(protocol.authSendCodePath),
    authSubmitCodePathConfigured: Boolean(protocol.authSubmitCodePath),
    compatStripClientTools: Boolean(compat.stripClientTools),
    toolLoopMode: toolLoopModeFromConfig(config),
  };
}

function readinessDoctorCommands(stateDir) {
  return {
    setStateDir: "$env:TABBIT_POOL_STATE_DIR = " + powershellDoubleQuoted(stateDir),
    readinessDoctor: "node bin\\tabbit-pool.js readiness doctor --json",
    readiness: "node bin\\tabbit-pool.js readiness --json",
    fixturesAudit: "node bin\\tabbit-pool.js fixtures audit --json",
    authFixturesAudit: "node bin\\tabbit-pool.js fixtures audit --scope auth --json",
    benefitsFixturesAudit: "node bin\\tabbit-pool.js fixtures audit --scope benefits --json",
    sessionFixturesAudit: "node bin\\tabbit-pool.js fixtures audit --scope session --json",
    upstreamFixturesAudit: "node bin\\tabbit-pool.js fixtures audit --scope upstream --json",
    serveGateway: "node bin\\tabbit-pool.js serve --host 127.0.0.1 --port 50124",
  };
}

function probeTemplateCommand(operation) {
  if (!operation) return null;
  return "node bin\\tabbit-pool.js probe template --operation " + operation + " --json";
}

function probeValidateCommand(operation) {
  if (!operation) return null;
  return "node bin\\tabbit-pool.js probe validate --operation "
    + operation
    + " --input-file <redacted-input.json> --json";
}

function probeConfirmedSideEffectValidateCommand(operation, sideEffect) {
  if (!operation || !sideEffect) return null;
  return "node bin\\tabbit-pool.js probe validate --operation "
    + operation
    + " --input-file <redacted-input.json> --require-confirmed-side-effect --json";
}

function probeProtocolCommand(operation) {
  if (!operation) return null;
  return "node bin\\tabbit-pool.js probe protocol --account <account-id> --operation "
    + operation
    + " --input-file <redacted-input.json> --write-fixture --json";
}

const OFFLINE_EVIDENCE_WRITE_FIXTURE_MISSING = new Set([
  "automated_session_refresh_strategy",
]);

function probeValidateWriteFixtureCommand(operation) {
  if (!operation) return null;
  return "node bin\\tabbit-pool.js probe validate --operation "
    + operation
    + " --input-file <redacted-input.json> --write-fixture --json";
}

function writeFixtureCommandForMissing(missingName, operation) {
  if (!OFFLINE_EVIDENCE_WRITE_FIXTURE_MISSING.has(missingName)) return null;
  return probeValidateWriteFixtureCommand(operation);
}

const CALIBRATION_CAPTURE_SPECS = {
  successful_sendVerificationCode_fixture: {
    scope: "auth",
    operation: "sendVerificationCode",
    sideEffect: true,
    prerequisites: [{
      name: "auth_send_code_endpoint",
      env: "TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH",
      protocolKey: "authSendCodePath",
    }],
    reason: "Generate a redacted auth send-code input file from the template, set confirmSideEffect only after endpoint/body safety review, then keep the sanitized fixture.",
  },
  successful_submitRegistrationOrLogin_fixture: {
    scope: "auth",
    operation: "submitRegistrationOrLogin",
    sideEffect: true,
    prerequisites: [{
      name: "auth_submit_code_endpoint",
      env: "TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH",
      protocolKey: "authSubmitCodePath",
    }],
    reason: "Generate a redacted auth submit-code input file from the template, use a disposable code, and keep only sanitized session material shape evidence.",
  },
  successful_daily_sign_in_fixture: {
    scope: "benefits",
    operation: "dailySignIn",
    sideEffect: true,
    prerequisites: [{
      name: "daily_sign_in_endpoint",
      env: "TABBIT_POOL_PROTOCOL_SIGN_IN_PATH",
      protocolKey: "signInPath",
    }],
    reason: "Generate a redacted daily sign-in input file from the template, confirm the side effect is safe, and keep the sanitized success fixture.",
  },
  successful_pro_activity_fixture: {
    scope: "benefits",
    operation: "participateActivity",
    sideEffect: true,
    prerequisites: [{
      name: "activity_participate_endpoint",
      env: "TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH",
      protocolKey: "activityParticipatePath",
    }],
    reason: "Generate a redacted activity participation input file from the template and capture a safe Pro-specific success fixture before enabling automatic claims.",
  },
  successful_reset_coupon_consumption_fixture: {
    scope: "benefits",
    operation: "useResetCoupon",
    sideEffect: true,
    prerequisites: [{
      name: "benefit_coupon_use_endpoint",
      env: "TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_USE_PATH",
      protocolKey: "benefitCouponUsePath",
    }],
    reason: "Generate a redacted coupon use input file from the template, confirm the side effect after selecting a safe coupon, then keep the sanitized reset-coupon consumption fixture.",
  },
  successful_lottery_draw_fixture: {
    scope: "benefits",
    operation: "drawLottery",
    sideEffect: true,
    prerequisites: [{
      name: "lottery_draw_endpoint",
      env: "TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH",
      protocolKey: "lotteryDrawPath",
    }],
    reason: "Generate a redacted lottery draw input file from the template and only run it for an account with a disposable lottery chance.",
  },
  successful_verifySession_fixture: {
    scope: "session",
    operation: "verifySession",
    sideEffect: false,
    prerequisites: [{
      name: "session_verify_endpoint",
      env: "TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH",
      protocolKey: "sessionVerifyPath",
    }],
    reason: "Run a read-only verifySession probe and keep the sanitized success fixture.",
  },
  expired_verifySession_fixture: {
    scope: "session",
    operation: "verifySession",
    sideEffect: false,
    prerequisites: [{
      name: "session_verify_endpoint",
      env: "TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH",
      protocolKey: "sessionVerifyPath",
    }],
    reason: "After a session expires, run a read-only verifySession probe and keep the sanitized 401/login_required fixture.",
  },
  automated_session_refresh_strategy: {
    scope: "session",
    operation: "recoverSession",
    sideEffect: false,
    protocolProbe: false,
    reason: "Use the offline recoverSession evidence template and validator to prepare sanitized refresh or re-auth recovery evidence; no calibrated protocol probe exists yet.",
  },
  real_upstream_error_frame_fixture: {
    scope: "upstream",
    operation: "sendMessage",
    sideEffect: false,
    prerequisites: [{
      name: "protocol_send_endpoint",
      env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
      protocolKey: "sendPath",
    }],
    reason: "Generate a redacted stream:true sendMessage input file and keep a sanitized real-upstream error-frame fixture with explicit upstream evidence markers.",
  },
  real_upstream_cancellation_fixture: {
    scope: "upstream",
    operation: "sendMessage",
    sideEffect: false,
    prerequisites: [{
      name: "protocol_send_endpoint",
      env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
      protocolKey: "sendPath",
    }],
    reason: "Generate a redacted stream:true sendMessage input file and capture a sanitized real-upstream cancellation or disconnect fixture with explicit upstream evidence markers.",
  },
  real_upstream_backpressure_fixture: {
    scope: "upstream",
    operation: "sendMessage",
    sideEffect: false,
    prerequisites: [{
      name: "protocol_send_endpoint",
      env: "TABBIT_POOL_PROTOCOL_SEND_PATH",
      protocolKey: "sendPath",
    }],
    reason: "Generate a redacted stream:true sendMessage input file and capture sanitized real-upstream backpressure or first-token-flush evidence with delayed continuation markers.",
  },
};

function capturePrerequisitesForSpec(spec = {}, config = {}) {
  return (Array.isArray(spec.prerequisites) ? spec.prerequisites : []).map((item = {}) => ({
    name: item.name,
    env: item.env,
    status: config?.protocol?.[item.protocolKey] ? "configured" : "missing",
  }));
}

function captureCommandForMissing(missingName, config = {}) {
  const spec = CALIBRATION_CAPTURE_SPECS[missingName];
  if (!spec) return null;
  const prerequisites = capturePrerequisitesForSpec(spec, config);
  return {
    missing: missingName,
    scope: spec.scope,
    operation: spec.operation,
    sideEffect: Boolean(spec.sideEffect),
    templateCommand: probeTemplateCommand(spec.operation),
    validateCommand: probeValidateCommand(spec.operation),
    confirmedValidateCommand: spec.protocolProbe === false ? null : probeConfirmedSideEffectValidateCommand(spec.operation, spec.sideEffect),
    probeCommand: spec.protocolProbe === false ? null : probeProtocolCommand(spec.operation),
    writeFixtureCommand: writeFixtureCommandForMissing(missingName, spec.operation),
    prerequisitesStatus: prerequisites.every((item) => item.status === "configured") ? "ready" : "blocked",
    prerequisites,
    reason: spec.reason,
  };
}

function buildCalibrationCaptureCommands(missingNames = [], config = {}) {
  return uniqueStrings(missingNames)
    .map((missingName) => captureCommandForMissing(missingName, config))
    .filter(Boolean);
}

function toolLoopRecommendation(mode) {
  if (mode === "disabled") {
    return "Gateway-local tool execution is disabled; tool requests will reject or pass through according to the compat/protocol path, and capable clients must execute tools themselves.";
  }
  if (mode === "local_executes_tools") {
    return "Gateway-local tool execution is opt-in and requires an injected local tool executor; keep tool definitions allowlisted and bounded.";
  }
  return "Keep the gateway as an official API compatibility layer unless a target client cannot execute returned tool calls.";
}

function toolLoopModeFromConfig(config = {}) {
  const mode = config?.compat?.toolLoopMode;
  if (mode === "disabled" || mode === "local_executes_tools") return mode;
  return "client_executes_tools_first";
}

function fixtureMatchesSendSuccess(fixture = {}) {
  return fixture?.operation === "sendMessage" && fixture?.status === "success";
}

function fixtureMatchesSendMessage(fixture = {}) {
  return fixture?.operation === "sendMessage";
}

function fixtureMatchesSessionVerifySuccess(fixture = {}) {
  return fixture?.operation === "verifySession" && fixture?.status === "success";
}

function fixtureError(fixture = {}) {
  const result = fixtureResult(fixture);
  return fixture?.error || result?.error || {};
}

function fixtureMatchesSessionExpired(fixture = {}) {
  if (fixture?.operation !== "verifySession" || fixture?.status !== "failed") return false;
  if (fixtureMatchesSessionMissing(fixture)) return false;
  const error = fixtureError(fixture);
  return error?.category === "login_required"
    || error?.status === 401
    || error?.httpStatus === 401
    || fixture?.httpStatus === 401
    || fixture?.statusCode === 401;
}

function fixtureMatchesSessionMissing(fixture = {}) {
  if (fixture?.operation !== "verifySession" || fixture?.status !== "failed") return false;
  const error = fixtureError(fixture);
  return error?.category === "session_missing" || error?.code === "SESSION_MISSING";
}

const SESSION_RECOVERY_STRATEGIES = new Set([
  "automated_reauth",
  "refresh_token",
]);

const SESSION_RECOVERY_REFRESH_MODES = new Set([
  "calibrated_reauth_probe",
  "calibrated_refresh_probe",
]);

function fixtureSessionRecoveryEvidence(fixture = {}) {
  const result = fixtureResult(fixture);
  const evidence = fixture?.evidence
    || fixture?.recoveryStrategy
    || result?.evidence
    || result?.recoveryStrategy
    || {};
  return evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {};
}

function sessionRecoveryStrategyEvidence(fixture = {}) {
  if (fixture?.kind !== "session_recovery_strategy" && fixture?.operation !== "recoverSession") return null;
  if (fixture?.status !== "success") return null;
  const evidence = fixtureSessionRecoveryEvidence(fixture);
  if (evidence.safe !== true || evidence.sanitized !== true) return null;
  const rawPayload = Object.prototype.hasOwnProperty.call(evidence, "rawPayload")
    ? evidence.rawPayload
    : evidence.raw_payload;
  if (rawPayload !== false) return null;
  const current = lowerString(evidence.strategy || evidence.current);
  const automatedRefresh = lowerString(evidence.automatedRefresh || evidence.automated_refresh || evidence.mode);
  if (!SESSION_RECOVERY_STRATEGIES.has(current)) return null;
  if (!SESSION_RECOVERY_REFRESH_MODES.has(automatedRefresh)) return null;
  return { status: "ready", current, automatedRefresh };
}

function fixtureMatchesForbidden(fixture = {}) {
  const result = fixtureResult(fixture);
  return fixture?.adviceCategory === "forbidden"
    || fixture?.error?.category === "forbidden"
    || fixture?.error?.status === 403
    || result?.error?.category === "forbidden"
    || result?.error?.status === 403
    || fixture?.httpStatus === 403
    || fixture?.statusCode === 403;
}


function deepContains(value, predicate, seen = new Set()) {
  if (value === null || value === undefined) return false;
  if (predicate(value)) return true;
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => deepContains(item, predicate, seen));
  return Object.values(value).some((item) => deepContains(item, predicate, seen));
}

function fixtureResult(fixture = {}) {
  return fixture?.result || fixture?.response || fixture?.raw || {};
}

function fixtureSourceText(fixture = {}) {
  const result = fixtureResult(fixture);
  return [
    fixture?.source,
    fixture?.evidenceSource,
    fixture?.upstreamEvidence?.source,
    result?.source,
    result?.evidenceSource,
    result?.upstreamEvidence?.source,
    result?.raw?.source,
  ].filter(Boolean).map(String).join(" ").toLowerCase();
}

function fixtureUpstreamEvidence(fixture = {}) {
  const result = fixtureResult(fixture);
  const evidence = fixture?.upstreamEvidence || result?.upstreamEvidence || result?.raw?.upstreamEvidence || {};
  return evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {};
}

function fixtureIsRealUpstreamEvidence(fixture = {}) {
  if (!fixtureMatchesSendMessage(fixture)) return false;
  const sourceText = fixtureSourceText(fixture);
  if (/\b(local|http-server|route|compat|unit|synthetic|fake|mock)\b/.test(sourceText)) return false;
  if (!fixtureHasStreamMetadata(fixture)) return false;
  const result = fixtureResult(fixture);
  const evidence = fixtureUpstreamEvidence(fixture);
  return Boolean(
    fixture?.kind === "protocol_probe"
    || /tabbit|protocol|upstream|live/.test(sourceText)
    || evidence.real === true
    || result?.raw?.upstream === true
  );
}

function fixtureRawStream(fixture = {}) {
  const result = fixtureResult(fixture);
  if (result?.raw?.kind === "stream") return result.raw;
  if (result?.kind === "stream") return result;
  if (fixture?.raw?.kind === "stream") return fixture.raw;
  return null;
}

function fixtureHasStreamMetadata(fixture = {}) {
  return Boolean(fixtureRawStream(fixture));
}

function streamEventLooksLikeError(event = {}) {
  if (!event || typeof event !== "object") return false;
  const eventName = lowerString(event.event || event.type || event?.data?.event || event?.data?.type);
  return eventName === "error"
    || Boolean(event.error || event.errorCode || event?.data?.error || event?.data?.errorCode);
}

function fixtureMatchesUpstreamErrorFrame(fixture = {}) {
  if (!fixtureIsRealUpstreamEvidence(fixture)) return false;
  const result = fixtureResult(fixture);
  const evidence = fixtureUpstreamEvidence(fixture);
  if (evidence.errorFrame === true || evidence.streamErrorFrame === true) return true;
  const raw = fixtureRawStream(fixture);
  if (Array.isArray(raw?.events) && raw.events.some(streamEventLooksLikeError)) return true;
  return fixture?.status === "failed"
    && fixtureHasStreamMetadata(fixture)
    && Boolean(fixture?.error?.category || result?.error?.category || result?.raw?.error || result?.raw?.errorCode);
}

function fixtureMatchesUpstreamCancellation(fixture = {}) {
  if (!fixtureIsRealUpstreamEvidence(fixture)) return false;
  const evidence = fixtureUpstreamEvidence(fixture);
  return evidence.cancellation === true
    || evidence.cancelled === true
    || evidence.canceled === true
    || evidence.disconnect === true
    || evidence.disconnected === true;
}

function fixtureMatchesUpstreamBackpressure(fixture = {}) {
  if (!fixtureIsRealUpstreamEvidence(fixture)) return false;
  const evidence = fixtureUpstreamEvidence(fixture);
  return evidence.backpressure === true
    || (evidence.firstTokenFlush === true && evidence.delayedSecondChunk === true)
    || (evidence.firstChunkFlushed === true && evidence.delayedContinuation === true);
}

function fixtureToolProbeInput(fixture = {}) {
  const input = fixture?.input || fixture?.request || fixture?.payload || {};
  return Boolean(
    (Array.isArray(input?.tools) && input.tools.length > 0)
    || input?.tool_choice
    || input?.toolChoice
    || Object.prototype.hasOwnProperty.call(input, "parallel_tool_calls")
    || Object.prototype.hasOwnProperty.call(input, "parallelToolCalls")
  );
}

function fixtureMatchesToolUnsupportedEvidence(fixture = {}) {
  if (fixture?.operation !== "sendMessage") return false;
  const result = fixtureResult(fixture);
  if (fixture?.toolCallsSupported === false || result?.toolCallsSupported === false) return true;
  if (fixture?.toolSupport === "unsupported" || result?.toolSupport === "unsupported") return true;
  if (!fixtureToolProbeInput(fixture)) return false;
  if (fixture?.error?.category === "unsupported_feature" || result?.error?.category === "unsupported_feature") return true;

  const signalText = [
    fixture?.adviceCategory,
    fixture?.advice?.category,
    fixture?.advice?.code,
    fixture?.error?.category,
    fixture?.error?.code,
    fixture?.error?.message,
    result?.error?.category,
    result?.error?.code,
    result?.error?.message,
  ].filter(Boolean).map(String).join(" ").toLowerCase();

  return signalText.includes("tool") && (
    signalText.includes("unsupported")
    || signalText.includes("not supported")
    || signalText.includes("not_supported")
    || signalText.includes("unknown field")
    || signalText.includes("invalid field")
    || signalText.includes("invalid_request")
    || signalText.includes("schema")
  );
}

function fixtureMatchesStreamingText(fixture = {}) {
  if (fixture?.operation !== "sendMessage" || fixture?.status !== "success") return false;
  const result = fixtureResult(fixture);
  return Boolean(
    result?.raw?.kind === "stream"
    || result?.kind === "stream"
    || (Array.isArray(result?.streamDeltas) && result.streamDeltas.length > 0)
    || (Array.isArray(fixture?.streamDeltas) && fixture.streamDeltas.length > 0)
    || deepContains(result, (value) => value && typeof value === "object" && (value.format === "sse" || value.format === "ndjson")),
  );
}

function fixtureMatchesToolCall(fixture = {}) {
  if (fixtureMatchesToolUnsupportedEvidence(fixture)) return true;
  if (fixture?.operation !== "sendMessage" || fixture?.status !== "success") return false;
  return deepContains(fixtureResult(fixture), (value) => {
    if (!value || typeof value !== "object") return false;
    if (value.type === "tool_use" || value.type === "tool_call" || value.type === "function_call") return true;
    if (Array.isArray(value.tool_calls) && value.tool_calls.length > 0) return true;
    if (value.name && (value.input || value.arguments || value.function)) return true;
    return false;
  });
}

function coverageItem(count, readyName, missingName) {
  return {
    status: count > 0 ? "ready" : "missing",
    count,
    readyName,
    missingName,
  };
}

function validIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function latestObservedAt(fixtures = []) {
  let latest = null;
  for (const fixture of fixtures) {
    const iso = validIso(fixture?.observedAt);
    if (!iso) continue;
    if (!latest || Date.parse(iso) > Date.parse(latest)) latest = iso;
  }
  return latest;
}

function observedWindowMs(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function fixtureMatchesAuthSendSuccess(fixture = {}) {
  return fixture?.operation === "sendVerificationCode" && fixture?.status === "success";
}

function fixtureMatchesAuthSendDeliverySuccess(fixture = {}) {
  if (!fixtureMatchesAuthSendSuccess(fixture)) return false;
  const result = fixtureResult(fixture);
  return booleanFieldIsTrue(result, [
    "codeSent",
    "code_sent",
    "verificationCodeSent",
    "verification_code_sent",
    "sent",
    "emailSent",
    "email_sent",
    "mailSent",
    "mail_sent",
    "smsSent",
    "sms_sent",
  ]) || stringFieldMatches(result, [
    "sendResult",
    "send_result",
    "deliveryResult",
    "delivery_result",
    "verificationResult",
    "verification_result",
    "codeSendResult",
    "code_send_result",
  ], AUTH_SEND_DELIVERY_SUCCESS_VALUES);
}

function fixtureMatchesAuthSubmitSuccess(fixture = {}) {
  return fixture?.operation === "submitRegistrationOrLogin" && fixture?.status === "success";
}

function hasSessionMaterialShape(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

function hasEvidenceShape(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== false;
}

function fixtureMatchesAuthSubmitSessionMaterialSuccess(fixture = {}) {
  if (!fixtureMatchesAuthSubmitSuccess(fixture)) return false;
  const result = fixtureResult(fixture);
  return hasSessionMaterialShape(result?.cookieHeader)
    || hasSessionMaterialShape(result?.cookieJar)
    || hasSessionMaterialShape(result?.cookie)
    || hasSessionMaterialShape(result?.session)
    || hasSessionMaterialShape(result?.sessionToken)
    || hasSessionMaterialShape(result?.token);
}

function lowerString(value) {
  return String(value || "").trim().toLowerCase();
}

function valueForAnyKey(value, keys = [], seen = new Set()) {
  if (value === null || value === undefined || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = valueForAnyKey(item, keys, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const item of Object.values(value)) {
    const found = valueForAnyKey(item, keys, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function stringFieldMatches(value, keys, allowedValues) {
  const found = valueForAnyKey(value, keys);
  return found !== undefined && allowedValues.has(lowerString(found));
}

function booleanFieldIsTrue(value, keys) {
  return valueForAnyKey(value, keys) === true;
}

const AUTH_SEND_DELIVERY_SUCCESS_VALUES = new Set([
  "success",
  "succeeded",
  "ok",
  "sent",
  "delivered",
  "accepted",
  "queued",
  "scheduled",
]);

const BENEFIT_SUCCESS_VALUES = new Set([
  "success",
  "succeeded",
  "ok",
  "done",
  "participated",
  "claimed",
  "received",
  "consumed",
  "used",
  "drawn",
  "hit",
]);
const DAILY_SIGN_IN_SUCCESS_VALUES = new Set([
  "success",
  "already_signed",
  "already signed",
]);

export const BENEFITS_AUDIT_OPERATIONS = Object.freeze([
  "dailySignIn",
  "participateResetCouponActivity",
  "participateActivity",
  "drawLottery",
  "useResetCoupon",
  "consumeResetCoupon",
  "consumeResetCouponSku",
  "redeemResetCoupon",
]);

const NON_CONSUMPTION_VALUES = new Set([
  "already_participated",
  "already participated",
  "already_signed",
  "already signed",
  "already_claimed",
  "already claimed",
]);

function containsNonConsumptionSignal(value = {}) {
  return stringFieldMatches(value, [
    "participationResult",
    "participation_result",
    "consumeResult",
    "consume_result",
    "couponResult",
    "coupon_result",
    "result",
    "status",
  ], NON_CONSUMPTION_VALUES);
}

function safeSha256Evidence(value) {
  return typeof value === "string" && /^sha256:[^:\s].*/.test(value.trim());
}

function resetCouponRawPayload(evidence = {}) {
  if (Object.prototype.hasOwnProperty.call(evidence, "rawPayload")) return evidence.rawPayload;
  if (Object.prototype.hasOwnProperty.call(evidence, "raw_payload")) return evidence.raw_payload;
  return undefined;
}

function fixtureResetCouponConsumptionEvidence(fixture = {}) {
  const result = fixtureResult(fixture);
  const evidence = fixture?.evidence
    || fixture?.consumptionEvidence
    || result?.evidence
    || result?.consumptionEvidence
    || {};
  return evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {};
}

function fixtureHasResetCouponConsumptionEvidence(fixture = {}) {
  const evidence = fixtureResetCouponConsumptionEvidence(fixture);
  return evidence.safe === true
    && evidence.sanitized === true
    && resetCouponRawPayload(evidence) === false
    && safeSha256Evidence(evidence.endpointHash)
    && safeSha256Evidence(evidence.bodyHash)
    && safeSha256Evidence(evidence.resultHash);
}

function fixtureMatchesBenefitsAuditOperation(fixture = {}) {
  return BENEFITS_AUDIT_OPERATIONS.includes(fixture?.operation);
}

function fixtureMatchesDailySignInSuccess(fixture = {}) {
  if (fixture?.operation !== "dailySignIn" || fixture?.status !== "success") return false;
  const result = fixtureResult(fixture);
  return stringFieldMatches(result, ["signInResult", "sign_in_result"], DAILY_SIGN_IN_SUCCESS_VALUES)
    || booleanFieldIsTrue(result, ["signedToday", "signed_today"]);
}

function fixtureMatchesProActivitySuccess(fixture = {}) {
  if (fixture?.operation !== "participateActivity" || fixture?.status !== "success") return false;
  const result = fixtureResult(fixture);
  if (containsNonConsumptionSignal(result)) return false;
  return stringFieldMatches(result, [
    "participationResult",
    "participation_result",
    "activityResult",
    "activity_result",
    "claimResult",
    "claim_result",
    "proResult",
    "pro_result",
  ], BENEFIT_SUCCESS_VALUES);
}

function fixtureMatchesResetCouponConsumptionSuccess(fixture = {}) {
  if (fixture?.status !== "success") return false;
  const operation = String(fixture?.operation || "");
  if (!["useResetCoupon", "consumeResetCoupon", "consumeResetCouponSku", "redeemResetCoupon"].includes(operation)) return false;
  if (!fixtureHasResetCouponConsumptionEvidence(fixture)) return false;
  const result = fixtureResult(fixture);
  if (containsNonConsumptionSignal(result)) return false;
  return booleanFieldIsTrue(result, [
    "resetCouponConsumed",
    "reset_coupon_consumed",
    "couponConsumed",
    "coupon_consumed",
    "consumed",
    "used",
    "deducted",
  ]) || stringFieldMatches(result, [
    "consumeResult",
    "consume_result",
    "couponResult",
    "coupon_result",
    "usageResult",
    "usage_result",
  ], BENEFIT_SUCCESS_VALUES);
}

function fixtureMatchesLotteryDrawSuccess(fixture = {}) {
  if (fixture?.operation !== "drawLottery" || fixture?.status !== "success") return false;
  const result = fixtureResult(fixture);
  if (stringFieldMatches(result, [
    "drawResult",
    "draw_result",
    "lotteryResult",
    "lottery_result",
  ], BENEFIT_SUCCESS_VALUES)) return true;
  return hasEvidenceShape(valueForAnyKey(result, ["prize", "award", "reward", "hitRecord", "hit_record", "hitRecordId", "hit_record_id"]));
}

function buildAuthFixtureAudit({ fixtures = [], now = () => Date.now() } = {}) {
  const fixtureList = Array.isArray(fixtures)
    ? fixtures.filter((fixture) => fixture?.operation === "sendVerificationCode" || fixture?.operation === "submitRegistrationOrLogin")
    : [];
  const sendVerificationCode = fixtureList.filter((fixture) => fixture?.operation === "sendVerificationCode").length;
  const submitRegistrationOrLogin = fixtureList.filter((fixture) => fixture?.operation === "submitRegistrationOrLogin").length;
  const successfulSendVerificationCode = fixtureList.filter(fixtureMatchesAuthSendSuccess).length;
  const successfulSendVerificationCodeWithDeliverySignal = fixtureList.filter(fixtureMatchesAuthSendDeliverySuccess).length;
  const successfulSubmitRegistrationOrLogin = fixtureList.filter(fixtureMatchesAuthSubmitSuccess).length;
  const successfulSubmitRegistrationOrLoginWithSessionMaterial = fixtureList.filter(fixtureMatchesAuthSubmitSessionMaterialSuccess).length;
  const coverage = {
    authSendVerificationCode: coverageItem(successfulSendVerificationCodeWithDeliverySignal, "successful_sendVerificationCode_fixture", "successful_sendVerificationCode_fixture"),
    authSubmitRegistrationOrLogin: coverageItem(successfulSubmitRegistrationOrLoginWithSessionMaterial, "successful_submitRegistrationOrLogin_fixture", "successful_submitRegistrationOrLogin_fixture"),
  };
  const missing = Object.values(coverage)
    .filter((item) => item.status !== "ready")
    .map((item) => item.missingName);
  const nextActions = [];
  if (missing.includes("successful_sendVerificationCode_fixture")) {
    nextActions.push("Run probe protocol --operation sendVerificationCode with confirmSideEffect:true and keep a sanitized success fixture.");
  }
  if (missing.includes("successful_submitRegistrationOrLogin_fixture")) {
    nextActions.push("Run probe protocol --operation submitRegistrationOrLogin with confirmSideEffect:true and keep a sanitized success fixture that proves session material shape.");
  }

  return {
    scope: "auth",
    status: missing.length ? "blocked" : "ready",
    observedAt: nowIso(now),
    counts: {
      total: fixtureList.length,
      sendVerificationCode,
      submitRegistrationOrLogin,
      successfulSendVerificationCode,
      successfulSendVerificationCodeWithDeliverySignal,
      successfulSubmitRegistrationOrLogin,
      successfulSubmitRegistrationOrLoginWithSessionMaterial,
      success: fixtureList.filter((fixture) => fixture?.status === "success").length,
      failed: fixtureList.filter((fixture) => fixture?.status === "failed").length,
    },
    coverage,
    missing,
    nextActions,
  };
}

function buildBenefitsFixtureAudit({ fixtures = [], now = () => Date.now() } = {}) {
  const fixtureList = Array.isArray(fixtures) ? fixtures.filter(fixtureMatchesBenefitsAuditOperation) : [];
  const successfulDailySignIn = fixtureList.filter(fixtureMatchesDailySignInSuccess).length;
  const successfulProActivity = fixtureList.filter(fixtureMatchesProActivitySuccess).length;
  const successfulResetCouponConsumption = fixtureList.filter(fixtureMatchesResetCouponConsumptionSuccess).length;
  const successfulLotteryDraw = fixtureList.filter(fixtureMatchesLotteryDrawSuccess).length;
  const coverage = {
    dailySignIn: coverageItem(successfulDailySignIn, "successful_daily_sign_in_fixture", "successful_daily_sign_in_fixture"),
    proActivitySuccess: coverageItem(successfulProActivity, "successful_pro_activity_fixture", "successful_pro_activity_fixture"),
    resetCouponConsumption: coverageItem(successfulResetCouponConsumption, "successful_reset_coupon_consumption_fixture", "successful_reset_coupon_consumption_fixture"),
    lotteryDrawSuccess: coverageItem(successfulLotteryDraw, "successful_lottery_draw_fixture", "successful_lottery_draw_fixture"),
  };
  const missing = Object.values(coverage)
    .filter((item) => item.status !== "ready")
    .map((item) => item.missingName);
  const nextActions = [];
  if (missing.includes("successful_daily_sign_in_fixture")) {
    nextActions.push("Run probe protocol --operation dailySignIn with confirmSideEffect:true and keep a sanitized success fixture.");
  }
  if (missing.includes("successful_pro_activity_fixture")) {
    nextActions.push("Capture a safe sanitized participateActivity success fixture before enabling automatic Pro claims.");
  }
  if (missing.includes("successful_reset_coupon_consumption_fixture")) {
    nextActions.push("Identify the real reset coupon consumption endpoint/body/result hash and keep a sanitized success fixture; already_participated activity evidence is not enough.");
  }
  if (missing.includes("successful_lottery_draw_fixture")) {
    nextActions.push("Capture a safe sanitized drawLottery success fixture from an account with disposable lottery chance before classifying draw success.");
  }

  return {
    scope: "benefits",
    status: missing.length ? "blocked" : "ready",
    observedAt: nowIso(now),
    counts: {
      total: fixtureList.length,
      dailySignIn: fixtureList.filter((fixture) => fixture?.operation === "dailySignIn").length,
      participateResetCouponActivity: fixtureList.filter((fixture) => fixture?.operation === "participateResetCouponActivity").length,
      participateActivity: fixtureList.filter((fixture) => fixture?.operation === "participateActivity").length,
      drawLottery: fixtureList.filter((fixture) => fixture?.operation === "drawLottery").length,
      useResetCoupon: fixtureList.filter((fixture) => fixture?.operation === "useResetCoupon").length,
      consumeResetCoupon: fixtureList.filter((fixture) => fixture?.operation === "consumeResetCoupon").length,
      consumeResetCouponSku: fixtureList.filter((fixture) => fixture?.operation === "consumeResetCouponSku").length,
      redeemResetCoupon: fixtureList.filter((fixture) => fixture?.operation === "redeemResetCoupon").length,
      successfulDailySignIn,
      successfulProActivity,
      successfulResetCouponConsumption,
      successfulLotteryDraw,
      success: fixtureList.filter((fixture) => fixture?.status === "success").length,
      failed: fixtureList.filter((fixture) => fixture?.status === "failed").length,
    },
    coverage,
    missing,
    nextActions,
  };
}

function buildSessionFixtureAudit({ fixtures = [], now = () => Date.now() } = {}) {
  const fixtureList = Array.isArray(fixtures) ? fixtures : [];
  const sessionFixtures = fixtureList.filter((fixture) => fixture?.operation === "verifySession");
  const recoveryEvidence = fixtureList
    .map(sessionRecoveryStrategyEvidence)
    .filter(Boolean);
  const successfulFixtures = sessionFixtures.filter(fixtureMatchesSessionVerifySuccess);
  const expiredFixtures = sessionFixtures.filter(fixtureMatchesSessionExpired);
  const sessionMissingFixtures = sessionFixtures.filter(fixtureMatchesSessionMissing);
  const successfulVerifySession = successfulFixtures.length;
  const expiredVerifySession = expiredFixtures.length;
  const sessionMissing = sessionMissingFixtures.length;
  const coverage = {
    successfulSessionVerify: coverageItem(successfulVerifySession, "successful_verifySession_fixture", "successful_verifySession_fixture"),
    expiredSessionSignal: coverageItem(expiredVerifySession, "expired_verifySession_fixture", "expired_verifySession_fixture"),
  };
  const recoveryStrategy = recoveryEvidence[0] || {
    status: "blocked",
    current: "manual_reimport_then_probe",
    automatedRefresh: "not_calibrated",
  };
  const missing = [
    ...Object.values(coverage)
    .filter((item) => item.status !== "ready")
      .map((item) => item.missingName),
    ...(recoveryStrategy.status === "ready" ? [] : ["automated_session_refresh_strategy"]),
  ];
  const nextActions = [];
  if (missing.includes("successful_verifySession_fixture")) {
    nextActions.push("Run probe protocol --operation verifySession --write-fixture and keep a sanitized success fixture.");
  }
  if (missing.includes("expired_verifySession_fixture")) {
    nextActions.push("After a session expires, run read-only probe protocol --operation verifySession --write-fixture and keep a sanitized 401/login_required fixture.");
  }
  if (missing.includes("automated_session_refresh_strategy")) {
    nextActions.push("Capture and test a safe session refresh or re-auth recovery path before enabling automated session recovery.");
  }
  const lastSuccessfulAt = latestObservedAt(successfulFixtures);
  const lastExpiredAt = latestObservedAt(expiredFixtures);

  return {
    scope: "session",
    status: missing.length ? "blocked" : "ready",
    observedAt: nowIso(now),
    counts: {
      total: sessionFixtures.length,
      verifySession: sessionFixtures.length,
      successfulVerifySession,
      expiredVerifySession,
      sessionMissing,
      recoveryStrategyEvidence: recoveryEvidence.length,
      success: sessionFixtures.filter((fixture) => fixture?.status === "success").length,
      failed: sessionFixtures.filter((fixture) => fixture?.status === "failed").length,
    },
    coverage,
    lifecycle: {
      lastSuccessfulAt,
      lastExpiredAt,
      observedWindowMs: observedWindowMs(lastSuccessfulAt, lastExpiredAt),
    },
    recoveryStrategy,
    missing,
    nextActions,
  };
}

function buildUpstreamFixtureAudit({ fixtures = [], now = () => Date.now() } = {}) {
  const fixtureList = Array.isArray(fixtures) ? fixtures.filter(fixtureMatchesSendMessage) : [];
  const realUpstreamFixtures = fixtureList.filter(fixtureIsRealUpstreamEvidence);
  const upstreamErrorFrame = fixtureList.filter(fixtureMatchesUpstreamErrorFrame).length;
  const upstreamCancellation = fixtureList.filter(fixtureMatchesUpstreamCancellation).length;
  const upstreamBackpressure = fixtureList.filter(fixtureMatchesUpstreamBackpressure).length;
  const coverage = {
    upstreamErrorFrame: coverageItem(upstreamErrorFrame, "real_upstream_error_frame_fixture", "real_upstream_error_frame_fixture"),
    upstreamCancellation: coverageItem(upstreamCancellation, "real_upstream_cancellation_fixture", "real_upstream_cancellation_fixture"),
    upstreamBackpressure: coverageItem(upstreamBackpressure, "real_upstream_backpressure_fixture", "real_upstream_backpressure_fixture"),
  };
  const missing = Object.values(coverage)
    .filter((item) => item.status !== "ready")
    .map((item) => item.missingName);
  const nextActions = [];
  if (missing.includes("real_upstream_error_frame_fixture")) {
    nextActions.push("Capture a sanitized real Tabbit sendMessage SSE/NDJSON error-frame fixture and keep only aggregate classified evidence.");
  }
  if (missing.includes("real_upstream_cancellation_fixture")) {
    nextActions.push("Capture a sanitized real upstream cancellation or disconnect fixture before claiming client disconnect propagation is calibrated.");
  }
  if (missing.includes("real_upstream_backpressure_fixture")) {
    nextActions.push("Capture a sanitized real upstream backpressure or first-token-flush fixture with delayed continuation evidence.");
  }

  return {
    scope: "upstream",
    status: missing.length ? "blocked" : "ready",
    observedAt: nowIso(now),
    counts: {
      total: fixtureList.length,
      sendMessage: fixtureList.length,
      realUpstream: realUpstreamFixtures.length,
      upstreamErrorFrame,
      upstreamCancellation,
      upstreamBackpressure,
      success: fixtureList.filter((fixture) => fixture?.status === "success").length,
      failed: fixtureList.filter((fixture) => fixture?.status === "failed").length,
    },
    coverage,
    missing,
    nextActions,
  };
}

export function buildProtocolFixtureAudit({ fixtures = [], now = () => Date.now(), scope = "protocol" } = {}) {
  if (scope === "auth") return buildAuthFixtureAudit({ fixtures, now });
  if (scope === "benefits") return buildBenefitsFixtureAudit({ fixtures, now });
  if (scope === "session") return buildSessionFixtureAudit({ fixtures, now });
  if (scope === "upstream") return buildUpstreamFixtureAudit({ fixtures, now });
  const fixtureList = Array.isArray(fixtures) ? fixtures : [];
  const sessionVerify = fixtureList.filter(fixtureMatchesSessionVerifySuccess).length;
  const successfulSendMessage = fixtureList.filter(fixtureMatchesSendSuccess).length;
  const streamingText = fixtureList.filter(fixtureMatchesStreamingText).length;
  const toolCall = fixtureList.filter(fixtureMatchesToolCall).length;
  const forbidden403 = fixtureList.filter(fixtureMatchesForbidden).length;
  const coverage = {
    sessionVerify: coverageItem(sessionVerify, "successful_verifySession_fixture", "successful_verifySession_fixture"),
    successfulSendMessage: coverageItem(successfulSendMessage, "successful_sendMessage_fixture", "successful_sendMessage_fixture"),
    streamingText: coverageItem(streamingText, "streaming_text_fixture", "streaming_text_fixture"),
    toolCall: coverageItem(toolCall, "tool_call_fixture", "tool_call_fixture"),
    forbidden403: coverageItem(forbidden403, "forbidden_403_fixture", "forbidden_403_fixture"),
  };
  const missing = Object.values(coverage)
    .filter((item) => item.status !== "ready")
    .map((item) => item.missingName);
  const nextActions = [];
  if (missing.includes("successful_verifySession_fixture")) nextActions.push("Run probe protocol --operation verifySession --write-fixture and keep a sanitized success fixture.");
  if (missing.includes("successful_sendMessage_fixture")) nextActions.push("Run probe protocol --operation sendMessage --write-fixture and keep a sanitized success fixture.");
  if (missing.includes("streaming_text_fixture")) nextActions.push("Run a stream:true sendMessage probe and keep the sanitized SSE/NDJSON fixture.");
  if (missing.includes("tool_call_fixture")) nextActions.push("Run a tools-enabled sendMessage probe or record that upstream does not support native tool fields.");
  if (missing.includes("forbidden_403_fixture")) nextActions.push("Capture at least one sanitized 403/forbidden fixture and classify it with probe advice.");

  return {
    status: missing.length ? "blocked" : "ready",
    observedAt: nowIso(now),
    counts: {
      total: fixtureList.length,
      verifySession: fixtureList.filter((fixture) => fixture?.operation === "verifySession").length,
      sendMessage: fixtureList.filter((fixture) => fixture?.operation === "sendMessage").length,
      success: fixtureList.filter((fixture) => fixture?.status === "success").length,
      failed: fixtureList.filter((fixture) => fixture?.status === "failed").length,
    },
    coverage,
    missing,
    nextActions,
  };
}

export function buildCalibrationReadinessSnapshot({
  accounts = [],
  config = {},
  fixtures = [],
  codexVerified = false,
  claudeVerified = false,
  now = () => Date.now(),
} = {}) {
  const accountList = Array.isArray(accounts) ? accounts : [];
  const fixtureList = Array.isArray(fixtures) ? fixtures : [];
  const protocol = config?.protocol || {};
  const toolLoopMode = toolLoopModeFromConfig(config);
  const activeAccounts = accountList.filter((account) => statusOf(account) === "active").length;
  const successfulVerifySessionFixtures = fixtureList.filter(fixtureMatchesSessionVerifySuccess).length;
  const successfulSendFixtures = fixtureList.filter(fixtureMatchesSendSuccess).length;
  const forbiddenFixtures = fixtureList.filter(fixtureMatchesForbidden).length;

  const protocolMissing = [
    ...(protocol.enabled ? [] : ["protocol_enabled"]),
    ...(protocol.sendPath ? [] : ["protocol_send_path"]),
    ...(protocol.sessionVerifyPath ? [] : ["protocol_session_verify_path"]),
    ...(activeAccounts > 0 ? [] : ["active_account"]),
    ...(successfulVerifySessionFixtures > 0 ? [] : ["successful_verifySession_fixture"]),
    ...(successfulSendFixtures > 0 ? [] : ["successful_sendMessage_fixture"]),
  ];

  const e2eMissing = [
    ...(codexVerified ? [] : ["codex_e2e_verified"]),
    ...(claudeVerified ? [] : ["claude_code_e2e_verified"]),
  ];

  const forbiddenMissing = forbiddenFixtures > 0 ? [] : ["forbidden_403_fixture"];

  const checks = {
    protocolCalibration: {
      status: checkStatus(protocolMissing),
      missing: protocolMissing,
      evidence: {
        protocolEnabled: Boolean(protocol.enabled),
        sendPathConfigured: Boolean(protocol.sendPath),
        sessionVerifyPathConfigured: Boolean(protocol.sessionVerifyPath),
        activeAccounts,
        successfulVerifySessionFixtures,
        successfulSendFixtures,
      },
    },
    codexClaudeE2E: {
      status: checkStatus(e2eMissing),
      missing: e2eMissing,
      evidence: {
        codexVerified: Boolean(codexVerified),
        claudeVerified: Boolean(claudeVerified),
      },
    },
    toolLoopDecision: {
      status: "ready",
      missing: [],
      decision: toolLoopMode,
      recommendation: toolLoopRecommendation(toolLoopMode),
    },
    forbidden403: {
      status: checkStatus(forbiddenMissing),
      missing: forbiddenMissing,
      evidence: {
        forbiddenFixtures,
      },
    },
  };

  const blockingCore = checks.protocolCalibration.status === "blocked" || checks.forbidden403.status === "blocked";
  const allReady = Object.values(checks).every((check) => check.status === "ready");
  const nextActions = [];
  if (protocolMissing.includes("protocol_enabled")) nextActions.push("Set TABBIT_POOL_PROTOCOL_ENABLED=true or configure explicit TABBIT_POOL_PROTOCOL_* paths.");
  if (protocolMissing.includes("protocol_send_path")) nextActions.push("Set TABBIT_POOL_PROTOCOL_SEND_PATH from a verified Tabbit Web capture.");
  if (protocolMissing.includes("protocol_session_verify_path")) nextActions.push("Set TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH from a verified Tabbit Web account/session capture.");
  if (protocolMissing.includes("active_account")) nextActions.push("Import or refresh at least one active Tabbit account session.");
  if (protocolMissing.includes("successful_verifySession_fixture")) nextActions.push("Run probe protocol --operation verifySession --write-fixture and keep the sanitized success fixture.");
  if (protocolMissing.includes("successful_sendMessage_fixture")) nextActions.push("Run probe protocol --operation sendMessage --write-fixture and keep the sanitized success fixture.");
  if (e2eMissing.includes("codex_e2e_verified")) nextActions.push("Run the Codex base_url/key/model validation task and record the result.");
  if (e2eMissing.includes("claude_code_e2e_verified")) nextActions.push("Run the Claude Code ANTHROPIC_BASE_URL/key/model validation task and record the result.");
  if (forbiddenMissing.length) nextActions.push("Capture at least one sanitized 403/forbidden fixture and classify it with probe advice.");

  return {
    status: allReady ? "ready" : (blockingCore ? "blocked" : "partial"),
    observedAt: nowIso(now),
    checks,
    nextActions,
  };
}

export function buildReadinessDoctorReport({
  accounts = [],
  config = {},
  fixtures = [],
  readinessState = {},
  now = () => Date.now(),
} = {}) {
  const readiness = buildCalibrationReadinessSnapshot({
    accounts,
    config,
    fixtures,
    codexVerified: readinessVerified(readinessState, "codex"),
    claudeVerified: readinessVerified(readinessState, "claude"),
    now,
  });
  const fixtureAudit = buildProtocolFixtureAudit({ fixtures, now });
  const authAudit = buildProtocolFixtureAudit({ fixtures, now, scope: "auth" });
  const benefitsAudit = buildProtocolFixtureAudit({ fixtures, now, scope: "benefits" });
  const sessionAudit = buildProtocolFixtureAudit({ fixtures, now, scope: "session" });
  const upstreamAudit = buildProtocolFixtureAudit({ fixtures, now, scope: "upstream" });
  const remainingWork = uniqueStrings([
    ...(Array.isArray(readiness.nextActions) ? readiness.nextActions : []),
    ...(Array.isArray(fixtureAudit.nextActions) ? fixtureAudit.nextActions : []),
  ]);
  const calibrationBacklogMissing = uniqueStrings([
    ...(Array.isArray(authAudit.missing) ? authAudit.missing : []),
    ...(Array.isArray(benefitsAudit.missing) ? benefitsAudit.missing : []),
    ...(Array.isArray(sessionAudit.missing) ? sessionAudit.missing : []),
    ...(Array.isArray(upstreamAudit.missing) ? upstreamAudit.missing : []),
  ]);
  const calibrationBacklogNextActions = uniqueStrings([
    ...(Array.isArray(authAudit.nextActions) ? authAudit.nextActions : []),
    ...(Array.isArray(benefitsAudit.nextActions) ? benefitsAudit.nextActions : []),
    ...(Array.isArray(sessionAudit.nextActions) ? sessionAudit.nextActions : []),
    ...(Array.isArray(upstreamAudit.nextActions) ? upstreamAudit.nextActions : []),
  ]);

  return {
    status: combinedDoctorStatus(readiness.status, fixtureAudit.status),
    observedAt: nowIso(now),
    stateDir: String(config?.stateDir || ""),
    protocol: protocolDoctorSummary(config),
    readiness,
    fixtureAudit,
    calibrationBacklog: {
      status: authAudit.status === "ready" && benefitsAudit.status === "ready" && sessionAudit.status === "ready" && upstreamAudit.status === "ready" ? "ready" : "blocked",
      scopes: {
        auth: authAudit,
        benefits: benefitsAudit,
        session: sessionAudit,
        upstream: upstreamAudit,
      },
      missing: calibrationBacklogMissing,
      nextActions: calibrationBacklogNextActions,
      captureCommands: buildCalibrationCaptureCommands(calibrationBacklogMissing, config),
    },
    remainingWork,
    commands: readinessDoctorCommands(config?.stateDir || "<state-dir>"),
  };
}

export function formatMaintenanceActionLog({
  accountId = null,
  actions = [],
  requestId = null,
  now = () => Date.now(),
} = {}) {
  const observedAt = nowIso(now);
  return (Array.isArray(actions) ? actions : []).map((item = {}) => ({
    observedAt,
    ...(requestId ? { requestId } : {}),
    ...(accountId ? { accountId } : {}),
    action: String(item.name || item.action || "unknown"),
    status: String(item.status || "unknown"),
    changed: Boolean(item.changed),
    ...(item.detail ? { detail: sanitizeText(item.detail) } : {}),
    ...(item.error ? { error: compactError(item.error) } : {}),
  }));
}

export function protocolProbeAdvice(input = {}) {
  const category = input?.category || input?.lastError?.category || null;
  const status = input?.status || input?.lastError?.status || null;

  if (category === "protocol_changed") {
    return {
      category,
      severity: "warning",
      recommendation: "Capture a fresh fixture from Tabbit Web, compare request/response shape, and update protocol parsing tests before changing runtime behavior.",
    };
  }
  if (category === "login_required" || category === "session_missing" || status === 401) {
    return {
      category: category || "login_required",
      severity: "error",
      recommendation: "Refresh or import the affected account session, then run verifyAccount before returning it to the pool.",
    };
  }
  if (category === "forbidden" || status === 403) {
    const forbidden = classifyForbiddenSignal(input);
    return {
      category: category || "forbidden",
      severity: forbidden.severity,
      recommendation: forbidden.recommendation,
      forbidden: {
        kind: forbidden.kind,
        accountAction: forbidden.accountAction,
        retryable: forbidden.retryable,
      },
    };
  }
  if (category === "rate_limited" || status === 429) {
    return {
      category: category || "rate_limited",
      severity: "warning",
      recommendation: "Wait for the cooldown window, reduce request pressure, and prefer a different active account while the limit clears.",
    };
  }
  if (category === "network_error") {
    return {
      category,
      severity: "warning",
      recommendation: "Check local network connectivity and Tabbit reachability, then retry the protocol probe.",
    };
  }
  return {
    category: category || "unknown",
    severity: "info",
    recommendation: "Inspect the redacted probe error, capture a minimal fixture, and add a regression test before changing protocol behavior.",
  };
}

export function createGatewayHealthProvider({
  accountPool = null,
  modelCache = null,
  startedAt = Date.now(),
  now = () => Date.now(),
} = {}) {
  return async () => {
    const accounts = accountPool && typeof accountPool.listAccounts === "function"
      ? accountPool.listAccounts()
      : [];
    return buildHealthSnapshot({ accounts, modelCache, startedAt, now });
  };
}
