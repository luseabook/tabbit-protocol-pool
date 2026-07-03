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

function fixtureMatchesSessionVerifySuccess(fixture = {}) {
  return fixture?.operation === "verifySession" && fixture?.status === "success";
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

export function buildProtocolFixtureAudit({ fixtures = [], now = () => Date.now() } = {}) {
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
