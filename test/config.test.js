import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadConfig, normalizePort } from "../src/config.js";

function fakeSyncFs({ existing = [], files = {} } = {}) {
  const existingSet = new Set(existing.map((item) => path.resolve(item)));
  const fileMap = new Map(Object.entries(files).map(([key, value]) => [path.resolve(key), value]));
  return {
    existsSync(target) {
      return existingSet.has(path.resolve(target)) || fileMap.has(path.resolve(target));
    },
    readFileSync(target, encoding) {
      assert.equal(encoding, "utf8");
      const key = path.resolve(target);
      if (!fileMap.has(key)) {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
      return fileMap.get(key);
    },
  };
}

test("loadConfig returns safe local defaults", () => {
  const config = loadConfig({ LOCALAPPDATA: "C:/Users/A/AppData/Local" }, { platform: "win32", fs: fakeSyncFs() });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 50124);
  assert.equal(config.apiKey, "sk-tabbit-local");
  assert.equal(config.protocolFixtureDir, null);
  assert.equal(config.yydsMailApiKey, null);
  assert.deepEqual(config.admin, {
    username: null,
    password: null,
  });
  assert.equal(config.mail.enabled, false);
  assert.deepEqual(config.compat, {
    stripClientTools: false,
    toolLoopMode: "client_executes_tools_first",
    localToolLoop: {
      allowedToolNames: [],
      maxRounds: 4,
      toolTimeoutMs: 0,
      maxToolResultChars: 16_000,
    },
  });
  assert.deepEqual(config.protocol, {
    enabled: false,
    fetchTransport: "node",
    baseUrl: null,
    signKeyPath: null,
    modelCatalogPath: null,
    modelCatalogScene: "chat",
    sendPath: null,
    authSendCodePath: null,
    authSendCodeMethod: "POST",
    authSubmitCodePath: null,
    authSubmitCodeMethod: "POST",
    attachmentUploadPath: null,
    attachmentCompleteUploadPath: null,
    quotaUsagePath: null,
    activityLotteryPath: null,
    newbieExplorationPath: null,
    placementResourcesPath: null,
    rewardCardRecordsPath: null,
    lotteryHitRecordsPath: null,
    signInStatusPath: null,
    signInPath: null,
    benefitCouponListPath: null,
    benefitCouponUsePath: null,
    activityParticipatePath: null,
    usageResetCouponSkuPath: null,
    lotteryAvailableChancesPath: null,
    lotteryActiveMainPoolsPath: null,
    lotteryChanceRecordsPath: null,
    lotteryDrawPath: null,
    sessionVerifyPath: null,
    sessionVerifyMethod: "GET",
    reqCtx: null,
    defaultChatSessionId: null,
    chatSessionCreatePath: null,
    chatSessionCreateActionId: null,
    chatSessionAutoCreate: false,
  });
  assert.match(config.stateDir, /tabbit-protocol-pool$/);
});

test("loadConfig protocol enabled uses calibrated Tabbit defaults", () => {
  const config = loadConfig({
    TABBIT_POOL_PROTOCOL_ENABLED: "true",
  });

  assert.equal(config.protocol.enabled, true);
  assert.equal(config.protocol.baseUrl, "https://web.tabbit.ai");
  assert.equal(config.protocol.signKeyPath, "/chat/sign-key");
  assert.equal(config.protocol.modelCatalogPath, "/proxy/v1/model_config/models");
  assert.equal(config.protocol.modelCatalogScene, "chat");
  assert.equal(config.protocol.sendPath, "/api/v1/chat/completion");
  assert.equal(config.protocol.sessionVerifyPath, "/api/v0/user/base-info");
  assert.equal(config.protocol.sessionVerifyMethod, "GET");
  assert.equal(config.protocol.reqCtx, "MS4zLjI2KDEwMTAzMDI2KQ==");
  assert.equal(config.protocol.chatSessionCreatePath, "/newtab");
  assert.equal(config.protocol.chatSessionCreateActionId, "00b19386a3892f62370bef2ffacfbd5b58580fcb2a");
  assert.equal(config.protocol.chatSessionAutoCreate, true);
  assert.equal(config.protocol.fetchTransport, "node");
});

