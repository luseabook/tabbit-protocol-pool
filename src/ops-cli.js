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
import { createProtocolPoolGateway } from "./protocol-pool-gateway.js";
import {
  buildCalibrationReadinessSnapshot,
  buildHealthSnapshot,
  buildProtocolFixtureAudit,
  formatMaintenanceActionLog,
  protocolProbeAdvice,
  redactAccountForDisplay,
  redactAccountsForDisplay,
} from "./observability.js";

const HELP = `Usage:
  tabbit-pool accounts list [--json]
  tabbit-pool accounts import-session [--id <id>] [--email <email>] [--cookie-header <text> | --session <text> | --cookie-file <path> | --session-file <path>] [--json]
  tabbit-pool accounts probe <id> [--json]
  tabbit-pool health [--json]
  tabbit-pool readiness [--json]
  tabbit-pool readiness mark [--codex-verified] [--claude-verified] [--json]
  tabbit-pool serve [--host <host>] [--port <port>] [--json]
  tabbit-pool start [--host <host>] [--port <port>] [--json]
  tabbit-pool smoke gateway [--base-url <url>] [--api-key <key>] [--model <model>] [--json]
  tabbit-pool maintain [--json]
  tabbit-pool fixtures list [--json]
  tabbit-pool fixtures audit [--json]
  tabbit-pool fixtures show <ref> [--json]
  tabbit-pool probe advice [--category <category>] [--status <status>] [--code <code>] [--message <text>] [--json]
  tabbit-pool probe template [--operation <name>] [--json]
  tabbit-pool probe protocol --account <id> [--operation <name>] [--input-json <json> | --input-file <path>] [--write-fixture] [--json]
`;

