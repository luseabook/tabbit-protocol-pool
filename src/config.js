import fs from "node:fs";
import path from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 50124;
const DEFAULT_API_KEY = "sk-tabbit-local";
const DEFAULT_GATEWAY_API_KEY_REF = path.join("secrets", "gateway-api-key.txt");
const DEFAULT_RETRY_LIMIT = 1;
const DEFAULT_TOOL_LOOP_MODE = "client_executes_tools_first";
const DEFAULT_LOCAL_TOOL_MAX_ROUNDS = 4;
const DEFAULT_LOCAL_TOOL_TIMEOUT_MS = 0;
const DEFAULT_LOCAL_TOOL_MAX_RESULT_CHARS = 16_000;
const DEFAULT_PROTOCOL_BASE_URL = "https://web.tabbit.ai";
const DEFAULT_PROTOCOL_SIGN_KEY_PATH = "/chat/sign-key";
const DEFAULT_PROTOCOL_MODEL_CATALOG_PATH = "/proxy/v1/model_config/models";
const DEFAULT_PROTOCOL_SEND_PATH = "/api/v1/chat/completion";
const DEFAULT_PROTOCOL_SESSION_VERIFY_PATH = "/api/v0/user/base-info";
const DEFAULT_PROTOCOL_REQ_CTX = "MS4zLjI2KDEwMTAzMDI2KQ==";
const TOOL_LOOP_MODES = new Set([
  DEFAULT_TOOL_LOOP_MODE,
  "disabled",
  "local_executes_tools",
]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalString(value) {
  return cleanString(value) || null;
}

function normalizeBooleanFlag(value, fallback, label) {
  const raw = cleanString(value).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Invalid ${label}: ${value}`);
}

export function normalizePort(value, fallback = DEFAULT_PORT) {
  const raw = cleanString(value);
  if (!raw) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid port: ${value}`);
  }

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