test("loadConfig adopts a complete external production state by default", () => {
  const cwd = path.resolve("E:/tabbit-protocol-pool");
  const stateDir = path.resolve("E:/tabbit-live-state");
  const apiKeyFile = path.join(stateDir, "secrets", "gateway-api-key.txt");
  const config = loadConfig({}, {
    cwd,
    platform: "win32",
    fs: fakeSyncFs({
      existing: [
        path.join(stateDir, "accounts.json"),
        path.join(stateDir, "readiness.json"),
        path.join(stateDir, "fixtures", "protocol-probes"),
        path.join(stateDir, "secrets"),
      ],
      files: {
        [apiKeyFile]: "prod-file-key\n",
      },
    }),
  });

  assert.equal(config.stateDir, stateDir);
  assert.equal(config.apiKey, "prod-file-key");
  assert.equal(config.productionState.source, "auto_discovered");
  assert.equal(config.productionState.apiKeySource, "state_secret");
  assert.equal(config.protocol.enabled, true);
  assert.equal(config.protocol.baseUrl, "https://web.tabbit.ai");
  assert.equal(config.protocol.sendPath, "/api/v1/chat/completion");
  assert.equal(config.protocol.sessionVerifyPath, "/api/v0/user/base-info");
  assert.equal(config.protocol.chatSessionCreatePath, "/newtab");
  assert.equal(config.protocol.chatSessionAutoCreate, true);
});

test("loadConfig does not auto-discover legacy tabbit2api state by default", () => {
  const cwd = path.resolve("E:/tabbit-protocol-pool");
  const legacyStateDir = path.resolve("E:/tabbit2api/output/tabbit-live-state");
  const config = loadConfig({ LOCALAPPDATA: "C:/Users/A/AppData/Local" }, {
    cwd,
    platform: "win32",
    fs: fakeSyncFs({
      existing: [
        path.join(legacyStateDir, "accounts.json"),
        path.join(legacyStateDir, "readiness.json"),
        path.join(legacyStateDir, "fixtures", "protocol-probes"),
        path.join(legacyStateDir, "secrets"),
      ],
      files: {
        [path.join(legacyStateDir, "secrets", "gateway-api-key.txt")]: "prod-file-key\n",
      },
    }),
  });

  assert.match(config.stateDir, /tabbit-protocol-pool$/);
  assert.equal(config.apiKey, "sk-tabbit-local");
  assert.equal(config.productionState.source, "default_local");
  assert.equal(config.productionState.apiKeySource, "default");
  assert.equal(config.protocol.enabled, false);
});

test("loadConfig ignores incomplete external production state candidates", () => {
  const cwd = path.resolve("E:/tabbit-protocol-pool");
  const stateDir = path.resolve("E:/tabbit2api/output/tabbit-live-state");
  const config = loadConfig({ LOCALAPPDATA: "C:/Users/A/AppData/Local" }, {
    cwd,
    platform: "win32",
    fs: fakeSyncFs({
      existing: [
        path.join(stateDir, "accounts.json"),
      ],
      files: {
        [path.join(stateDir, "secrets", "gateway-api-key.txt")]: "prod-file-key\n",
      },
    }),
    productionStateDirCandidates: [stateDir],
  });

  assert.match(config.stateDir, /tabbit-protocol-pool$/);
  assert.equal(config.apiKey, "sk-tabbit-local");
  assert.equal(config.productionState.source, "default_local");
  assert.equal(config.productionState.apiKeySource, "default");
  assert.equal(config.protocol.enabled, false);
  assert.equal(config.protocol.sendPath, null);
  assert.equal(config.protocol.sessionVerifyPath, null);
});

