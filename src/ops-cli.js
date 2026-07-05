import { mkdir, readFile as readTextFile, writeFile as writeTextFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadConfig, normalizePort } from "./config.js";
import { redactSensitiveValue } from "./redact.js";
import { JsonAccountStore } from "./account-store.js";
import { AccountProvisioner } from "./account-provisioner.js";
import { BenefitsMaintainer } from "./benefits-maintainer.js";
import { FileSecretStore } from "./secret-store.js";
import { FileProtocolFixtureStore, ProtocolProbeRunner, sanitizeProtocolProbeFixture } from "./protocol-probe.js";
import { ProtocolTabbitClient } from "./protocol-tabbit-client.js";
import { createPowerShellFetch } from "./powershell-fetch.js";
import { createProtocolPoolGateway } from "./protocol-pool-gateway.js";
import {
  BENEFITS_AUDIT_OPERATIONS,
  buildCalibrationReadinessSnapshot,
  buildHealthSnapshot,
  buildProtocolFixtureAudit,
  buildReadinessDoctorReport,
  formatMaintenanceActionLog,
  protocolProbeAdvice,
  redactAccountForDisplay,
  redactAccountsForDisplay,
} from "./observability.js";

const HELP = `Usage:
  tabbit-pool accounts list [--json]
  tabbit-pool accounts import-session [--id <id>] [--email <email>] [--access-tier <unknown|free|pro>] [--chat-session-id <id>] [--cookie-header <text> | --session <text> | --cookie-file <path> | --session-file <path>] [--json]
  tabbit-pool accounts probe <id> [--read-only] [--json]
  tabbit-pool health [--json]
  tabbit-pool readiness [--json]
  tabbit-pool readiness doctor [--json]
  tabbit-pool readiness mark [--codex-verified] [--claude-verified] [--json]
  tabbit-pool production preflight [--json]
  tabbit-pool production init-key [--json]
  tabbit-pool serve [--host <host>] [--port <port>] [--json]
  tabbit-pool start [--host <host>] [--port <port>] [--json]
  tabbit-pool smoke gateway [--base-url <url>] [--api-key <key>] [--model <model>] [--json]
  tabbit-pool maintain [--json]
  tabbit-pool fixtures list [--json]
  tabbit-pool fixtures audit [--scope <protocol|auth|benefits|session|upstream>] [--json]
  tabbit-pool fixtures show <ref> [--json]
  tabbit-pool probe advice [--category <category>] [--status <status>] [--code <code>] [--message <text>] [--json]
  tabbit-pool probe template [--operation <name>] [--stream-evidence <mode>] [--max-deltas <n>] [--json]
  tabbit-pool probe validate [--operation <name>] [--input-json <json> | --input-file <path>] [--require-confirmed-side-effect] [--write-fixture] [--json]
  tabbit-pool probe protocol --account <id> [--operation <name>] [--input-json <json> | --input-file <path>] [--write-fixture] [--json]
`;

const DEFAULT_GATEWAY_API_KEY = "sk-tabbit-local";
const GATEWAY_API_KEY_SECRET_REF = "secrets/gateway-api-key.txt";
const ACCOUNT_IMPORT_ACCESS_TIERS = new Set(["unknown", "free", "pro"]);

function writeLine(writer, value) {
  writer(String(value));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function redactErrorMessage(error) {
  const message = error?.message || String(error);
  return redactSensitiveValue(message).replace(/\b\d{4,8}\b/g, "***");
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

class CliUsageError extends Error {
  constructor(message, { code = "INVALID_CLI_USAGE" } = {}) {
    super(message);
    this.name = "CliUsageError";
    this.code = code;
    this.exitCode = 2;
  }
}

function requiredValueAfter(args, flag) {
  if (!hasFlag(args, flag)) return null;
  const value = valueAfter(args, flag);
  if (!value || value.startsWith("--")) {
    throw new CliUsageError("Missing value for " + flag + ".", { code: "MISSING_CLI_VALUE" });
  }
  return value;
}
function parseOptionalPort(args, fallback) {
  const value = requiredValueAfter(args, "--port");
  if (!value) return fallback;
  try {
    return normalizePort(value, fallback);
  } catch {
    throw new CliUsageError("Invalid value for --port.", { code: "INVALID_CLI_PORT" });
  }
}

function parseOptionalHost(args, fallback) {
  return requiredValueAfter(args, "--host") || fallback;
}

function localUrlHost(host) {
  const value = String(host || "127.0.0.1");
  if (value === "0.0.0.0" || value === "::" || value === "::0") return "127.0.0.1";
  return value.includes(":") && !value.startsWith("[") ? "[" + value + "]" : value;
}

function listeningAddress(server, fallback = {}) {
  const address = typeof server?.address === "function" ? server.address() : null;
  if (address && typeof address === "object") {
    return {
      host: address.address || fallback.host || "127.0.0.1",
      port: Number.isInteger(address.port) ? address.port : fallback.port,
    };
  }
  return {
    host: fallback.host || "127.0.0.1",
    port: fallback.port,
  };
}

function serveInfo(address) {
  const host = localUrlHost(address.host);
  return {
    status: "listening",
    host: address.host,
    port: address.port,
    openaiBaseUrl: "http://" + host + ":" + address.port + "/v1",
    anthropicBaseUrl: "http://" + host + ":" + address.port,
  };
}

function waitForShutdownSignal() {
  const proc = globalThis.process;
  if (!proc || typeof proc.once !== "function") {
    return new Promise(() => {});
  }
  return new Promise((resolve) => {
    const signals = ["SIGINT", "SIGTERM"];
    let settled = false;
    const cleanup = () => {
      for (const signal of signals) {
        if (typeof proc.off === "function") proc.off(signal, onSignal);
        else if (typeof proc.removeListener === "function") proc.removeListener(signal, onSignal);
      }
    };
    const onSignal = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    for (const signal of signals) proc.once(signal, onSignal);
  });
}



function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function gatewayBaseUrlFromConfig(config = {}) {
  return serveInfo({ host: config.host || "127.0.0.1", port: config.port || 50124 }).anthropicBaseUrl;
}

function optionalCliValue(args, flag, fallback) {
  const value = requiredValueAfter(args, flag);
  return value || fallback;
}

function jsonHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    ...extra,
  };
}

async function readResponsePreview(response) {
  try {
    const contentType = response?.headers?.get?.("content-type") || "";
    if (contentType.includes("application/json") && typeof response.json === "function") {
      return await response.json();
    }
    if (typeof response.text === "function") return await response.text();
  } catch {
    return null;
  }
  return null;
}

function smokeStepResult(step, response, preview = null) {
  const statusCode = Number(response?.status || 0);
  const ok = Boolean(response?.ok);
  return {
    name: step.name,
    method: step.method,
    url: step.url,
    ok,
    statusCode,
    ...(ok && step.expect ? { evidence: step.expect(preview) } : {}),
    ...(!ok ? { error: { code: "HTTP_" + statusCode } } : {}),
  };
}

async function runGatewaySmoke({ baseUrl, apiKey, model, fetchImpl }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available for gateway smoke.");
  }
  const root = trimTrailingSlash(baseUrl);
  const smokeMessage = "tabbit-pool smoke: reply ok";
  const steps = [
    {
      name: "health",
      method: "GET",
      url: root + "/health",
    },
    {
      name: "models",
      method: "GET",
      url: root + "/v1/models",
      headers: { Authorization: "Bearer " + apiKey },
      expect: (body) => ({ models: Array.isArray(body?.data) ? body.data.length : 0 }),
    },
    {
      name: "chat_completions",
      method: "POST",
      url: root + "/v1/chat/completions",
      headers: { Authorization: "Bearer " + apiKey },
      body: { model, messages: [{ role: "user", content: smokeMessage }] },
    },
    {
      name: "responses",
      method: "POST",
      url: root + "/v1/responses",
      headers: { Authorization: "Bearer " + apiKey },
      body: { model, input: smokeMessage },
    },
    {
      name: "anthropic_messages",
      method: "POST",
      url: root + "/v1/messages",
      headers: { "x-api-key": apiKey },
      body: { model, max_tokens: 32, messages: [{ role: "user", content: smokeMessage }] },
    },
  ];

  const results = [];
  for (const step of steps) {
    let response;
    let preview;
    try {
      response = await fetchImpl(step.url, {
        method: step.method,
        headers: jsonHeaders(step.headers || {}),
        ...(step.body ? { body: JSON.stringify(step.body) } : {}),
      });
      preview = await readResponsePreview(response);
      results.push(smokeStepResult(step, response, preview));
    } catch (error) {
      results.push({
        name: step.name,
        method: step.method,
        url: step.url,
        ok: false,
        statusCode: 0,
        error: { code: "FETCH_FAILED", message: redactErrorMessage(error) },
      });
    }
    if (!results[results.length - 1].ok) break;
  }
  const failed = results.find((step) => !step.ok);
  return {
    status: failed ? "failed" : "ok",
    baseUrl: root,
    model,
    steps: results,
    ...(failed ? { failedStep: failed.name } : {}),
  };
}

function parseProbeInputJson(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliUsageError("Invalid JSON for " + source + ".", { code: "INVALID_PROBE_INPUT_JSON" });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliUsageError("Probe input for " + source + " must be a JSON object.", { code: "INVALID_PROBE_INPUT_SHAPE" });
  }
  return parsed;
}

const REDACTED_MESSAGE_CONTENT_PLACEHOLDER = "<redacted-message-content>";
const SEND_MESSAGE_REVIEW_REQUIREMENT = "replace_redacted_message_content";

const PROBE_INPUT_TEMPLATES = {
  verifySession: {},
  sendVerificationCode: {
    confirmSideEffect: false,
    mobile: "10000000000",
    uuid: "0000000000000000000000000000000000000000000000000000000000000000",
    body: {
      uuid: "0000000000000000000000000000000000000000000000000000000000000000",
      platform: "1",
      version: "",
      app: "1000",
      mobile: "10000000000",
    },
  },
  submitRegistrationOrLogin: {
    confirmSideEffect: false,
    mobile: "10000000000",
    code: "000000",
    uuid: "0000000000000000000000000000000000000000000000000000000000000000",
    body: {
      uuid: "0000000000000000000000000000000000000000000000000000000000000000",
      platform: "1",
      version: "",
      app: "1000",
      mobile: "10000000000",
      smsCode: "000000",
    },
  },
  sendMessage: {
    model: "tabbit/priority",
    messages: [{ role: "user", content: REDACTED_MESSAGE_CONTENT_PLACEHOLDER }],
    stream: true,
  },
  listModels: { force: true },
  refreshQuota: {},
  getLotteryExplorationMe: {},
  getNewbieExplorationMe: {
    viewMode: "activity_page",
    includeCompletions: true,
    includeRewards: true,
  },
  getPlacementResources: {
    placementCode: "home.input_below",
  },
  listRewardCardRecords: {
    offset: 0,
    limit: 10,
  },
  listLotteryHitRecords: {
    offset: 0,
    limit: 20,
  },
  getDailySignInStatus: {
    sceneCodes: ["desktop_pet"],
  },
  dailySignIn: {
    confirmSideEffect: false,
    requestNo: "desktop-pet-sign-in-probe",
    sceneCodes: ["desktop_pet"],
  },
  listBenefitCoupons: {
    couponType: "weekly_reset_coupon",
    offset: 0,
    limit: 50,
  },
  participateResetCouponActivity: {
    confirmSideEffect: false,
    requestNo: "reset-coupon-activity-probe",
  },
  participateActivity: {
    confirmSideEffect: false,
    body: {},
  },
  useResetCoupon: {
    confirmSideEffect: false,
    couponCode: "coupon-code",
    couponType: "weekly_reset_coupon",
    requestNo: "reset-coupon-use-probe",
  },
  getUsageResetCouponSku: {},
  getAvailableLotteryChanceCount: {
    activityId: "activity-id",
  },
  getActiveMainPools: {
    activityId: "activity-id",
  },
  listLotteryChanceRecords: {
    activityId: "activity-id",
    offset: 0,
    limit: 20,
  },
  drawLottery: {
    confirmSideEffect: false,
    body: {},
  },
  consumeResetCoupon: {
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
  },
  recoverSession: {
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
  },
  uploadAttachment: {
    attachment: {
      filename: "probe.txt",
      mimeType: "text/plain",
      data: "base64-probe-payload",
    },
  },
};