function normalizeNonNegativeInteger(value, fallback, label) {
  const raw = cleanString(value);
  if (!raw) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function normalizePositiveInteger(value, fallback, label) {
  const raw = cleanString(value);
  if (!raw) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

function normalizeToolLoopMode(value) {
  const raw = cleanString(value);
  if (!raw) return DEFAULT_TOOL_LOOP_MODE;
  if (!TOOL_LOOP_MODES.has(raw)) {
    throw new Error(`Invalid tool loop mode: ${value}`);
  }
  return raw;
}

function normalizeCommaSeparatedList(value) {
  const seen = new Set();
  const result = [];
  for (const item of cleanString(value).split(",")) {
    const clean = cleanString(item);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

function loadLocalToolLoopConfig(env) {
  return {
    allowedToolNames: normalizeCommaSeparatedList(env.TABBIT_POOL_LOCAL_TOOL_ALLOWLIST),
    maxRounds: normalizePositiveInteger(
      env.TABBIT_POOL_LOCAL_TOOL_MAX_ROUNDS,
      DEFAULT_LOCAL_TOOL_MAX_ROUNDS,
      "local tool max rounds",
    ),
    toolTimeoutMs: normalizeNonNegativeInteger(
      env.TABBIT_POOL_LOCAL_TOOL_TIMEOUT_MS,
      DEFAULT_LOCAL_TOOL_TIMEOUT_MS,
      "local tool timeout",
    ),
    maxToolResultChars: normalizePositiveInteger(
      env.TABBIT_POOL_LOCAL_TOOL_MAX_RESULT_CHARS,
      DEFAULT_LOCAL_TOOL_MAX_RESULT_CHARS,
      "local tool max result chars",
    ),
  };
}

function defaultStateDir(env, platform) {
  const home = cleanString(env.HOME || env.USERPROFILE) || ".";
  if (platform === "win32") {
    const localAppData = cleanString(env.LOCALAPPDATA);
    return path.join(localAppData || home, "tabbit-protocol-pool");
  }

  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "tabbit-protocol-pool");
  }

  const xdgDataHome = cleanString(env.XDG_DATA_HOME);
  return path.join(xdgDataHome || path.join(home, ".local", "share"), "tabbit-protocol-pool");
}

function safeExists(fsImpl, target) {
  try {
    return Boolean(fsImpl?.existsSync?.(target));
  } catch {
    return false;
  }
}

function safeReadText(fsImpl, target) {
  try {
    return fsImpl?.readFileSync?.(target, "utf8") || "";
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function uniqueCleanStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const clean = cleanString(value);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

function defaultProductionStateDirCandidates(env, platform, options = {}) {
  if (Array.isArray(options.productionStateDirCandidates)) {
    return uniqueCleanStrings(options.productionStateDirCandidates);
  }

  const cwd = cleanString(options.cwd) || cleanString(env.PWD) || cleanString(globalThis.process?.cwd?.()) || ".";
  const home = cleanString(env.HOME || env.USERPROFILE);
  const candidates = [
    path.resolve(cwd, "..", "tabbit-live-state"),
    path.resolve(cwd, "..", "tabbit-protocol-pool-state"),
  ];

  if (home) {
    candidates.push(path.join(home, "tabbit-protocol-pool-state"));
  }
  if (platform === "win32") {
    const root = path.parse(path.resolve(cwd)).root;
    if (root) candidates.push(path.join(root, "tabbit-protocol-pool-state"));
  } else {
    candidates.push("/var/lib/tabbit-protocol-pool");
  }

  return uniqueCleanStrings(candidates);
}

function isCompleteProductionStateDir(stateDir, fsImpl) {
  return [
    path.join(stateDir, "accounts.json"),
    path.join(stateDir, "readiness.json"),
    path.join(stateDir, "fixtures", "protocol-probes"),
    path.join(stateDir, "secrets"),
  ].every((target) => safeExists(fsImpl, target));
}

function discoverProductionStateDir(env, platform, options, fsImpl) {
  for (const candidate of defaultProductionStateDirCandidates(env, platform, options)) {
    if (isCompleteProductionStateDir(candidate, fsImpl)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function readGatewayApiKeyFromStateDir(stateDir, fsImpl) {
  const apiKey = cleanString(safeReadText(fsImpl, path.join(stateDir, DEFAULT_GATEWAY_API_KEY_REF)));
  return apiKey && apiKey !== DEFAULT_API_KEY ? apiKey : "";
}

function loadProtocolConfig(env, options = {}) {
  const enabledByFlag = normalizeBooleanFlag(env.TABBIT_POOL_PROTOCOL_ENABLED, false, "protocol enabled");
  const usePublicDefaults = enabledByFlag || Boolean(options.usePublicDefaults);
  const protocolDefault = (value, fallback) => value || (usePublicDefaults ? fallback : null);
  const baseUrl = protocolDefault(optionalString(env.TABBIT_POOL_PROTOCOL_BASE_URL), DEFAULT_PROTOCOL_BASE_URL);
  const signKeyPath = protocolDefault(optionalString(env.TABBIT_POOL_PROTOCOL_SIGN_KEY_PATH), DEFAULT_PROTOCOL_SIGN_KEY_PATH);
  const modelCatalogPath = protocolDefault(optionalString(env.TABBIT_POOL_PROTOCOL_MODEL_CATALOG_PATH), DEFAULT_PROTOCOL_MODEL_CATALOG_PATH);
  const modelCatalogScene = optionalString(env.TABBIT_POOL_PROTOCOL_MODEL_CATALOG_SCENE) || "chat";
  const sendPath = protocolDefault(optionalString(env.TABBIT_POOL_PROTOCOL_SEND_PATH), DEFAULT_PROTOCOL_SEND_PATH);
  const authSendCodePath = optionalString(env.TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH);
  const authSendCodeMethod = cleanString(env.TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_METHOD).toUpperCase() || "POST";
  const authSubmitCodePath = optionalString(env.TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH);
  const authSubmitCodeMethod = cleanString(env.TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_METHOD).toUpperCase() || "POST";
  const attachmentUploadPath = optionalString(env.TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH);
  const attachmentCompleteUploadPath = optionalString(env.TABBIT_POOL_PROTOCOL_ATTACHMENT_COMPLETE_UPLOAD_PATH);
  const quotaUsagePath = optionalString(env.TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH);
  const activityLotteryPath = optionalString(env.TABBIT_POOL_PROTOCOL_ACTIVITY_LOTTERY_PATH);
  const newbieExplorationPath = optionalString(env.TABBIT_POOL_PROTOCOL_NEWBIE_EXPLORATION_PATH);
  const placementResourcesPath = optionalString(env.TABBIT_POOL_PROTOCOL_PLACEMENT_RESOURCES_PATH);
  const rewardCardRecordsPath = optionalString(env.TABBIT_POOL_PROTOCOL_REWARD_CARD_RECORDS_PATH);
  const lotteryHitRecordsPath = optionalString(env.TABBIT_POOL_PROTOCOL_LOTTERY_HIT_RECORDS_PATH);
  const signInStatusPath = optionalString(env.TABBIT_POOL_PROTOCOL_SIGN_IN_STATUS_PATH);
  const signInPath = optionalString(env.TABBIT_POOL_PROTOCOL_SIGN_IN_PATH);
  const benefitCouponListPath = optionalString(env.TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_LIST_PATH);
  const benefitCouponUsePath = optionalString(env.TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_USE_PATH);
  const activityParticipatePath = optionalString(env.TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH);
  const usageResetCouponSkuPath = optionalString(env.TABBIT_POOL_PROTOCOL_USAGE_RESET_COUPON_SKU_PATH);
  const lotteryAvailableChancesPath = optionalString(env.TABBIT_POOL_PROTOCOL_LOTTERY_AVAILABLE_CHANCES_PATH);
  const lotteryActiveMainPoolsPath = optionalString(env.TABBIT_POOL_PROTOCOL_LOTTERY_ACTIVE_MAIN_POOLS_PATH);
  const lotteryChanceRecordsPath = optionalString(env.TABBIT_POOL_PROTOCOL_LOTTERY_CHANCE_RECORDS_PATH);
  const lotteryDrawPath = optionalString(env.TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH);
  const sessionVerifyPath = protocolDefault(optionalString(env.TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH), DEFAULT_PROTOCOL_SESSION_VERIFY_PATH);
  const sessionVerifyMethod = cleanString(env.TABBIT_POOL_PROTOCOL_SESSION_VERIFY_METHOD).toUpperCase() || "GET";
  const reqCtx = protocolDefault(optionalString(env.TABBIT_POOL_PROTOCOL_REQ_CTX), DEFAULT_PROTOCOL_REQ_CTX);
  const defaultChatSessionId = optionalString(env.TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID);
  const enabledByEndpoint = Boolean(
    signKeyPath
    || modelCatalogPath
    || sendPath
    || authSendCodePath
    || authSubmitCodePath
    || attachmentUploadPath
    || attachmentCompleteUploadPath
    || quotaUsagePath
    || activityLotteryPath
    || newbieExplorationPath
    || placementResourcesPath
    || rewardCardRecordsPath
    || lotteryHitRecordsPath
    || signInStatusPath
    || signInPath
    || benefitCouponListPath
    || benefitCouponUsePath
    || activityParticipatePath
    || usageResetCouponSkuPath
    || lotteryAvailableChancesPath
    || lotteryActiveMainPoolsPath
    || lotteryChanceRecordsPath
    || lotteryDrawPath
    || sessionVerifyPath,
  );

  return {
    enabled: enabledByFlag || enabledByEndpoint || Boolean(options.usePublicDefaults),
    baseUrl,
    signKeyPath,
    modelCatalogPath,
    modelCatalogScene,
    sendPath,
    authSendCodePath,
    authSendCodeMethod,
    authSubmitCodePath,
    authSubmitCodeMethod,
    attachmentUploadPath,
    attachmentCompleteUploadPath,
    quotaUsagePath,
    activityLotteryPath,
    newbieExplorationPath,
    placementResourcesPath,
    rewardCardRecordsPath,
    lotteryHitRecordsPath,
    signInStatusPath,
    signInPath,
    benefitCouponListPath,
    benefitCouponUsePath,
    activityParticipatePath,
    usageResetCouponSkuPath,
    lotteryAvailableChancesPath,
    lotteryActiveMainPoolsPath,
    lotteryChanceRecordsPath,
    lotteryDrawPath,
    sessionVerifyPath,
    sessionVerifyMethod,
    reqCtx,
    defaultChatSessionId,
  };
}

export function loadConfig(env = globalThis.process?.env ?? {}, options = {}) {
  const platform = options.platform || globalThis.process?.platform || "linux";
  const fsImpl = options.fs || fs;
  const yydsMailApiKey = cleanString(env.YYDS_MAIL_API_KEY) || null;
  const stripClientTools = normalizeBooleanFlag(env.TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS, false, "compat strip client tools");
  const toolLoopMode = normalizeToolLoopMode(env.TABBIT_POOL_TOOL_LOOP_MODE);
  const explicitStateDir = cleanString(env.TABBIT_POOL_STATE_DIR);
  const discoveredStateDir = explicitStateDir ? null : discoverProductionStateDir(env, platform, options, fsImpl);
  const stateDir = explicitStateDir || discoveredStateDir || defaultStateDir(env, platform);
  const envApiKey = cleanString(env.TABBIT_POOL_API_KEY);
  const stateApiKey = envApiKey ? "" : readGatewayApiKeyFromStateDir(stateDir, fsImpl);

  return {
    host: cleanString(env.TABBIT_POOL_HOST) || DEFAULT_HOST,
    port: normalizePort(env.TABBIT_POOL_PORT, DEFAULT_PORT),
    apiKey: envApiKey || stateApiKey || DEFAULT_API_KEY,
    stateDir,
    protocolFixtureDir: optionalString(env.TABBIT_POOL_PROTOCOL_FIXTURE_DIR),
    retryLimit: normalizeNonNegativeInteger(
      env.TABBIT_POOL_RETRY_LIMIT,
      DEFAULT_RETRY_LIMIT,
      "retry limit",
    ),
    logLevel: cleanString(env.TABBIT_POOL_LOG_LEVEL) || "info",
    yydsMailApiKey,
    mail: {
      enabled: Boolean(yydsMailApiKey),
      baseUrl: cleanString(env.YYDS_MAIL_BASE_URL) || "https://maliapi.215.im/v1",
    },
    compat: {
      stripClientTools,
      toolLoopMode,
      localToolLoop: loadLocalToolLoopConfig(env),
    },
    productionState: {
      source: explicitStateDir ? "explicit_env" : (discoveredStateDir ? "auto_discovered" : "default_local"),
      apiKeySource: envApiKey ? "env" : (stateApiKey ? "state_secret" : "default"),
    },
    protocol: loadProtocolConfig(env, { usePublicDefaults: Boolean(discoveredStateDir) }),
  };
}