function writeLine(writer, value) {
  writer(String(value));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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

const PROBE_INPUT_TEMPLATES = {
  verifySession: {},
  sendMessage: {
    model: "tabbit/priority",
    messages: [{ role: "user", content: "ping" }],
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
  uploadAttachment: {
    attachment: {
      filename: "probe.txt",
      mimeType: "text/plain",
      data: "base64-probe-payload",
    },
  },
};

const PROBE_TEMPLATE_OPERATIONS = Object.keys(PROBE_INPUT_TEMPLATES);

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildProbeInputTemplate(operation) {
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  const template = PROBE_INPUT_TEMPLATES[cleanOperation];
  if (!template) {
    throw new CliUsageError(
      "Unsupported probe template operation. Supported operations: " + PROBE_TEMPLATE_OPERATIONS.join(", ") + ".",
      { code: "UNSUPPORTED_PROBE_TEMPLATE_OPERATION" },
    );
  }
  return cloneJsonObject(template);
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

function validateProbeInputForOperation(input, operation) {
  if (input === undefined) return;
  const cleanOperation = String(operation || "verifySession").trim() || "verifySession";
  if (cleanOperation === "sendMessage") {
    if (hasOwn(input, "model") && !nonEmptyString(input.model)) {
      throw new CliUsageError("Probe input for sendMessage.model must be a non-empty string.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
    if (hasOwn(input, "messages") && (!Array.isArray(input.messages) || input.messages.length === 0)) {
      throw new CliUsageError("Probe input for sendMessage.messages must be a non-empty array.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
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
    if (hasOwn(input, "body") && !plainObject(input.body)) {
      throw new CliUsageError("Probe input for " + cleanOperation + ".body must be an object.", { code: "INVALID_PROBE_INPUT_SCHEMA" });
    }
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
  for (const key of ["baseUrl", "signKeyPath", "modelCatalogPath", "modelCatalogScene", "sendPath", "attachmentUploadPath", "attachmentCompleteUploadPath", "quotaUsagePath", "activityLotteryPath", "newbieExplorationPath", "placementResourcesPath", "rewardCardRecordsPath", "lotteryHitRecordsPath", "signInStatusPath", "signInPath", "benefitCouponListPath", "activityParticipatePath", "usageResetCouponSkuPath", "lotteryAvailableChancesPath", "lotteryActiveMainPoolsPath", "lotteryChanceRecordsPath", "lotteryDrawPath", "sessionVerifyPath", "sessionVerifyMethod", "reqCtx", "defaultChatSessionId"]) {
    if (protocol[key]) options[key] = protocol[key];
  }
  return options;
}

function createConfiguredProtocolClientFactory(config, { fetch: fetchImpl, now } = {}) {
  if (!config.protocol?.enabled) return null;
  const protocolClientOptions = configuredProtocolClientOptions(config.protocol);
  return () => new ProtocolTabbitClient({
    ...protocolClientOptions,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    now: () => protocolNow(now),
  });
}

function createConfiguredAccountProtocolClient(protocolClientFactory) {
  if (typeof protocolClientFactory !== "function") return {};
  return {
    async verifySession(input = {}) {
      const client = protocolClientFactory(input.account || {});
      return await client.verifySession(input);
    },
  };
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
  if (id) input.id = id;
  if (email) input.email = email;
  if (userId) input.userId = userId;
  if (accessTier) input.accessTier = accessTier;
  if (cookieJarRef) input.cookieJarRef = cookieJarRef;
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
  const protocolFixtureStore = options.protocolFixtureStore || new FileProtocolFixtureStore({ stateDir: config.stateDir, now });
  const configuredProtocolClientFactory = createConfiguredProtocolClientFactory(config, { fetch: options.fetch, now });
  const protocolProbeClientFactory = hasOwn(options, "protocolProbeClientFactory")
    ? options.protocolProbeClientFactory
    : configuredProtocolClientFactory;
  const accountProtocolClient = hasOwn(options, "protocolClient")
    ? options.protocolClient
    : createConfiguredAccountProtocolClient(configuredProtocolClientFactory);
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
    verifyAccount(accountId) {
      const provisioner = new AccountProvisioner({
        accountStore,
        secretStore,
        protocolClient: accountProtocolClient || {},
        now: nowDate,
      });
      return provisioner.verifyAccount(accountId);
    },
  };

  return {
    config,
    accountStore,
    secretStore,
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

async function readProtocolFixtureDetails(protocolFixtureStore) {
  const listedFixtures = protocolFixtureStore && typeof protocolFixtureStore.listFixtures === "function"
    ? await protocolFixtureStore.listFixtures()
    : [];
  if (!protocolFixtureStore || typeof protocolFixtureStore.readFixture !== "function") return listedFixtures;
  return await Promise.all((Array.isArray(listedFixtures) ? listedFixtures : []).map(async (fixture) => {
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

  const result = await deps.accountVerifier.verifyAccount(accountId);
  const events = formatMaintenanceActionLog({
    accountId: result.account?.id || accountId,
    actions: result.actions,
    now: deps.now,
  });
  const advice = probeAdviceFromVerification(result);

  if (hasFlag(args, "--json")) {
    writeLine(stdout, json({
      changed: Boolean(result.changed),
      account: result.account ? redactAccountForDisplay(result.account) : null,
      events,
      advice,
    }));
  } else {
    const lines = events.map((event) => `${event.accountId || "-"}	${event.action}	${event.status}`);
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
  const fixtures = await readProtocolFixtureDetails(deps.protocolFixtureStore);
  const audit = buildProtocolFixtureAudit({ fixtures, now: deps.now });
  if (hasFlag(args, "--json")) writeLine(stdout, json(audit));
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
  writeLine(stdout, json(buildProbeInputTemplate(operation)));
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
  const probeRequest = {
    accountId,
    operation,
    writeFixture: hasFlag(args, "--write-fixture"),
  };
  if (input !== undefined) probeRequest.input = input;
  const result = await deps.protocolProbeRunner.probeAccount(probeRequest);
  if (hasFlag(args, "--json")) writeLine(stdout, json(result));
  else writeLine(stdout, `${result.status}	${operation}	${result.advice?.category || "unknown"}	${result.fixtureRef || ""}
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
    if (command === "readiness") {
      return await handleReadiness(args, deps, stdout);
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