test("loadConfig applies environment overrides", () => {
  const config = loadConfig({
    TABBIT_POOL_HOST: "0.0.0.0",
    TABBIT_POOL_PORT: "50125",
    TABBIT_POOL_API_KEY: "local-secret",
    TABBIT_POOL_STATE_DIR: "E:/tmp/tabbit-pool",
    TABBIT_POOL_PROTOCOL_FIXTURE_DIR: "E:/tmp/tabbit-fixtures",
    TABBIT_POOL_RETRY_LIMIT: "3",
    TABBIT_POOL_ADMIN_USERNAME: "admin",
    TABBIT_POOL_ADMIN_PASSWORD: "page-password",
    YYDS_MAIL_API_KEY: "AC-test-key",
    TABBIT_POOL_PROTOCOL_ENABLED: "true",
    TABBIT_POOL_PROTOCOL_FETCH_TRANSPORT: "powershell",
    TABBIT_POOL_PROTOCOL_BASE_URL: "https://fixture.tabbit.test",
    TABBIT_POOL_PROTOCOL_SIGN_KEY_PATH: "/fixture/sign-key",
    TABBIT_POOL_PROTOCOL_MODEL_CATALOG_PATH: "/fixture/models",
    TABBIT_POOL_PROTOCOL_MODEL_CATALOG_SCENE: "script",
    TABBIT_POOL_PROTOCOL_SEND_PATH: "/fixture/send",
    TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH: "/fixture/auth/send-code",
    TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_METHOD: "put",
    TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH: "/fixture/auth/submit-code",
    TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_METHOD: "patch",
    TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH: "/fixture/attachments/upload",
    TABBIT_POOL_PROTOCOL_ATTACHMENT_COMPLETE_UPLOAD_PATH: "/fixture/attachments/complete-upload",
    TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH: "/fixture/quota/usage",
    TABBIT_POOL_PROTOCOL_ACTIVITY_LOTTERY_PATH: "/fixture/activity/lottery/me",
    TABBIT_POOL_PROTOCOL_NEWBIE_EXPLORATION_PATH: "/fixture/activity/newbie-exploration/me",
    TABBIT_POOL_PROTOCOL_PLACEMENT_RESOURCES_PATH: "/fixture/placement/resources",
    TABBIT_POOL_PROTOCOL_REWARD_CARD_RECORDS_PATH: "/fixture/reward/card-records",
    TABBIT_POOL_PROTOCOL_LOTTERY_HIT_RECORDS_PATH: "/fixture/lottery/hit-records",
    TABBIT_POOL_PROTOCOL_SIGN_IN_STATUS_PATH: "/fixture/activity/sign-in/status",
    TABBIT_POOL_PROTOCOL_SIGN_IN_PATH: "/fixture/activity/sign-in",
    TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_LIST_PATH: "/fixture/benefit/coupon/list",
    TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_USE_PATH: "/fixture/benefit/coupon/use",
    TABBIT_POOL_PROTOCOL_ACTIVITY_PARTICIPATE_PATH: "/fixture/activity/participate",
    TABBIT_POOL_PROTOCOL_USAGE_RESET_COUPON_SKU_PATH: "/fixture/product/usage-reset-coupon",
    TABBIT_POOL_PROTOCOL_LOTTERY_AVAILABLE_CHANCES_PATH: "/fixture/lottery/available-chances",
    TABBIT_POOL_PROTOCOL_LOTTERY_ACTIVE_MAIN_POOLS_PATH: "/fixture/lottery/active-main-pools",
    TABBIT_POOL_PROTOCOL_LOTTERY_CHANCE_RECORDS_PATH: "/fixture/activity/lottery/chance-records",
    TABBIT_POOL_PROTOCOL_LOTTERY_DRAW_PATH: "/fixture/lottery/draw",
    TABBIT_POOL_PROTOCOL_SESSION_VERIFY_PATH: "/fixture/session/check",
    TABBIT_POOL_PROTOCOL_SESSION_VERIFY_METHOD: "post",
    TABBIT_POOL_PROTOCOL_REQ_CTX: "fixture-req-ctx",
    TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID: "fixture-chat-session",
    TABBIT_POOL_PROTOCOL_CHAT_SESSION_CREATE_PATH: "/fixture/newtab",
    TABBIT_POOL_PROTOCOL_CHAT_SESSION_CREATE_ACTION_ID: "fixture-action-id",
    TABBIT_POOL_PROTOCOL_CHAT_SESSION_AUTO_CREATE: "false",
    TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS: "true",
    TABBIT_POOL_TOOL_LOOP_MODE: "disabled",
  }, { platform: "win32" });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 50125);
  assert.equal(config.apiKey, "local-secret");
  assert.equal(config.stateDir, "E:/tmp/tabbit-pool");
  assert.equal(config.protocolFixtureDir, "E:/tmp/tabbit-fixtures");
  assert.equal(config.retryLimit, 3);
  assert.equal(config.yydsMailApiKey, "AC-test-key");
  assert.deepEqual(config.admin, {
    username: "admin",
    password: "page-password",
  });
  assert.equal(config.mail.enabled, true);
  assert.deepEqual(config.compat, {
    stripClientTools: true,
    toolLoopMode: "disabled",
    localToolLoop: {
      allowedToolNames: [],
      maxRounds: 4,
      toolTimeoutMs: 0,
      maxToolResultChars: 16_000,
    },
  });
  assert.deepEqual(config.protocol, {
    enabled: true,
    fetchTransport: "powershell",
    baseUrl: "https://fixture.tabbit.test",
    signKeyPath: "/fixture/sign-key",
    modelCatalogPath: "/fixture/models",
    modelCatalogScene: "script",
    sendPath: "/fixture/send",
    authSendCodePath: "/fixture/auth/send-code",
    authSendCodeMethod: "PUT",
    authSubmitCodePath: "/fixture/auth/submit-code",
    authSubmitCodeMethod: "PATCH",
    attachmentUploadPath: "/fixture/attachments/upload",
    attachmentCompleteUploadPath: "/fixture/attachments/complete-upload",
    quotaUsagePath: "/fixture/quota/usage",
    activityLotteryPath: "/fixture/activity/lottery/me",
    newbieExplorationPath: "/fixture/activity/newbie-exploration/me",
    placementResourcesPath: "/fixture/placement/resources",
    rewardCardRecordsPath: "/fixture/reward/card-records",
    lotteryHitRecordsPath: "/fixture/lottery/hit-records",
    signInStatusPath: "/fixture/activity/sign-in/status",
    signInPath: "/fixture/activity/sign-in",
    benefitCouponListPath: "/fixture/benefit/coupon/list",
    benefitCouponUsePath: "/fixture/benefit/coupon/use",
    activityParticipatePath: "/fixture/activity/participate",
    usageResetCouponSkuPath: "/fixture/product/usage-reset-coupon",
    lotteryAvailableChancesPath: "/fixture/lottery/available-chances",
    lotteryActiveMainPoolsPath: "/fixture/lottery/active-main-pools",
    lotteryChanceRecordsPath: "/fixture/activity/lottery/chance-records",
    lotteryDrawPath: "/fixture/lottery/draw",
    sessionVerifyPath: "/fixture/session/check",
    sessionVerifyMethod: "POST",
    reqCtx: "fixture-req-ctx",
    defaultChatSessionId: "fixture-chat-session",
    chatSessionCreatePath: "/fixture/newtab",
    chatSessionCreateActionId: "fixture-action-id",
    chatSessionAutoCreate: false,
  });
});