const PROBE_TEMPLATE_OPERATIONS = Object.keys(PROBE_INPUT_TEMPLATES);
const SIDE_EFFECT_PROBE_OPERATIONS = new Set([
  "sendVerificationCode",
  "submitRegistrationOrLogin",
  "dailySignIn",
  "participateResetCouponActivity",
  "participateActivity",
  "useResetCoupon",
  "drawLottery",
]);
const OFFLINE_EVIDENCE_PROBE_OPERATIONS = new Set(["recoverSession", "consumeResetCoupon"]);
const SESSION_RECOVERY_STRATEGIES = new Set(["automated_reauth", "refresh_token"]);
const SESSION_RECOVERY_REFRESH_MODES = new Set([
  "calibrated_reauth_probe",
  "calibrated_refresh_probe",
]);
const RESET_COUPON_CONSUMPTION_OPERATIONS = new Set([
  "useResetCoupon",
  "consumeResetCoupon",
  "consumeResetCouponSku",
  "redeemResetCoupon",
]);
const RESET_COUPON_SUCCESS_VALUES = new Set([
  "success",
  "succeeded",
  "ok",
  "done",
  "consumed",
  "used",
  "redeemed",
]);
const RESET_COUPON_NON_CONSUMPTION_VALUES = new Set([
  "already_participated",
  "already participated",
  "already_signed",
  "already signed",
  "already_claimed",
  "already claimed",
]);
const STREAM_EVIDENCE_MODES = new Set([
  "first_token_backpressure",
  "cancel_after_first_delta",
  "error_frame",
]);
const DEFAULT_STREAM_EVIDENCE_DELTAS = 2;
const MAX_STREAM_EVIDENCE_DELTAS = 5;

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildProbeInputTemplate(operation, { streamEvidence = null } = {}) {
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  const template = PROBE_INPUT_TEMPLATES[cleanOperation];
  if (!template) {
    throw new CliUsageError(
      "Unsupported probe template operation. Supported operations: " + PROBE_TEMPLATE_OPERATIONS.join(", ") + ".",
      { code: "UNSUPPORTED_PROBE_TEMPLATE_OPERATION" },
    );
  }
  const output = cloneJsonObject(template);
  if (streamEvidence) {
    output.stream = true;
    output.streamEvidence = { ...streamEvidence };
  }
  return output;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

const NEWBIE_EXPLORATION_VIEW_MODES = new Set(["event_gate", "float_collapsed", "float_expanded", "activity_page"]);

function validateOptionalNonNegativeInteger(input, key, operation) {
  if (!hasOwn(input, key)) return;
  const value = input[key];
  if (!Number.isInteger(value) || value < 0) {
    throw new CliUsageError("Probe input for " + operation + "." + key + " must be a non-negative integer.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function validateOptionalStringArray(input, key, operation) {
  if (!hasOwn(input, key)) return;
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !nonEmptyString(item))) {
    throw new CliUsageError("Probe input for " + operation + "." + key + " must be a non-empty string array.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function validateOptionalBoolean(input, key, operation) {
  if (hasOwn(input, key) && typeof input[key] !== "boolean") {
    throw new CliUsageError("Probe input for " + operation + "." + key + " must be a boolean.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function validateStreamEvidenceInput(input, operation) {
  if (!hasOwn(input, "streamEvidence")) return;
  if (input.stream !== true) {
    throw new CliUsageError("Probe input for " + operation + ".streamEvidence requires stream:true.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  const evidence = input.streamEvidence;
  if (!plainObject(evidence)) {
    throw new CliUsageError("Probe input for " + operation + ".streamEvidence must be an object.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  const mode = String(evidence.mode || "").trim();
  if (!STREAM_EVIDENCE_MODES.has(mode)) {
    throw new CliUsageError(
      "Probe input for " + operation + ".streamEvidence.mode must be one of " + Array.from(STREAM_EVIDENCE_MODES).join(", ") + ".",
      { code: "INVALID_PROBE_INPUT_SCHEMA" },
    );
  }
  if (hasOwn(evidence, "maxDeltas") && (!Number.isInteger(evidence.maxDeltas) || evidence.maxDeltas < 1 || evidence.maxDeltas > MAX_STREAM_EVIDENCE_DELTAS)) {
    throw new CliUsageError("Probe input for " + operation + ".streamEvidence.maxDeltas must be an integer from 1 to " + MAX_STREAM_EVIDENCE_DELTAS + ".", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function parseStreamEvidenceTemplateOptions(args, operation) {
  const hasStreamEvidence = hasFlag(args, "--stream-evidence");
  const hasMaxDeltas = hasFlag(args, "--max-deltas");
  if (!hasStreamEvidence && !hasMaxDeltas) return null;
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  if (!hasStreamEvidence) {
    throw new CliUsageError("Probe template --max-deltas requires --stream-evidence.", { code: "INVALID_PROBE_TEMPLATE_STREAM_EVIDENCE" });
  }
  if (cleanOperation !== "sendMessage") {
    throw new CliUsageError("Probe template --stream-evidence is only supported for sendMessage.", { code: "INVALID_PROBE_TEMPLATE_STREAM_EVIDENCE" });
  }
  const mode = requiredValueAfter(args, "--stream-evidence").trim();
  if (!STREAM_EVIDENCE_MODES.has(mode)) {
    throw new CliUsageError(
      "Probe template sendMessage.streamEvidence.mode must be one of " + Array.from(STREAM_EVIDENCE_MODES).join(", ") + ".",
      { code: "INVALID_PROBE_TEMPLATE_STREAM_EVIDENCE" },
    );
  }
  const maxDeltasValue = hasMaxDeltas ? requiredValueAfter(args, "--max-deltas") : String(DEFAULT_STREAM_EVIDENCE_DELTAS);
  if (!/^\d+$/.test(maxDeltasValue)) {
    throw new CliUsageError("Probe template sendMessage.streamEvidence.maxDeltas must be an integer from 1 to " + MAX_STREAM_EVIDENCE_DELTAS + ".", { code: "INVALID_PROBE_TEMPLATE_STREAM_EVIDENCE" });
  }
  const maxDeltas = Number(maxDeltasValue);
  if (!Number.isInteger(maxDeltas) || maxDeltas < 1 || maxDeltas > MAX_STREAM_EVIDENCE_DELTAS) {
    throw new CliUsageError("Probe template sendMessage.streamEvidence.maxDeltas must be an integer from 1 to " + MAX_STREAM_EVIDENCE_DELTAS + ".", { code: "INVALID_PROBE_TEMPLATE_STREAM_EVIDENCE" });
  }
  return { mode, maxDeltas };
}

function validateOptionalString(input, key, operation) {
  if (hasOwn(input, key) && !nonEmptyString(input[key])) {
    throw new CliUsageError("Probe input for " + operation + "." + key + " must be a non-empty string.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function validateOptionalRequestNo(input, operation) {
  validateOptionalString(input, "requestNo", operation);
  if (hasOwn(input, "requestNo") && input.requestNo.trim().length > 64) {
    throw new CliUsageError("Probe input for " + operation + ".requestNo must be a non-empty string of at most 64 characters.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function validateRequiredString(input, key, operation) {
  if (!hasOwn(input, key) || !nonEmptyString(input[key])) {
    throw new CliUsageError("Probe input for " + operation + "." + key + " must be a non-empty string.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function validateOptionalBodyObject(input, operation) {
  if (hasOwn(input, "body") && !plainObject(input.body)) {
    throw new CliUsageError("Probe input for " + operation + ".body must be an object.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function canonicalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sessionRecoveryRawPayload(evidence) {
  if (hasOwn(evidence, "rawPayload")) return evidence.rawPayload;
  if (hasOwn(evidence, "raw_payload")) return evidence.raw_payload;
  return undefined;
}

function resetCouponRawPayload(evidence) {
  if (hasOwn(evidence, "rawPayload")) return evidence.rawPayload;
  if (hasOwn(evidence, "raw_payload")) return evidence.raw_payload;
  return undefined;
}

function safeSha256Evidence(value) {
  return typeof value === "string" && /^sha256:[^:\s].*/.test(value.trim());
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function valueForAnyKey(input, keys) {
  if (!plainObject(input)) return undefined;
  for (const key of keys) {
    if (hasOwn(input, key)) return input[key];
  }
  return undefined;
}

function stringValueIn(value, allowedValues) {
  return typeof value === "string" && allowedValues.has(value.trim().toLowerCase());
}

function resetCouponHasNonConsumptionSignal(result = {}) {
  const keys = [
    "participationResult",
    "participation_result",
    "consumeResult",
    "consume_result",
    "couponResult",
    "coupon_result",
    "usageResult",
    "usage_result",
    "result",
    "status",
  ];
  return keys.some((key) => stringValueIn(result[key], RESET_COUPON_NON_CONSUMPTION_VALUES));
}

function resetCouponHasConsumptionSignal(result = {}) {
  const booleanKeys = [
    "resetCouponConsumed",
    "reset_coupon_consumed",
    "couponConsumed",
    "coupon_consumed",
    "consumed",
    "used",
    "deducted",
  ];
  if (booleanKeys.some((key) => result[key] === true)) return true;
  const value = valueForAnyKey(result, [
    "consumeResult",
    "consume_result",
    "couponResult",
    "coupon_result",
    "usageResult",
    "usage_result",
  ]);
  return stringValueIn(value, RESET_COUPON_SUCCESS_VALUES);
}

function validateRecoverSessionEvidenceInput(input) {
  if (input.kind !== "session_recovery_strategy") {
    throw new CliUsageError("Probe input for recoverSession.kind must be session_recovery_strategy.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (input.operation !== "recoverSession") {
    throw new CliUsageError("Probe input for recoverSession.operation must be recoverSession.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (input.status !== "success") {
    throw new CliUsageError("Probe input for recoverSession.status must be success.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (!plainObject(input.evidence)) {
    throw new CliUsageError("Probe input for recoverSession.evidence must be an object.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }

  const strategy = canonicalString(input.evidence.strategy || input.evidence.current);
  const automatedRefresh = canonicalString(input.evidence.automatedRefresh || input.evidence.automated_refresh || input.evidence.mode);
  if (!SESSION_RECOVERY_STRATEGIES.has(strategy)) {
    throw new CliUsageError("Probe input for recoverSession.evidence.strategy must be automated_reauth or refresh_token.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (!SESSION_RECOVERY_REFRESH_MODES.has(automatedRefresh)) {
    throw new CliUsageError("Probe input for recoverSession.evidence.automatedRefresh must be calibrated_reauth_probe or calibrated_refresh_probe.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (input.evidence.safe !== true || input.evidence.sanitized !== true || sessionRecoveryRawPayload(input.evidence) !== false) {
    throw new CliUsageError("Probe input for recoverSession.evidence requires safe:true, sanitized:true, and rawPayload:false.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (
    !positiveInteger(input.evidence.observedWindowMs)
    || !safeSha256Evidence(input.evidence.resultHash)
    || !plainObject(input.result)
    || input.result.expiredBeforeRecovery !== true
    || input.result.recoveredVerifySession !== true
  ) {
    throw new CliUsageError("Probe input for recoverSession requires positive observedWindowMs, resultHash sha256, and post-recovery verifySession evidence with expiredBeforeRecovery:true and recoveredVerifySession:true.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function validateResetCouponConsumptionEvidenceInput(input) {
  if (input.kind !== "reset_coupon_consumption_evidence") {
    throw new CliUsageError("Probe input for consumeResetCoupon.kind must be reset_coupon_consumption_evidence.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (!RESET_COUPON_CONSUMPTION_OPERATIONS.has(input.operation)) {
    throw new CliUsageError("Probe input for consumeResetCoupon.operation must be a reset coupon consumption operation.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (input.status !== "success") {
    throw new CliUsageError("Probe input for consumeResetCoupon.status must be success.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (!plainObject(input.evidence)) {
    throw new CliUsageError("Probe input for consumeResetCoupon.evidence must be an object.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (
    !safeSha256Evidence(input.evidence.endpointHash)
    || !safeSha256Evidence(input.evidence.bodyHash)
    || !safeSha256Evidence(input.evidence.resultHash)
  ) {
    throw new CliUsageError("Probe input for consumeResetCoupon.evidence requires endpointHash, bodyHash, and resultHash sha256 values.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (input.evidence.safe !== true || input.evidence.sanitized !== true || resetCouponRawPayload(input.evidence) !== false) {
    throw new CliUsageError("Probe input for consumeResetCoupon.evidence requires safe:true, sanitized:true, and rawPayload:false.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (!plainObject(input.result)) {
    throw new CliUsageError("Probe input for consumeResetCoupon.result must be an object.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (resetCouponHasNonConsumptionSignal(input.result)) {
    throw new CliUsageError("Probe input for consumeResetCoupon.result contains a non-consumption signal.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (!resetCouponHasConsumptionSignal(input.result)) {
    throw new CliUsageError("Probe input for consumeResetCoupon.result must prove reset coupon consumption.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
}

function validateProbeInputForOperation(input, operation) {
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  if (input === undefined) {
    if (cleanOperation === "recoverSession") {
      throw new CliUsageError("Probe input for recoverSession requires explicit sanitized evidence input.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
    if (cleanOperation === "consumeResetCoupon") {
      throw new CliUsageError("Probe input for consumeResetCoupon requires explicit sanitized reset coupon consumption evidence input.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
    return;
  }
  if (cleanOperation === "sendVerificationCode" || cleanOperation === "submitRegistrationOrLogin") {
    validateOptionalBoolean(input, "confirmSideEffect", cleanOperation);
    if (!nonEmptyString(input.email) && !nonEmptyString(input.mobile)) {
      throw new CliUsageError("Probe input for " + cleanOperation + " requires a non-empty email or mobile.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
    if (hasOwn(input, "email") && !nonEmptyString(input.email)) validateRequiredString(input, "email", cleanOperation);
    if (hasOwn(input, "mobile") && !nonEmptyString(input.mobile)) validateRequiredString(input, "mobile", cleanOperation);
    if (hasOwn(input, "uuid")) {
      validateRequiredString(input, "uuid", cleanOperation);
      if (!/^[A-Za-z0-9]{64}$/.test(input.uuid.trim())) {
        throw new CliUsageError("Probe input for " + cleanOperation + ".uuid must be a 64-character alphanumeric auth client value.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
      }
    }
    validateOptionalBodyObject(input, cleanOperation);
    if (cleanOperation === "submitRegistrationOrLogin") {
      validateRequiredString(input, "code", cleanOperation);
    }
  }
  if (cleanOperation === "sendMessage") {
    if (hasOwn(input, "model") && !nonEmptyString(input.model)) {
      throw new CliUsageError("Probe input for sendMessage.model must be a non-empty string.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
    if (hasOwn(input, "messages") && (!Array.isArray(input.messages) || input.messages.length === 0)) {
      throw new CliUsageError("Probe input for sendMessage.messages must be a non-empty array.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
    validateOptionalBoolean(input, "stream", cleanOperation);
    validateStreamEvidenceInput(input, cleanOperation);
  }
  if (cleanOperation === "listModels" && hasOwn(input, "force") && typeof input.force !== "boolean") {
    throw new CliUsageError("Probe input for listModels.force must be a boolean.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (cleanOperation === "refreshQuota" && hasOwn(input, "userId") && !nonEmptyString(input.userId)) {
    throw new CliUsageError("Probe input for refreshQuota.userId must be a non-empty string.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
  }
  if (cleanOperation === "getNewbieExplorationMe") {
    if (hasOwn(input, "viewMode") && !NEWBIE_EXPLORATION_VIEW_MODES.has(String(input.viewMode || ""))) {
      throw new CliUsageError("Probe input for getNewbieExplorationMe.viewMode must be one of event_gate, float_collapsed, float_expanded, activity_page.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
    for (const key of ["includeCompletions", "includeRewards"]) validateOptionalBoolean(input, key, cleanOperation);
  }
  if (cleanOperation === "getPlacementResources") {
    validateOptionalString(input, "placementCode", cleanOperation);
    validateOptionalString(input, "clientVersion", cleanOperation);
  }
  if (cleanOperation === "listRewardCardRecords" || cleanOperation === "listLotteryHitRecords") {
    if (hasOwn(input, "userId") && !nonEmptyString(input.userId)) {
      throw new CliUsageError("Probe input for " + cleanOperation + ".userId must be a non-empty string.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
    validateOptionalNonNegativeInteger(input, "offset", cleanOperation);
    validateOptionalNonNegativeInteger(input, "limit", cleanOperation);
  }
  if (cleanOperation === "getDailySignInStatus" || cleanOperation === "dailySignIn") {
    validateOptionalStringArray(input, "sceneCodes", cleanOperation);
  }
  if (cleanOperation === "dailySignIn") {
    validateOptionalBoolean(input, "confirmSideEffect", cleanOperation);
    validateOptionalRequestNo(input, cleanOperation);
  }
  if (cleanOperation === "listBenefitCoupons") {
    validateOptionalString(input, "userId", cleanOperation);
    validateOptionalString(input, "couponType", cleanOperation);
    validateOptionalString(input, "status", cleanOperation);
    validateOptionalNonNegativeInteger(input, "offset", cleanOperation);
    validateOptionalNonNegativeInteger(input, "limit", cleanOperation);
  }
  if (cleanOperation === "participateResetCouponActivity") {
    validateOptionalBoolean(input, "confirmSideEffect", cleanOperation);
    validateOptionalString(input, "userId", cleanOperation);
    validateOptionalRequestNo(input, cleanOperation);
  }
  if (cleanOperation === "participateActivity" || cleanOperation === "drawLottery") {
    validateOptionalBoolean(input, "confirmSideEffect", cleanOperation);
    validateOptionalBodyObject(input, cleanOperation);
  }
  if (cleanOperation === "useResetCoupon") {
    validateOptionalBoolean(input, "confirmSideEffect", cleanOperation);
    validateOptionalString(input, "userId", cleanOperation);
    validateOptionalString(input, "couponCode", cleanOperation);
    validateOptionalString(input, "couponType", cleanOperation);
    validateOptionalRequestNo(input, cleanOperation);
  }
  if (cleanOperation === "recoverSession") {
    validateRecoverSessionEvidenceInput(input);
  }
  if (cleanOperation === "consumeResetCoupon") {
    validateResetCouponConsumptionEvidenceInput(input);
  }
  if (cleanOperation === "getAvailableLotteryChanceCount") {
    validateOptionalString(input, "userId", cleanOperation);
    validateOptionalString(input, "activityId", cleanOperation);
  }
  if (cleanOperation === "getActiveMainPools") {
    validateOptionalString(input, "activityId", cleanOperation);
  }
  if (cleanOperation === "listLotteryChanceRecords") {
    validateOptionalString(input, "activityId", cleanOperation);
    validateOptionalNonNegativeInteger(input, "offset", cleanOperation);
    validateOptionalNonNegativeInteger(input, "limit", cleanOperation);
  }
  if (cleanOperation === "uploadAttachment") {
    if (hasOwn(input, "attachment") && !plainObject(input.attachment)) {
      throw new CliUsageError("Probe input for uploadAttachment.attachment must be an object.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
    const attachment = plainObject(input.attachment) ? input.attachment : null;
    if (attachment) {
      for (const key of ["filename", "mimeType", "data"]) {
        if (hasOwn(attachment, key) && !nonEmptyString(attachment[key])) {
          throw new CliUsageError("Probe input for uploadAttachment.attachment." + key + " must be a non-empty string.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
        }
      }
    }
  }
}

function assertConfirmedSideEffectInput(input, operation) {
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  if (!SIDE_EFFECT_PROBE_OPERATIONS.has(cleanOperation)) return;
  if (!input || input.confirmSideEffect !== true) {
    throw new CliUsageError(
      "Probe input for " + cleanOperation + " requires confirmSideEffect:true before side-effect capture.",
      { code: "SIDE_EFFECT_CONFIRMATION_REQUIRED" },
    );
  }
}

function messageContentStrings(message = {}) {
  const content = message?.content;
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    return content.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object" && typeof item.text === "string") return [item.text];
      return [];
    });
  }
  return [];
}

function assertProbeInputReadyForProtocol(input, operation) {
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  if (cleanOperation !== "sendMessage") return;
  if (!plainObject(input) || !Array.isArray(input.messages) || input.messages.length === 0) {
    throw new CliUsageError("Probe protocol sendMessage requires explicit reviewed messages before dispatch.", { code: "PROBE_INPUT_NOT_REVIEWED" });
  }
  const messageContents = input.messages.flatMap((message) => messageContentStrings(message));
  const hasReviewedContent = messageContents.some((content) => {
    const text = String(content || "").trim();
    return text && text !== REDACTED_MESSAGE_CONTENT_PLACEHOLDER;
  });
  if (!hasReviewedContent) {
    throw new CliUsageError("Probe protocol sendMessage requires replacing redacted message content before dispatch.", { code: "PROBE_INPUT_NOT_REVIEWED" });
  }
}

function buildSendMessageReviewSummary(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const messageContents = messages.flatMap((message) => messageContentStrings(message));
  const redactedMessageContentPresent = messageContents.some((content) => String(content || "").trim() === REDACTED_MESSAGE_CONTENT_PLACEHOLDER);
  const protocolDispatchReady = messageContents.some((content) => {
    const text = String(content || "").trim();
    return text && text !== REDACTED_MESSAGE_CONTENT_PLACEHOLDER;
  });
  return {
    requiresReviewedInput: true,
    reviewRequirement: SEND_MESSAGE_REVIEW_REQUIREMENT,
    redactedMessageContentPresent,
    protocolDispatchReady,
  };
}

function assertProtocolProbeOperationDispatchable(operation) {
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  if (!OFFLINE_EVIDENCE_PROBE_OPERATIONS.has(cleanOperation)) return;
  throw new CliUsageError(
    "Probe protocol operation " + cleanOperation + " is offline evidence only; use probe template and probe validate, then store a sanitized fixture.",
    { code: "OFFLINE_EVIDENCE_OPERATION" },
  );
}

function probeInputFieldState(input, key) {
  if (!plainObject(input) || !hasOwn(input, key)) return "missing";
  const value = input[key];
  if (plainObject(value)) return "object";
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "string" && value.trim()) return "present";
  return typeof value;
}

function sortedObjectKeys(value) {
  return plainObject(value) ? Object.keys(value).sort() : [];
}

function buildProbeInputValidationPreview({ operation = "verifySession", input } = {}) {
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  const inputObject = plainObject(input) ? input : {};
  const evidenceObject = plainObject(inputObject.evidence) ? inputObject.evidence : {};
  const preview = {
    status: "valid",
    operation: cleanOperation,
    source: input === undefined ? "default" : "input",
    sideEffect: SIDE_EFFECT_PROBE_OPERATIONS.has(cleanOperation),
    fields: {
      confirmSideEffect: probeInputFieldState(inputObject, "confirmSideEffect"),
      email: probeInputFieldState(inputObject, "email"),
      mobile: probeInputFieldState(inputObject, "mobile"),
      code: probeInputFieldState(inputObject, "code"),
      uuid: probeInputFieldState(inputObject, "uuid"),
      body: probeInputFieldState(inputObject, "body"),
      messages: probeInputFieldState(inputObject, "messages"),
      stream: hasOwn(inputObject, "stream") ? inputObject.stream === true : "missing",
      attachment: probeInputFieldState(inputObject, "attachment"),
      requestNo: probeInputFieldState(inputObject, "requestNo"),
      placementCode: probeInputFieldState(inputObject, "placementCode"),
      activityId: probeInputFieldState(inputObject, "activityId"),
      userId: probeInputFieldState(inputObject, "userId"),
      couponCode: probeInputFieldState(inputObject, "couponCode"),
      couponType: probeInputFieldState(inputObject, "couponType"),
      kind: probeInputFieldState(inputObject, "kind"),
      status: probeInputFieldState(inputObject, "status"),
      evidence: probeInputFieldState(inputObject, "evidence"),
      result: probeInputFieldState(inputObject, "result"),
      streamEvidence: probeInputFieldState(inputObject, "streamEvidence"),
    },
    bodyKeys: sortedObjectKeys(inputObject.body),
    attachmentKeys: sortedObjectKeys(inputObject.attachment),
    evidenceKeys: sortedObjectKeys(evidenceObject),
  };
  if (hasOwn(inputObject, "confirmSideEffect")) {
    preview.confirmSideEffect = inputObject.confirmSideEffect === true;
  }
  if (plainObject(inputObject.streamEvidence)) {
    preview.streamEvidence = {
      mode: String(inputObject.streamEvidence.mode || ""),
      maxDeltas: Number.isInteger(inputObject.streamEvidence.maxDeltas)
        ? inputObject.streamEvidence.maxDeltas
        : 2,
    };
  }
  if (cleanOperation === "sendMessage") {
    preview.sendMessageReview = buildSendMessageReviewSummary(inputObject);
  }
  if (cleanOperation === "recoverSession") {
    preview.sessionRecovery = {
      strategy: canonicalString(evidenceObject.strategy || evidenceObject.current),
      automatedRefresh: canonicalString(evidenceObject.automatedRefresh || evidenceObject.automated_refresh || evidenceObject.mode),
      observedWindowMs: positiveInteger(evidenceObject.observedWindowMs),
      resultHash: safeSha256Evidence(evidenceObject.resultHash),
      safe: evidenceObject.safe === true,
      sanitized: evidenceObject.sanitized === true,
      rawPayload: sessionRecoveryRawPayload(evidenceObject),
      expiredBeforeRecovery: inputObject.result?.expiredBeforeRecovery === true,
      recoveredVerifySession: inputObject.result?.recoveredVerifySession === true,
    };
  }
  if (cleanOperation === "consumeResetCoupon") {
    preview.resetCouponConsumption = {
      endpointHash: safeSha256Evidence(evidenceObject.endpointHash),
      bodyHash: safeSha256Evidence(evidenceObject.bodyHash),
      resultHash: safeSha256Evidence(evidenceObject.resultHash),
      safe: evidenceObject.safe === true,
      sanitized: evidenceObject.sanitized === true,
      rawPayload: resetCouponRawPayload(evidenceObject),
      consumptionSignal: resetCouponHasConsumptionSignal(inputObject.result),
      nonConsumptionSignal: resetCouponHasNonConsumptionSignal(inputObject.result),
    };
  }
  return preview;
}

function buildOfflineEvidenceFixture({ operation, input, now } = {}) {
  const observedAt = safeNowIso(now);
  if (operation === "recoverSession") {
    return sanitizeProtocolProbeFixture({
      kind: "session_recovery_strategy",
      observedAt,
      operation: "recoverSession",
      status: "success",
      evidence: {
        strategy: canonicalString(input.evidence.strategy || input.evidence.current),
        automatedRefresh: canonicalString(input.evidence.automatedRefresh || input.evidence.automated_refresh || input.evidence.mode),
        observedWindowMs: input.evidence.observedWindowMs,
        resultHash: input.evidence.resultHash,
        safe: true,
        sanitized: true,
        rawPayload: false,
      },
      result: {
        expiredBeforeRecovery: true,
        recoveredVerifySession: true,
      },
    });
  }
  if (operation === "consumeResetCoupon") {
    return sanitizeProtocolProbeFixture({
      kind: "reset_coupon_consumption_evidence",
      observedAt,
      operation: input.operation,
      status: "success",
      evidence: {
        endpointHash: input.evidence.endpointHash,
        bodyHash: input.evidence.bodyHash,
        resultHash: input.evidence.resultHash,
        safe: true,
        sanitized: true,
        rawPayload: false,
      },
      result: {
        ...(input.result.resetCouponConsumed === true ? { resetCouponConsumed: true } : {}),
        ...(input.result.reset_coupon_consumed === true ? { reset_coupon_consumed: true } : {}),
        ...(input.result.couponConsumed === true ? { couponConsumed: true } : {}),
        ...(input.result.coupon_consumed === true ? { coupon_consumed: true } : {}),
        ...(input.result.consumed === true ? { consumed: true } : {}),
        ...(input.result.used === true ? { used: true } : {}),
        ...(input.result.deducted === true ? { deducted: true } : {}),
        ...(["consumeResult", "consume_result", "couponResult", "coupon_result", "usageResult", "usage_result"]
          .reduce((acc, key) => (hasOwn(input.result, key) ? { ...acc, [key]: input.result[key] } : acc), {})),
      },
    });
  }
  throw new CliUsageError(
    "Probe validate --write-fixture only supports offline evidence operations.",
    { code: "OFFLINE_EVIDENCE_WRITE_ONLY" },
  );
}

function summarizeOfflineEvidenceFixture(fixture = {}) {
  const output = {
    kind: fixture.kind,
    operation: fixture.operation,
    status: fixture.status,
  };
  if (fixture.observedAt) output.observedAt = fixture.observedAt;
  if (fixture.kind === "session_recovery_strategy") {
    output.evidence = {
      strategy: fixture.evidence?.strategy || "",
      automatedRefresh: fixture.evidence?.automatedRefresh || "",
      observedWindowMs: positiveInteger(fixture.evidence?.observedWindowMs),
      resultHash: safeSha256Evidence(fixture.evidence?.resultHash),
      safe: fixture.evidence?.safe === true,
      sanitized: fixture.evidence?.sanitized === true,
      rawPayload: sessionRecoveryRawPayload(fixture.evidence || {}),
      expiredBeforeRecovery: fixture.result?.expiredBeforeRecovery === true,
      recoveredVerifySession: fixture.result?.recoveredVerifySession === true,
    };
  }
  if (fixture.kind === "reset_coupon_consumption_evidence") {
    output.evidence = {
      endpointHash: safeSha256Evidence(fixture.evidence?.endpointHash),
      bodyHash: safeSha256Evidence(fixture.evidence?.bodyHash),
      resultHash: safeSha256Evidence(fixture.evidence?.resultHash),
      safe: fixture.evidence?.safe === true,
      sanitized: fixture.evidence?.sanitized === true,
      rawPayload: resetCouponRawPayload(fixture.evidence || {}),
    };
  }
  return output;
}



function safeNowIso(now) {
  return new Date(protocolNow(now)).toISOString();
}

function emptyReadinessState() {
  return {
    version: 1,
    codex: { verified: false },
    claude: { verified: false },
  };
}

function normalizeReadinessState(state = {}) {
  const input = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const codex = input.codex && typeof input.codex === "object" ? input.codex : {};
  const claude = input.claude && typeof input.claude === "object" ? input.claude : {};
  return {
    version: 1,
    codex: {
      verified: Boolean(codex.verified || input.codexVerified),
      ...(codex.verifiedAt ? { verifiedAt: String(codex.verifiedAt) } : {}),
    },
    claude: {
      verified: Boolean(claude.verified || input.claudeVerified),
      ...(claude.verifiedAt ? { verifiedAt: String(claude.verifiedAt) } : {}),
    },
  };
}

function sanitizeReadinessStateForDisplay(state = {}) {
  const normalized = normalizeReadinessState(state);
  return {
    version: normalized.version,
    codex: {
      verified: normalized.codex.verified,
      ...(normalized.codex.verifiedAt ? { verifiedAt: String(normalized.codex.verifiedAt) } : {}),
    },
    claude: {
      verified: normalized.claude.verified,
      ...(normalized.claude.verifiedAt ? { verifiedAt: String(normalized.claude.verifiedAt) } : {}),
    },
  };
}

class FileReadinessStateStore {
  constructor({ stateDir, filePath } = {}) {
    if (!filePath && !stateDir) throw new Error("readiness stateDir is required");
    this.filePath = filePath || path.join(stateDir, "readiness.json");
  }

  async readState() {
    try {
      const text = await readTextFile(this.filePath, "utf8");
      return normalizeReadinessState(JSON.parse(text));
    } catch (error) {
      if (error?.code === "ENOENT") return emptyReadinessState();
      throw error;
    }
  }

  async writeState(nextState) {
    const normalized = normalizeReadinessState(nextState);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeTextFile(this.filePath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
    return normalized;
  }
}

function protocolNow(now) {
  const value = typeof now === "function" ? now() : now;
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function configuredProtocolClientOptions(protocol = {}) {
  const options = {};
  for (const key of ["baseUrl", "fetchTransport", "signKeyPath", "modelCatalogPath", "modelCatalogScene", "sendPath", "authSendCodePath", "authSendCodeMethod", "authSubmitCodePath", "authSubmitCodeMethod", "attachmentUploadPath", "attachmentCompleteUploadPath", "quotaUsagePath", "activityLotteryPath", "newbieExplorationPath", "placementResourcesPath", "rewardCardRecordsPath", "lotteryHitRecordsPath", "signInStatusPath", "signInPath", "benefitCouponListPath", "benefitCouponUsePath", "activityParticipatePath", "usageResetCouponSkuPath", "lotteryAvailableChancesPath", "lotteryActiveMainPoolsPath", "lotteryChanceRecordsPath", "lotteryDrawPath", "sessionVerifyPath", "sessionVerifyMethod", "reqCtx", "defaultChatSessionId", "chatSessionCreatePath", "chatSessionCreateActionId", "chatSessionAutoCreate"]) {
    if (protocol[key]) options[key] = protocol[key];
  }
  return options;
}

function selectProtocolFetch({ fetch: fetchImpl = null, fetchTransport = "node", protocolFetchTransports = {} } = {}) {
  if (fetchImpl) return fetchImpl;
  if (fetchTransport === "powershell") {
    return protocolFetchTransports.powershell || createPowerShellFetch();
  }
  return globalThis.fetch;
}

function createConfiguredProtocolClientFactory(config, { fetch: fetchImpl, now, protocolFetchTransports = {} } = {}) {
  if (!config.protocol?.enabled) return null;
  const { fetchTransport = "node", ...protocolClientOptions } = configuredProtocolClientOptions(config.protocol);
  const selectedFetch = selectProtocolFetch({ fetch: fetchImpl, fetchTransport, protocolFetchTransports });
  return () => new ProtocolTabbitClient({
    ...protocolClientOptions,
    fetch: selectedFetch,
    now: () => protocolNow(now),
  });
}

function createConfiguredAccountProtocolClient(protocolClientFactory, protocol = {}) {
  if (typeof protocolClientFactory !== "function") return {};
  const client = {
    async verifySession(input = {}) {
      const protocolClient = protocolClientFactory(input.account || {});
      return await protocolClient.verifySession(input);
    },
  };
  if (protocol.authSendCodePath) {
    client.sendVerificationCode = async (input = {}) => {
      const protocolClient = protocolClientFactory(input.account || {});
      return await protocolClient.sendVerificationCode(input);
    };
  }
  if (protocol.authSubmitCodePath) {
    client.submitRegistrationOrLogin = async (input = {}) => {
      const protocolClient = protocolClientFactory(input.account || {});
      return await protocolClient.submitRegistrationOrLogin(input);
    };
  }
  return client;
}

async function hydrateMaintenanceAccountSession(account = {}, secretStore = null) {
  let session = account.cookie || account.cookieHeader || null;
  if (!session && account.cookieJarRef && typeof secretStore?.readSecret === "function") {
    session = await secretStore.readSecret(account.cookieJarRef);
  }
  const runtimeAccount = { ...account };
  if (session && !runtimeAccount.cookie && !runtimeAccount.cookieHeader) runtimeAccount.cookieHeader = session;
  return runtimeAccount;
}

function maintenanceRequestDate(now = () => Date.now()) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function buildDailySignInRequestNo(now = () => Date.now()) {
  const stamp = maintenanceRequestDate(now).toISOString().slice(0, 10).replaceAll("-", "");
  return `daily-sign-in-${stamp}-${randomBytes(6).toString("hex")}`;
}

function createConfiguredMaintenanceProtocolClient(protocolClientFactory, protocol = {}, secretStore = null, now = () => Date.now()) {
  if (typeof protocolClientFactory !== "function") return {};
  const client = {};
  if (protocol.quotaUsagePath) {
    client.refreshQuota = async (account = {}) => {
      const runtimeAccount = await hydrateMaintenanceAccountSession(account, secretStore);
      const protocolClient = protocolClientFactory(runtimeAccount);
      return await protocolClient.refreshQuota({ account: runtimeAccount });
    };
  }
  if (protocol.signInPath) {
    client.dailyCheckin = async (account = {}) => {
      const runtimeAccount = await hydrateMaintenanceAccountSession(account, secretStore);
      const protocolClient = protocolClientFactory(runtimeAccount);
      if (protocol.signInStatusPath && typeof protocolClient.getDailySignInStatus === "function") {
        const status = await protocolClient.getDailySignInStatus({ account: runtimeAccount });
        if (status?.signedToday === true) return status;
      }
      return await protocolClient.dailySignIn({
        account: runtimeAccount,
        requestNo: buildDailySignInRequestNo(now),
        confirmSideEffect: true,
      });
    };
  }
  return client;
}

async function readSessionFile(pathValue, flag) {
  try {
    return await readTextFile(pathValue, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CliUsageError("Session input file was not found for " + flag + ".", { code: "SESSION_INPUT_FILE_NOT_FOUND" });
    }
    throw error;
  }
}

function importSessionSources(args) {
  return [
    { flag: "--cookie-header", field: "cookieHeader", value: requiredValueAfter(args, "--cookie-header"), file: false },
    { flag: "--session", field: "session", value: requiredValueAfter(args, "--session"), file: false },
    { flag: "--cookie-file", field: "cookieHeader", value: requiredValueAfter(args, "--cookie-file"), file: true },
    { flag: "--session-file", field: "session", value: requiredValueAfter(args, "--session-file"), file: true },
  ].filter((source) => source.value);
}

async function readImportSessionInput(args) {
  const sources = importSessionSources(args);
  if (sources.length !== 1) {
    throw new CliUsageError("Use exactly one session source: --cookie-header, --session, --cookie-file, or --session-file.", { code: "IMPORT_SESSION_SOURCE_COUNT" });
  }
  const source = sources[0];
  const sessionValue = source.file ? await readSessionFile(source.value, source.flag) : source.value;
  if (!String(sessionValue || "").trim()) {
    throw new CliUsageError("Session source is empty.", { code: "IMPORT_SESSION_EMPTY" });
  }
  const input = {
    [source.field]: String(sessionValue).trim(),
  };
  const id = requiredValueAfter(args, "--id") || requiredValueAfter(args, "--account-id");
  const email = requiredValueAfter(args, "--email");
  const userId = requiredValueAfter(args, "--user-id");
  const accessTier = requiredValueAfter(args, "--access-tier");
  const cookieJarRef = requiredValueAfter(args, "--cookie-jar-ref");
  const chatSessionId = requiredValueAfter(args, "--chat-session-id");
  if (id) input.id = id;
  if (email) input.email = email;
  if (userId) input.userId = userId;
  if (accessTier) {
    const normalizedAccessTier = String(accessTier).trim().toLowerCase();
    if (!ACCOUNT_IMPORT_ACCESS_TIERS.has(normalizedAccessTier)) {
      throw new CliUsageError("--access-tier must be unknown, free, or pro.", { code: "INVALID_ACCESS_TIER" });
    }
    input.accessTier = normalizedAccessTier;
  }
  if (cookieJarRef) input.cookieJarRef = cookieJarRef;
  if (chatSessionId) input.chatSessionId = String(chatSessionId).trim();
  return input;
}

async function readProbeInput(args) {
  const inputJson = requiredValueAfter(args, "--input-json");
  const inputFile = requiredValueAfter(args, "--input-file");
  if (inputJson && inputFile) {
    throw new CliUsageError("Use only one of --input-json or --input-file.", { code: "PROBE_INPUT_CONFLICT" });
  }
  if (inputJson) return parseProbeInputJson(inputJson, "--input-json");
  if (!inputFile) return undefined;

  let text;
  try {
    text = await readTextFile(inputFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CliUsageError("Probe input file was not found for --input-file.", { code: "PROBE_INPUT_FILE_NOT_FOUND" });
    }
    throw error;
  }
  return parseProbeInputJson(text, "--input-file");
}

function visibleQuota(account) {
  const quota = Array.isArray(account.quotaState) ? account.quotaState[0] : null;
  if (!quota) return "-";
  if (Number.isFinite(quota.remaining) && Number.isFinite(quota.limit)) return `${quota.remaining}/${quota.limit}`;
  if (Number.isFinite(quota.remaining)) return String(quota.remaining);
  return quota.exhausted ? "exhausted" : "-";
}

function table(accounts) {
  const lines = ["id\tstatus\taccessTier\temail\tquota\tlastError"];
  for (const account of accounts) {
    lines.push([
      account.id || "",
      account.status || "unknown",
      account.accessTier || "unknown",
      account.email || "",
      visibleQuota(account),
      account.lastError?.category || "",
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

async function loadAccounts(accountStore) {
  return await accountStore.loadAccounts();
}

export function createProtocolPoolCliDependencies(options = {}) {
  const config = options.config || loadConfig(options.env, options);
  const now = options.now || (() => Date.now());
  const nowDate = () => new Date(typeof now === "function" ? now() : now);
  const accountStore = options.accountStore || new JsonAccountStore({ stateDir: config.stateDir });
  const secretStore = options.secretStore || new FileSecretStore({ stateDir: config.stateDir });
  const protocolFixtureStore = options.protocolFixtureStore || new FileProtocolFixtureStore({
    stateDir: config.stateDir,
    fixtureDir: config.protocolFixtureDir,
    now,
  });
  const configuredProtocolClientFactory = createConfiguredProtocolClientFactory(config, {
    fetch: options.fetch,
    now,
    protocolFetchTransports: options.protocolFetchTransports || {},
  });
  const protocolProbeClientFactory = hasOwn(options, "protocolProbeClientFactory")
    ? options.protocolProbeClientFactory
    : configuredProtocolClientFactory;
  const accountProtocolClient = hasOwn(options, "protocolClient")
    ? options.protocolClient
    : createConfiguredAccountProtocolClient(configuredProtocolClientFactory, config.protocol || {});
  const maintenanceProtocolClient = hasOwn(options, "maintenanceProtocolClient")
    ? options.maintenanceProtocolClient
    : createConfiguredMaintenanceProtocolClient(configuredProtocolClientFactory, config.protocol || {}, secretStore, now);
  const benefitsMaintainer = options.benefitsMaintainer || new BenefitsMaintainer({ protocolClient: maintenanceProtocolClient, accountStore, now: nowDate });
  const protocolProbeRunner = options.protocolProbeRunner || new ProtocolProbeRunner({
    accountStore,
    secretStore,
    fixtureStore: protocolFixtureStore,
    protocolClientFactory: protocolProbeClientFactory || null,
    now,
  });
  const accountVerifier = options.accountVerifier || {
    verifyAccount(accountId, verifyOptions = {}) {
      const provisioner = new AccountProvisioner({
        accountStore,
        secretStore,
        protocolClient: accountProtocolClient || {},
        now: nowDate,
      });
      return provisioner.verifyAccount(accountId, verifyOptions);
    },
  };

  return {
    config,
    accountStore,
    secretStore,
    accountProtocolClient,
    benefitsMaintainer,
    accountVerifier,
    protocolFixtureStore,
    protocolProbeRunner,
    readinessStateStore: options.readinessStateStore || new FileReadinessStateStore({ stateDir: config.stateDir }),
    now,
    startedAt: options.startedAt ?? Date.now(),
    gatewayFactory: options.gatewayFactory || createProtocolPoolGateway,
    waitForShutdown: options.waitForShutdown || waitForShutdownSignal,
  };
}

function createDefaultMaintainer(now) {
  return new BenefitsMaintainer({
    protocolClient: {},
    now: () => new Date(typeof now === "function" ? now() : Date.now()),
  });
}

async function handleAccountsImportSession(args, deps, stdout) {
  const input = await readImportSessionInput(args);
  const provisioner = new AccountProvisioner({
    accountStore: deps.accountStore,
    secretStore: deps.secretStore,
    protocolClient: {},
    now: () => new Date(typeof deps.now === "function" ? deps.now() : Date.now()),
  });
  const result = await provisioner.importSession(input);
  const events = formatMaintenanceActionLog({
    accountId: result.account?.id || input.id || input.accountId,
    actions: result.actions,
    now: deps.now,
  });
  if (hasFlag(args, "--json")) {
    writeLine(stdout, json({
      changed: Boolean(result.changed),
      account: result.account ? redactAccountForDisplay(result.account) : null,
      events,
    }));
  } else {
    writeLine(stdout, [
      "changed\t" + Boolean(result.changed),
      "account\t" + (result.account?.id || ""),
      ...events.map((event) => `${event.action}\t${event.status}`),
      "",
    ].join("\n"));
  }
  return { exitCode: result.changed ? 0 : 1 };
}

async function handleAccountsList(args, deps, stdout) {
  const accounts = redactAccountsForDisplay(await loadAccounts(deps.accountStore));
  if (hasFlag(args, "--json")) writeLine(stdout, json({ accounts }));
  else writeLine(stdout, table(accounts));
  return { exitCode: 0 };
}

async function handleHealth(args, deps, stdout) {
  const accounts = await loadAccounts(deps.accountStore);
  const snapshot = buildHealthSnapshot({
    accounts,
    startedAt: deps.startedAt,
    now: deps.now,
  });
  if (hasFlag(args, "--json")) writeLine(stdout, json(snapshot));
  else writeLine(stdout, `${snapshot.status}\tactive=${snapshot.accounts.active}\ttotal=${snapshot.accounts.total}\n`);
  return { exitCode: 0 };
}


async function handleSmokeGateway(args, deps, stdout) {
  const baseUrl = optionalCliValue(args, "--base-url", gatewayBaseUrlFromConfig(deps.config));
  const apiKey = optionalCliValue(args, "--api-key", deps.config.apiKey || "sk-tabbit-local");
  const model = optionalCliValue(args, "--model", "tabbit/priority");
  const snapshot = await runGatewaySmoke({
    baseUrl,
    apiKey,
    model,
    fetchImpl: deps.fetch || globalThis.fetch,
  });
  if (hasFlag(args, "--json")) writeLine(stdout, json(snapshot));
  else {
    writeLine(stdout, [
      "status	" + snapshot.status,
      ...snapshot.steps.map((step) => step.name + "	" + (step.ok ? "ok" : "failed") + "	" + step.statusCode),
      "",
    ].join("\n"));
  }
  return { exitCode: snapshot.status === "ok" ? 0 : 1 };
}

async function handleServe(args, deps, stdout) {
  const host = parseOptionalHost(args, deps.config.host);
  const port = parseOptionalPort(args, deps.config.port);
  const gateway = await deps.gatewayFactory({ config: deps.config });
  let started = false;
  try {
    const server = await gateway.start({ host, port });
    started = true;
    const address = listeningAddress(server || gateway.server, { host, port });
    const info = serveInfo(address);
    if (hasFlag(args, "--json")) {
      writeLine(stdout, json(info));
    } else {
      writeLine(stdout, [
        "listening\t" + info.host + ":" + info.port,
        "openai_base_url\t" + info.openaiBaseUrl,
        "anthropic_base_url\t" + info.anthropicBaseUrl,
        "",
      ].join("\n"));
    }
    await deps.waitForShutdown({ gateway, server: server || gateway.server, address, info, config: deps.config });
    return { exitCode: 0 };
  } finally {
    if (started && typeof gateway?.close === "function") {
      await gateway.close();
    }
  }
}


async function handleReadinessMark(args, deps, stdout) {
  const markCodex = hasFlag(args, "--codex-verified");
  const markClaude = hasFlag(args, "--claude-verified");
  if (!markCodex && !markClaude) {
    throw new CliUsageError("Missing verification flag for readiness mark.", { code: "MISSING_READINESS_MARK" });
  }
  const current = deps.readinessStateStore && typeof deps.readinessStateStore.readState === "function"
    ? normalizeReadinessState(await deps.readinessStateStore.readState())
    : emptyReadinessState();
  const verifiedAt = safeNowIso(deps.now);
  const nextState = normalizeReadinessState(current);
  if (markCodex) nextState.codex = { verified: true, verifiedAt };
  if (markClaude) nextState.claude = { verified: true, verifiedAt };
  const saved = deps.readinessStateStore && typeof deps.readinessStateStore.writeState === "function"
    ? await deps.readinessStateStore.writeState(nextState)
    : nextState;
  const readiness = sanitizeReadinessStateForDisplay(saved);
  if (hasFlag(args, "--json")) writeLine(stdout, json({ readiness }));
  else {
    writeLine(stdout, [
      "codex_verified	" + readiness.codex.verified,
      "claude_verified	" + readiness.claude.verified,
      "",
    ].join("\n"));
  }
  return { exitCode: 0 };
}

async function readProtocolFixtureDetails(protocolFixtureStore, { operation, operations } = {}) {
  const listedFixtures = protocolFixtureStore && typeof protocolFixtureStore.listFixtures === "function"
    ? await protocolFixtureStore.listFixtures()
    : [];
  const allowedOperations = Array.isArray(operations) ? new Set(operations) : null;
  const fixturesToRead = Array.isArray(listedFixtures)
    ? listedFixtures.filter((fixture) => {
      if (operation) return fixture?.operation === operation;
      if (allowedOperations) return allowedOperations.has(fixture?.operation);
      return true;
    })
    : [];
  if (!protocolFixtureStore || typeof protocolFixtureStore.readFixture !== "function") return fixturesToRead;
  return await Promise.all(fixturesToRead.map(async (fixture) => {
    if (!fixture?.ref) return fixture;
    try {
      return await protocolFixtureStore.readFixture(fixture.ref);
    } catch {
      return fixture;
    }
  }));
}

async function handleReadiness(args, deps, stdout) {
  const accounts = await loadAccounts(deps.accountStore);
  const fixtures = await readProtocolFixtureDetails(deps.protocolFixtureStore);
  const readinessState = deps.readinessStateStore && typeof deps.readinessStateStore.readState === "function"
    ? normalizeReadinessState(await deps.readinessStateStore.readState())
    : emptyReadinessState();
  const snapshot = buildCalibrationReadinessSnapshot({
    accounts,
    config: deps.config,
    fixtures,
    codexVerified: readinessState.codex.verified,
    claudeVerified: readinessState.claude.verified,
    now: deps.now,
  });
  if (hasFlag(args, "--json")) writeLine(stdout, json(snapshot));
  else {
    writeLine(stdout, [
      `status\t${snapshot.status}`,
      `protocol\t${snapshot.checks.protocolCalibration.status}`,
      `codex_claude\t${snapshot.checks.codexClaudeE2E.status}`,
      `tool_loop\t${snapshot.checks.toolLoopDecision.status}`,
      `forbidden_403\t${snapshot.checks.forbidden403.status}`,
      "",
    ].join("\n"));
  }
  return { exitCode: 0 };
}

function readinessDoctorMissingNames(report = {}) {
  const checks = report.readiness?.checks && typeof report.readiness.checks === "object" ? report.readiness.checks : {};
  return uniqueStrings([
    ...Object.values(checks).flatMap((check = {}) => Array.isArray(check.missing) ? check.missing : []),
    ...(Array.isArray(report.fixtureAudit?.missing) ? report.fixtureAudit.missing : []),
  ]);
}

async function buildDoctorReportForCli(deps) {
  const accounts = await loadAccounts(deps.accountStore);
  const fixtures = await readProtocolFixtureDetails(deps.protocolFixtureStore);
  const readinessState = deps.readinessStateStore && typeof deps.readinessStateStore.readState === "function"
    ? normalizeReadinessState(await deps.readinessStateStore.readState())
    : emptyReadinessState();
  return buildReadinessDoctorReport({
    accounts,
    config: deps.config,
    fixtures,
    readinessState,
    now: deps.now,
  });
}

function plainCaptureCommandLines(commands = []) {
  return (Array.isArray(commands) ? commands : []).map((item = {}) => {
    const streamEvidence = item.recommendedInput?.streamEvidence;
    return [
      "capture_command",
      item.missing || "",
      item.scope || "",
      "side_effect=" + Boolean(item.sideEffect),
      "template=" + (item.templateCommand || ""),
      "validate=" + (item.validateCommand || ""),
      "confirm_validate=" + (item.confirmedValidateCommand || ""),
      "probe=" + (item.probeCommand || ""),
      "write_fixture=" + (item.writeFixtureCommand || ""),
      ...(streamEvidence?.mode
        ? ["stream_evidence=" + streamEvidence.mode + ":" + (Number.isInteger(streamEvidence.maxDeltas) ? streamEvidence.maxDeltas : "")]
        : []),
      ...(item.reviewRequirement ? ["review=" + item.reviewRequirement] : []),
      "prereq=" + (Array.isArray(item.prerequisites)
        ? item.prerequisites.map((prerequisite = {}) => `${prerequisite.env || ""}:${prerequisite.status || ""}`).join(",")
        : ""),
      "reason=" + (item.reason || ""),
    ].join("\t");
  });
}

async function handleReadinessDoctor(args, deps, stdout) {
  const report = await buildDoctorReportForCli(deps);
  if (hasFlag(args, "--json")) {
    writeLine(stdout, json(report));
  } else {
    const backlog = report.calibrationBacklog || {};
    const scopes = backlog.scopes || {};
    const missingCount = (item) => Array.isArray(item?.missing) ? item.missing.length : 0;
    writeLine(stdout, [
      `status\t${report.status}`,
      `state_dir\t${report.stateDir}`,
      `protocol\t${report.readiness.checks.protocolCalibration.status}`,
      `fixtures\t${report.fixtureAudit.status}`,
      `auth_send_endpoint\t${report.protocol.authSendCodePathConfigured ? "configured" : "missing"}`,
      `auth_submit_endpoint\t${report.protocol.authSubmitCodePathConfigured ? "configured" : "missing"}`,
      `remaining_work\t${report.remainingWork.length}`,
      `manual_cookie_mode\t${report.manualCookieMode?.status || ""}\tmode=${report.manualCookieMode?.mode || ""}\tautomated_refresh=${report.manualCookieMode?.automatedSessionRefresh?.status || ""}\tmissing=${Array.isArray(report.manualCookieMode?.missing) ? report.manualCookieMode.missing.join(",") : ""}\trelease_blocking_missing=${Array.isArray(report.manualCookieMode?.blockingMissing) ? report.manualCookieMode.blockingMissing.join(",") : ""}\tbacklog_missing=${Array.isArray(report.manualCookieMode?.backlogMissing) ? report.manualCookieMode.backlogMissing.join(",") : ""}`,
      `preflight_command\taccount_read_only\t${report.commands?.accountPreflightReadOnly || ""}`,
      `mark_command\tcodex_e2e\t${report.commands?.codexE2EMark || ""}`,
      `mark_command\tclaude_code_e2e\t${report.commands?.claudeE2EMark || ""}`,
      `mark_command\tcombined_e2e\t${report.commands?.combinedE2EMark || ""}`,
      `calibration_backlog\t${backlog.status || ""}\tmissing=${missingCount(backlog)}`,
      `auth_backlog\t${scopes.auth?.status || ""}\tmissing=${missingCount(scopes.auth)}`,
      `benefits_backlog\t${scopes.benefits?.status || ""}\tmissing=${missingCount(scopes.benefits)}`,
      `session_backlog\t${scopes.session?.status || ""}\tmissing=${missingCount(scopes.session)}`,
      `upstream_backlog\t${scopes.upstream?.status || ""}\tmissing=${missingCount(scopes.upstream)}`,
      ...plainCaptureCommandLines(backlog.captureCommands),
      "",
    ].join("\n"));
  }
  return { exitCode: 0 };
}

function buildProductionPreflightReport({ doctorReport, config = {} } = {}) {
  const apiKeyMissing = config.apiKey && config.apiKey !== DEFAULT_GATEWAY_API_KEY
    ? []
    : ["non_default_api_key"];
  const readinessMissing = doctorReport?.status === "ready" ? [] : readinessDoctorMissingNames(doctorReport);
  const manualCookieMissing = Array.isArray(doctorReport?.manualCookieMode?.blockingMissing)
    ? doctorReport.manualCookieMode.blockingMissing
    : ["manual_cookie_mode_ready"];
  const missing = uniqueStrings([
    ...apiKeyMissing,
    ...readinessMissing,
    ...manualCookieMissing,
  ]);

  return {
    status: missing.length ? "blocked" : "ready",
    observedAt: doctorReport?.observedAt || safeNowIso(),
    stateDir: String(doctorReport?.stateDir || config.stateDir || ""),
    checks: {
      gatewayApiKey: {
        status: apiKeyMissing.length ? "blocked" : "ready",
        missing: apiKeyMissing,
      },
      readinessDoctor: {
        status: doctorReport?.status || "blocked",
        missing: readinessMissing,
      },
      manualCookieMode: {
        status: doctorReport?.manualCookieMode?.status || "blocked",
        mode: doctorReport?.manualCookieMode?.mode || "",
        missing: manualCookieMissing,
        backlogMissing: Array.isArray(doctorReport?.manualCookieMode?.backlogMissing)
          ? doctorReport.manualCookieMode.backlogMissing
          : [],
      },
    },
    missing,
    ...(apiKeyMissing.length ? {
      commands: {
        initGatewayKey: "node bin\\tabbit-pool.js production init-key --json",
      },
    } : {}),
    nextActions: uniqueStrings([
      ...(apiKeyMissing.length ? ["Set TABBIT_POOL_API_KEY to a non-default secret or create stateDir/secrets/gateway-api-key.txt before exposing the gateway."] : []),
      ...(Array.isArray(doctorReport?.remainingWork) ? doctorReport.remainingWork : []),
      ...(Array.isArray(doctorReport?.manualCookieMode?.nextActions) ? doctorReport.manualCookieMode.nextActions : []),
    ]),
  };
}

function generateGatewayApiKey() {
  return "sk-tabbit-pool-" + randomBytes(32).toString("base64url");
}

async function handleProductionInitKey(args, deps, stdout) {
  const existingSource = deps.config?.productionState?.apiKeySource || (deps.config?.apiKey === DEFAULT_GATEWAY_API_KEY ? "default" : "unknown");
  const alreadyConfigured = deps.config?.apiKey && deps.config.apiKey !== DEFAULT_GATEWAY_API_KEY;
  let changed = false;
  if (!alreadyConfigured) {
    if (deps.config?.productionState?.source === "default_local") {
      throw new CliUsageError("No production stateDir is configured or auto-discovered for production init-key.", { code: "PRODUCTION_STATE_DIR_MISSING" });
    }
    const key = generateGatewayApiKey();
    try {
      await deps.secretStore.writeSecret(GATEWAY_API_KEY_SECRET_REF, key + "\n");
    } catch (error) {
      throw new Error("Unable to write gateway API key secret. Check stateDir permissions and retry production init-key.");
    }
    changed = true;
  }

  const report = {
    changed,
    stateDir: deps.config?.stateDir || "",
    secretRef: GATEWAY_API_KEY_SECRET_REF,
    apiKeySource: changed ? "state_secret" : existingSource,
  };
  if (hasFlag(args, "--json")) {
    writeLine(stdout, json(report));
  } else {
    writeLine(stdout, [
      `changed\t${report.changed}`,
      `state_dir\t${report.stateDir}`,
      `secret_ref\t${report.secretRef}`,
      `api_key_source\t${report.apiKeySource}`,
      "",
    ].join("\n"));
  }
  return { exitCode: 0 };
}

async function handleProductionPreflight(args, deps, stdout) {
  const doctorReport = await buildDoctorReportForCli(deps);
  const report = buildProductionPreflightReport({ doctorReport, config: deps.config });
  if (hasFlag(args, "--json")) {
    writeLine(stdout, json(report));
  } else {
    writeLine(stdout, [
      `status\t${report.status}`,
      `gateway_api_key\t${report.checks.gatewayApiKey.status}`,
      `readiness_doctor\t${report.checks.readinessDoctor.status}`,
      `manual_cookie_mode\t${report.checks.manualCookieMode.status}\tmissing=${report.checks.manualCookieMode.missing.join(",")}\tbacklog_missing=${report.checks.manualCookieMode.backlogMissing.join(",")}`,
      `missing\t${report.missing.join(",")}`,
      "",
    ].join("\n"));
  }
  return { exitCode: report.status === "ready" ? 0 : 1 };
}

function probeAdviceFromVerification(result = {}) {
  const failedAction = (Array.isArray(result.actions) ? result.actions : [])
    .find((item) => item?.status === "failed" && item.error);
  return protocolProbeAdvice(failedAction?.error || result.account?.lastError || {});
}

async function handleAccountsProbe(args, deps, stdout, stderr) {
  const accountId = args[2];
  if (!accountId || accountId.startsWith("--")) {
    writeLine(stderr, "Missing account id for accounts probe.\n" + HELP);
    return { exitCode: 2 };
  }
  const readOnly = hasFlag(args, "--read-only");

  const result = await deps.accountVerifier.verifyAccount(accountId, { readOnly });
  const events = formatMaintenanceActionLog({
    accountId: result.account?.id || accountId,
    actions: result.actions,
    now: deps.now,
  });
  const advice = probeAdviceFromVerification(result);

  if (hasFlag(args, "--json")) {
    writeLine(stdout, json({
      readOnly: Boolean(result.readOnly || readOnly),
      changed: Boolean(result.changed),
      wouldChange: Boolean(result.wouldChange),
      account: result.account ? redactAccountForDisplay(result.account) : null,
      events,
      advice,
    }));
  } else {
    const lines = events.map((event) => `${event.accountId || "-"}	${event.action}	${event.status}`);
    lines.push(`read_only	${Boolean(result.readOnly || readOnly)}	would_change=${Boolean(result.wouldChange)}`);
    lines.push(`advice	${advice.category}	${advice.severity}`);
    writeLine(stdout, `${lines.join("\n")}\n`);
  }
  return { exitCode: 0 };
}

async function handleMaintain(args, deps, stdout) {
  const accounts = await loadAccounts(deps.accountStore);
  const maintainer = deps.benefitsMaintainer || createDefaultMaintainer(deps.now);
  const nextAccounts = [];
  const events = [];
  let changed = false;

  for (const account of accounts) {
    const result = await maintainer.maintainAccount(account);
    nextAccounts.push(result.account);
    changed = changed || Boolean(result.changed);
    events.push(...formatMaintenanceActionLog({
      accountId: account.id,
      actions: result.actions,
      now: deps.now,
    }));
  }

  if (changed) await deps.accountStore.saveAccounts(nextAccounts);

  if (hasFlag(args, "--json")) writeLine(stdout, json({ changed, events }));
  else {
    const lines = events.map((event) => `${event.accountId || "-"}\t${event.action}\t${event.status}`);
    writeLine(stdout, `${lines.join("\n")}\n`);
  }
  return { exitCode: 0 };
}

function fixtureTable(fixtures) {
  const lines = ["ref\tobservedAt\toperation\tstatus\taccountId\tadviceCategory"];
  for (const fixture of fixtures) {
    lines.push([
      fixture.ref || "",
      fixture.observedAt || "",
      fixture.operation || "",
      fixture.status || "unknown",
      fixture.accountId || "",
      fixture.adviceCategory || "",
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}


async function handleFixturesAudit(args, deps, stdout) {
  const rawScope = requiredValueAfter(args, "--scope");
  const scope = rawScope ? String(rawScope).trim() : "protocol";
  if (scope !== "protocol" && scope !== "auth" && scope !== "benefits" && scope !== "session" && scope !== "upstream") {
    throw new CliUsageError("Unsupported fixtures audit scope: " + scope + ".", { code: "UNSUPPORTED_FIXTURES_AUDIT_SCOPE" });
  }
  let fixtureReadFilter = {};
  if (scope === "session") fixtureReadFilter = { operations: ["verifySession", "recoverSession"] };
  else if (scope === "auth") fixtureReadFilter = { operations: ["sendVerificationCode", "submitRegistrationOrLogin"] };
  else if (scope === "benefits") fixtureReadFilter = { operations: BENEFITS_AUDIT_OPERATIONS };
  else if (scope === "upstream") fixtureReadFilter = { operation: "sendMessage" };
  const fixtures = await readProtocolFixtureDetails(deps.protocolFixtureStore, fixtureReadFilter);
  const audit = buildProtocolFixtureAudit({ fixtures, now: deps.now, scope });
  if (hasFlag(args, "--json")) writeLine(stdout, json(audit));
  else if (scope === "auth") {
    writeLine(stdout, [
      "status	" + audit.status,
      "successful_sendVerificationCode_fixture	" + audit.coverage.authSendVerificationCode.status + "	" + audit.coverage.authSendVerificationCode.count,
      "successful_submitRegistrationOrLogin_fixture	" + audit.coverage.authSubmitRegistrationOrLogin.status + "	" + audit.coverage.authSubmitRegistrationOrLogin.count,
      "sendVerificationCode_transport_success	" + audit.counts.successfulSendVerificationCode,
      "sendVerificationCode_delivery_success	" + audit.counts.successfulSendVerificationCodeWithDeliverySignal,
      "submitRegistrationOrLogin_transport_success	" + audit.counts.successfulSubmitRegistrationOrLogin,
      "submitRegistrationOrLogin_session_material_success	" + audit.counts.successfulSubmitRegistrationOrLoginWithSessionMaterial,
      "missing	" + (Array.isArray(audit.missing) ? audit.missing.join(",") : ""),
      "",
    ].join("\n"));
  }
  else if (scope === "benefits") {
    writeLine(stdout, [
      "status	" + audit.status,
      "successful_daily_sign_in_fixture	" + audit.coverage.dailySignIn.status + "	" + audit.coverage.dailySignIn.count,
      "successful_pro_activity_fixture	" + audit.coverage.proActivitySuccess.status + "	" + audit.coverage.proActivitySuccess.count,
      "successful_reset_coupon_consumption_fixture	" + audit.coverage.resetCouponConsumption.status + "	" + audit.coverage.resetCouponConsumption.count,
      "successful_lottery_draw_fixture	" + audit.coverage.lotteryDrawSuccess.status + "	" + audit.coverage.lotteryDrawSuccess.count,
      "dailySignIn	" + audit.counts.dailySignIn,
      "participateActivity	" + audit.counts.participateActivity,
      "participateResetCouponActivity	" + audit.counts.participateResetCouponActivity,
      "consumeResetCoupon	" + audit.counts.consumeResetCoupon,
      "drawLottery	" + audit.counts.drawLottery,
      "successful_daily_sign_in	" + audit.counts.successfulDailySignIn,
      "successful_pro_activity	" + audit.counts.successfulProActivity,
      "successful_reset_coupon_consumption	" + audit.counts.successfulResetCouponConsumption,
      "successful_lottery_draw	" + audit.counts.successfulLotteryDraw,
      "missing	" + (Array.isArray(audit.missing) ? audit.missing.join(",") : ""),
      "",
    ].join("\n"));
  }
  else if (scope === "session") {
    const recoveryStrategy = audit.recoveryStrategy || {};
    const lifecycle = audit.lifecycle || {};
    writeLine(stdout, [
      "status	" + audit.status,
      "successful_verifySession_fixture	" + audit.coverage.successfulSessionVerify.status + "	" + audit.coverage.successfulSessionVerify.count,
      "expired_verifySession_fixture	" + audit.coverage.expiredSessionSignal.status + "	" + audit.coverage.expiredSessionSignal.count,
      "session_missing	" + audit.counts.sessionMissing,
      "session_lifecycle	last_successful_at=" + (lifecycle.lastSuccessfulAt || "") + "	last_expired_at=" + (lifecycle.lastExpiredAt || "") + "	observed_window_ms=" + (Number.isFinite(lifecycle.observedWindowMs) ? lifecycle.observedWindowMs : ""),
      "manual_cookie_mode	" + (audit.manualCookieOperations?.status || "") + "	mode=" + (audit.manualCookieOperations?.mode || "") + "	expired_session_action=" + (audit.manualCookieOperations?.expiredSessionAction || "") + "	automated_refresh_required=" + Boolean(audit.manualCookieOperations?.automatedRefreshRequired) + "	release_blocking_missing=" + (Array.isArray(audit.manualCookieOperations?.blockingMissing) ? audit.manualCookieOperations.blockingMissing.join(",") : "") + "	backlog_missing=" + (Array.isArray(audit.manualCookieOperations?.backlogMissing) ? audit.manualCookieOperations.backlogMissing.join(",") : ""),
      "recovery_strategy	" + (recoveryStrategy.status || "") + "	" + (recoveryStrategy.current || "") + "	" + (recoveryStrategy.automatedRefresh || ""),
      "recovery_strategy_rejected	" + audit.counts.rejectedRecoveryStrategyEvidence,
      "missing	" + (Array.isArray(audit.missing) ? audit.missing.join(",") : ""),
      "",
    ].join("\n"));
  }
  else if (scope === "upstream") {
    writeLine(stdout, [
      "status	" + audit.status,
      "real_upstream_error_frame_fixture	" + audit.coverage.upstreamErrorFrame.status + "	" + audit.coverage.upstreamErrorFrame.count,
      "real_upstream_cancellation_fixture	" + audit.coverage.upstreamCancellation.status + "	" + audit.coverage.upstreamCancellation.count,
      "real_upstream_backpressure_fixture	" + audit.coverage.upstreamBackpressure.status + "	" + audit.coverage.upstreamBackpressure.count,
      "real_upstream	" + audit.counts.realUpstream,
      "upstream_error_frame	" + audit.counts.upstreamErrorFrame,
      "upstream_cancellation	" + audit.counts.upstreamCancellation,
      "upstream_backpressure	" + audit.counts.upstreamBackpressure,
      "stream_evidence_not_captured	" + audit.counts.streamEvidenceNotCaptured,
      "missing	" + (Array.isArray(audit.missing) ? audit.missing.join(",") : ""),
      "",
    ].join("\n"));
  }
  else {
    writeLine(stdout, [
      "status	" + audit.status,
      "successful_verifySession_fixture	" + audit.coverage.sessionVerify.status + "	" + audit.coverage.sessionVerify.count,
      "successful_sendMessage_fixture	" + audit.coverage.successfulSendMessage.status + "	" + audit.coverage.successfulSendMessage.count,
      "streaming_text_fixture	" + audit.coverage.streamingText.status + "	" + audit.coverage.streamingText.count,
      "tool_call_fixture	" + audit.coverage.toolCall.status + "	" + audit.coverage.toolCall.count,
      "forbidden_403_fixture	" + audit.coverage.forbidden403.status + "	" + audit.coverage.forbidden403.count,
      "",
    ].join("\n"));
  }
  return { exitCode: 0 };
}

async function handleFixturesList(args, deps, stdout) {
  const fixtures = (await deps.protocolFixtureStore.listFixtures()).map((fixture) => sanitizeProtocolProbeFixture(fixture));
  if (hasFlag(args, "--json")) writeLine(stdout, json({ fixtures }));
  else writeLine(stdout, fixtureTable(fixtures));
  return { exitCode: 0 };
}

async function handleFixturesShow(args, deps, stdout, stderr) {
  const ref = args[2];
  if (!ref || ref.startsWith("--")) {
    writeLine(stderr, "Missing fixture ref for fixtures show.\n" + HELP);
    return { exitCode: 2 };
  }
  const fixture = sanitizeProtocolProbeFixture(await deps.protocolFixtureStore.readFixture(ref));
  writeLine(stdout, json(fixture));
  return { exitCode: 0 };
}

async function handleProbeTemplate(args, stdout) {
  const operation = requiredValueAfter(args, "--operation") || "verifySession";
  const streamEvidence = parseStreamEvidenceTemplateOptions(args, operation);
  writeLine(stdout, json(buildProbeInputTemplate(operation, { streamEvidence })));
  return { exitCode: 0 };
}

async function handleProbeValidate(args, deps, stdout) {
  const operation = valueAfter(args, "--operation") || "verifySession";
  const input = await readProbeInput(args);
  validateProbeInputForOperation(input, operation);
  if (hasFlag(args, "--require-confirmed-side-effect")) {
    assertConfirmedSideEffectInput(input, operation);
  }
  const writeFixture = hasFlag(args, "--write-fixture");
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  let fixtureRef = null;
  let fixtureSummary = null;
  if (writeFixture) {
    if (!OFFLINE_EVIDENCE_PROBE_OPERATIONS.has(cleanOperation)) {
      throw new CliUsageError(
        "Probe validate --write-fixture only supports offline evidence operations.",
        { code: "OFFLINE_EVIDENCE_WRITE_ONLY" },
      );
    }
    if (!deps.protocolFixtureStore || typeof deps.protocolFixtureStore.writeFixture !== "function") {
      throw new CliUsageError("Protocol fixture store is required for --write-fixture.", { code: "FIXTURE_STORE_REQUIRED" });
    }
    const fixture = buildOfflineEvidenceFixture({ operation: cleanOperation, input, now: deps.now });
    fixtureRef = await deps.protocolFixtureStore.writeFixture(fixture);
    fixtureSummary = summarizeOfflineEvidenceFixture(fixture);
  }
  const preview = buildProbeInputValidationPreview({ operation, input });
  const output = {
    ...preview,
    ...(fixtureRef ? { fixtureRef, fixture: fixtureSummary } : {}),
  };
  if (hasFlag(args, "--json")) writeLine(stdout, json(output));
  else {
    writeLine(stdout, [
      "status	" + output.status,
      "operation	" + output.operation,
      "side_effect	" + output.sideEffect,
      "confirm_side_effect	" + (output.confirmSideEffect ?? ""),
      ...(fixtureRef ? ["fixture_ref	" + fixtureRef] : []),
      "",
    ].join("\n"));
  }
  return { exitCode: 0 };
}

async function handleProbeProtocol(args, deps, stdout, stderr) {
  const accountId = valueAfter(args, "--account") || valueAfter(args, "--account-id");
  if (!accountId || accountId.startsWith("--")) {
    writeLine(stderr, "Missing account id for probe protocol.\n" + HELP);
    return { exitCode: 2 };
  }
  const operation = valueAfter(args, "--operation") || "verifySession";
  const input = await readProbeInput(args);
  validateProbeInputForOperation(input, operation);
  assertProbeInputReadyForProtocol(input, operation);
  assertProtocolProbeOperationDispatchable(operation);
  const probeRequest = {
    accountId,
    operation,
    writeFixture: hasFlag(args, "--write-fixture"),
  };
  if (input !== undefined) probeRequest.input = input;
  const result = await deps.protocolProbeRunner.probeAccount(probeRequest);
  const safeResult = sanitizeProtocolProbeFixture(result);
  if (hasFlag(args, "--json")) writeLine(stdout, json(safeResult));
  else writeLine(stdout, `${safeResult.status}	${operation}	${safeResult.advice?.category || "unknown"}	${safeResult.fixtureRef || ""}
`);
  return { exitCode: 0 };
}

async function handleProbeAdvice(args, stdout) {
  const statusValue = valueAfter(args, "--status");
  const advice = protocolProbeAdvice({
    category: valueAfter(args, "--category") || undefined,
    status: statusValue ? Number(statusValue) : undefined,
    code: valueAfter(args, "--code") || undefined,
    message: valueAfter(args, "--message") || undefined,
  });
  if (hasFlag(args, "--json")) writeLine(stdout, json(advice));
  else writeLine(stdout, `${advice.category}\t${advice.severity}\t${advice.recommendation}\n`);
  return { exitCode: 0 };
}

export async function runProtocolPoolCli(argv = [], options = {}) {
  const stdout = options.stdout || ((line) => process.stdout.write(line));
  const stderr = options.stderr || ((line) => process.stderr.write(line));
  const deps = {
    ...createProtocolPoolCliDependencies(options),
    ...options,
  };
  const args = Array.isArray(argv) ? argv : [];
  const [command, subcommand] = args;

  try {
    if (command === "accounts" && subcommand === "list") {
      return await handleAccountsList(args, deps, stdout);
    }
    if (command === "accounts" && subcommand === "import-session") {
      return await handleAccountsImportSession(args, deps, stdout);
    }
    if (command === "accounts" && subcommand === "probe") {
      return await handleAccountsProbe(args, deps, stdout, stderr);
    }
    if (command === "health") {
      return await handleHealth(args, deps, stdout);
    }
    if (command === "serve" || command === "start") {
      return await handleServe(args, deps, stdout);
    }
    if (command === "smoke" && subcommand === "gateway") {
      return await handleSmokeGateway(args, deps, stdout);
    }
    if (command === "readiness" && subcommand === "mark") {
      return await handleReadinessMark(args, deps, stdout);
    }
    if (command === "readiness" && subcommand === "doctor") {
      return await handleReadinessDoctor(args, deps, stdout);
    }
    if (command === "readiness") {
      return await handleReadiness(args, deps, stdout);
    }
    if (command === "production" && subcommand === "preflight") {
      return await handleProductionPreflight(args, deps, stdout);
    }
    if (command === "production" && subcommand === "init-key") {
      return await handleProductionInitKey(args, deps, stdout);
    }
    if (command === "maintain") {
      return await handleMaintain(args, deps, stdout);
    }
    if (command === "fixtures" && subcommand === "list") {
      return await handleFixturesList(args, deps, stdout);
    }
    if (command === "fixtures" && subcommand === "audit") {
      return await handleFixturesAudit(args, deps, stdout);
    }
    if (command === "fixtures" && subcommand === "show") {
      return await handleFixturesShow(args, deps, stdout, stderr);
    }
    if (command === "probe" && subcommand === "advice") {
      return await handleProbeAdvice(args, stdout);
    }
    if (command === "probe" && subcommand === "template") {
      return await handleProbeTemplate(args, stdout);
    }
    if (command === "probe" && subcommand === "validate") {
      return await handleProbeValidate(args, deps, stdout);
    }
    if (command === "probe" && subcommand === "protocol") {
      return await handleProbeProtocol(args, deps, stdout, stderr);
    }
    if (command === "--help" || command === "-h" || !command) {
      writeLine(stdout, HELP);
      return { exitCode: 0 };
    }
    writeLine(stderr, HELP);
    return { exitCode: 2 };
  } catch (error) {
    writeLine(stderr, `${redactErrorMessage(error)}\n`);
    return { exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1 };
  }
}
