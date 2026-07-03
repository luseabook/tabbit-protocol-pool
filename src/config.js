import path from "node:path";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 50124;
const DEFAULT_API_KEY = "sk-tabbit-local";
const DEFAULT_RETRY_LIMIT = 1;
const DEFAULT_TOOL_LOOP_MODE = "client_executes_tools_first";
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

function normalizeToolLoopMode(value) {
  const raw = cleanString(value);
  if (!raw) return DEFAULT_TOOL_LOOP_MODE;
  if (!TOOL_LOOP_MODES.has(raw)) {
    throw new Error(`Invalid tool loop mode: ${value}`);
  }
  return raw;
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

function loadProtocolConfig(env) {
  const baseUrl = optionalString(env.TABBIT_POOL_PROTOCOL_BASE_URL);
  const signKeyPath = optionalString(env.TABBIT_POOL_PROTOCOL_SIGN_KEY_PATH);
  const modelCatalogPath = optionalString(env.TABBIT_POOL_PROTOCOL_MODEL_CATALOG_PATH);
  const modelCatalogScene = optionalString(env.TABBIT_POOL_PROTOCOL_MODEL_CATALOG_SCENE) || "chat";
  const sendPath = optionalString(env.TABBIT_POOL_PROTOCOL_SEND_PATH);
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
  const activityParticipatePath = optionalString(env.TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH);
  const usageResetCouponSkuPath = optionalString(env.TABBIT_POOL_PROTOCOL_USAGE_RESET_COUPON_SKU_PATH);
  const lotteryAvailableChancesPath = optionalString(env.TABBIT_POOL_PROTOCOL_LOTTERY_AVAILABLE_CHANCES_PATH);
  const lotteryActiveMainPoolsPath = optionalString(env.TABBIT_POOL_PROTOCOL_LOTTERY_ACTIVE_MAIN_POOLS_PATH);
  const lotteryChanceRecordsPath = optionalString(env.TABBIT_POOL_PROTOCOL_LOTTERY_CHANCE_RECORDS_PATH);
  const lotteryDrawPath = optionalString(env.TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH);
  const sessionVerifyPath = optionalString(env.TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH);
  const sessionVerifyMethod = cleanString(env.TABBIT_POOL_PROTOCOL_SESSION_VERIFY_METHOD).toUpperCase() || "GET";
  const reqCtx = optionalString(env.TABBIT_POOL_PROTOCOL_REQ_CTX);
  const defaultChatSessionId = optionalString(env.TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID);
  const enabledByFlag = normalizeBooleanFlag(env.TABBIT_POOL_PROTOCOL_ENABLED, false, "protocol enabled");
  const enabledByEndpoint = Boolean(
    signKeyPath
    || modelCatalogPath
    || sendPath
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
    || activityParticipatePath
    || usageResetCouponSkuPath
    || lotteryAvailableChancesPath
    || lotteryActiveMainPoolsPath
    || lotteryChanceRecordsPath
    || lotteryDrawPath
    || sessionVerifyPath,
  );

  return {
    enabled: enabledByFlag || enabledByEndpoint,
    baseUrl,
    signKeyPath,
    modelCatalogPath,
    modelCatalogScene,
    sendPath,
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
  const yydsMailApiKey = cleanString(env.YYDS_MAIL_API_KEY) || null;
  const stripClientTools = normalizeBooleanFlag(env.TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS, false, "compat strip client tools");
  const toolLoopMode = normalizeToolLoopMode(env.TABBIT_POOL_TOOL_LOOP_MODE);

  return {
    host: cleanString(env.TABBIT_POOL_HOST) || DEFAULT_HOST,
    port: normalizePort(env.TABBIT_POOL_PORT, DEFAULT_PORT),
    apiKey: cleanString(env.TABBIT_POOL_API_KEY) || DEFAULT_API_KEY,
    stateDir: cleanString(env.TABBIT_POOL_STATE_DIR) || defaultStateDir(env, platform),
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
    },
    protocol: loadProtocolConfig(env),
  };
}