test("loadConfig enables protocol wiring when an endpoint path is configured", () => {
  const config = loadConfig({
    TABBIT_POOL_PROTOCOL_PLACEMENT_RESOURCES_PATH: "/api/commerce/placement/v1/resources",
  });

  assert.equal(config.protocol.enabled, true);
  assert.equal(config.protocol.placementResourcesPath, "/api/commerce/placement/v1/resources");
});

test("loadConfig enables protocol wiring when an auth endpoint path is configured", () => {
  const sendCode = loadConfig({
    TABBIT_POOL_PROTOCOL_AUTH_SEND_CODE_PATH: "/api/auth/send-code",
  });
  const submitCode = loadConfig({
    TABBIT_POOL_PROTOCOL_AUTH_SUBMIT_CODE_PATH: "/api/auth/submit-code",
  });

  assert.equal(sendCode.protocol.enabled, true);
  assert.equal(sendCode.protocol.authSendCodePath, "/api/auth/send-code");
  assert.equal(submitCode.protocol.enabled, true);
  assert.equal(submitCode.protocol.authSubmitCodePath, "/api/auth/submit-code");
});

test("loadConfig rejects invalid protocol enabled flags", () => {
  assert.throws(() => loadConfig({ TABBIT_POOL_PROTOCOL_ENABLED: "maybe" }), /Invalid protocol enabled/);
});

test("loadConfig rejects invalid chat session auto-create flags", () => {
  assert.throws(() => loadConfig({ TABBIT_POOL_PROTOCOL_CHAT_SESSION_AUTO_CREATE: "maybe" }), /Invalid chat session auto-create/);
});

test("loadConfig rejects unsupported protocol fetch transports", () => {
  assert.throws(() => loadConfig({ TABBIT_POOL_PROTOCOL_FETCH_TRANSPORT: "browser" }), /Invalid protocol fetch transport/);
});

test("loadConfig rejects invalid compat strip client tools flags", () => {
  assert.throws(() => loadConfig({ TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS: "maybe" }), /Invalid compat strip client tools/);
});

test("loadConfig rejects unsupported tool loop modes", () => {
  assert.throws(() => loadConfig({ TABBIT_POOL_TOOL_LOOP_MODE: "auto_execute" }), /Invalid tool loop mode/);
});

test("loadConfig accepts explicit local tool execution mode", () => {
  const config = loadConfig({ TABBIT_POOL_TOOL_LOOP_MODE: "local_executes_tools" });

  assert.equal(config.compat.toolLoopMode, "local_executes_tools");
});

test("loadConfig parses local tool loop guardrail env", () => {
  const config = loadConfig({
    TABBIT_POOL_TOOL_LOOP_MODE: "local_executes_tools",
    TABBIT_POOL_LOCAL_TOOL_ALLOWLIST: "lookup, summarize, lookup",
    TABBIT_POOL_LOCAL_TOOL_MAX_ROUNDS: "2",
    TABBIT_POOL_LOCAL_TOOL_TIMEOUT_MS: "50",
    TABBIT_POOL_LOCAL_TOOL_MAX_RESULT_CHARS: "12",
  });

  assert.deepEqual(config.compat.localToolLoop, {
    allowedToolNames: ["lookup", "summarize"],
    maxRounds: 2,
    toolTimeoutMs: 50,
    maxToolResultChars: 12,
  });
});

test("loadConfig rejects invalid local tool loop guardrail env", () => {
  assert.throws(() => loadConfig({ TABBIT_POOL_LOCAL_TOOL_MAX_ROUNDS: "0" }), /local tool max rounds/i);
  assert.throws(() => loadConfig({ TABBIT_POOL_LOCAL_TOOL_TIMEOUT_MS: "-1" }), /local tool timeout/i);
  assert.throws(() => loadConfig({ TABBIT_POOL_LOCAL_TOOL_MAX_RESULT_CHARS: "0" }), /local tool max result chars/i);
});

test("normalizePort rejects invalid ports instead of silently changing behavior", () => {
  assert.equal(normalizePort(undefined, 50124), 50124);
  assert.equal(normalizePort("50125", 50124), 50125);
  assert.throws(() => normalizePort("0", 50124), /Invalid port/);
  assert.throws(() => normalizePort("70000", 50124), /Invalid port/);
  assert.throws(() => normalizePort("abc", 50124), /Invalid port/);
});
