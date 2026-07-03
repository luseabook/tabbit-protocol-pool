import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig, normalizePort } from "../src/config.js";

test("loadConfig returns safe local defaults", () => {
  const config = loadConfig({ LOCALAPPDATA: "C:/Users/A/AppData/Local" }, { platform: "win32" });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 50124);
  assert.equal(config.apiKey, "sk-tabbit-local");
  assert.equal(config.yydsMailApiKey, null);
  assert.equal(config.mail.enabled, false);
  assert.deepEqual(config.compat, {
    stripClientTools: false,
    toolLoopMode: "client_executes_tools_first",
  });
  assert.deepEqual(config.protocol, {
    enabled: false,
    baseUrl: null,
    signKeyPath: null,
    modelCatalogPath: null,
    modelCatalogScene: "chat",
    sendPath: null,
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
  });
  assert.match(config.stateDir, /tabbit-protocol-pool$/);
});

test("loadConfig applies environment overrides", () => {
  const config = loadConfig({
    TABBIT_POOL_HOST: "0.0.0.0",
    TABBIT_POOL_PORT: "50125",
    TABBIT_POOL_API_KEY: "local-secret",
    TABBIT_POOL_STATE_DIR: "E:/tmp/tabbit-pool",
    TABBIT_POOL_RETRY_LIMIT: "3",
    YYDS_MAIL_API_KEY: "AC-test-key",
    TABBIT_POOL_PROTOCOL_ENABLED: "true",
    TABBIT_POOL_PROTOCOL_BASE_URL: "https://fixture.tabbit.test",
    TABBIT_POOL_PROTOCOL_SIGN_KEY_PATH: "/fixture/sign-key",
    TABBIT_POOL_PROTOCOL_MODEL_CATALOG_PATH: "/fixture/models",
    TABBIT_POOL_PROTOCOL_MODEL_CATALOG_SCENE: "script",
    TABBIT_POOL_PROTOCOL_SEND_PATH: "/fixture/send",
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
    TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS: "true",
    TABBIT_POOL_TOOL_LOOP_MODE: "disabled",
  }, { platform: "win32" });

  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 50125);
  assert.equal(config.apiKey, "local-secret");
  assert.equal(config.stateDir, "E:/tmp/tabbit-pool");
  assert.equal(config.retryLimit, 3);
  assert.equal(config.yydsMailApiKey, "AC-test-key");
  assert.equal(config.mail.enabled, true);
  assert.deepEqual(config.compat, {
    stripClientTools: true,
    toolLoopMode: "disabled",
  });
  assert.deepEqual(config.protocol, {
    enabled: true,
    baseUrl: "https://fixture.tabbit.test",
    signKeyPath: "/fixture/sign-key",
    modelCatalogPath: "/fixture/models",
    modelCatalogScene: "script",
    sendPath: "/fixture/send",
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
  });
});

test("loadConfig enables protocol wiring when an endpoint path is configured", () => {
  const config = loadConfig({
    TABBIT_POOL_PROTOCOL_PLACEMENT_RESOURCES_PATH: "/api/commerce/placement/v1/resources",
  });

  assert.equal(config.protocol.enabled, true);
  assert.equal(config.protocol.placementResourcesPath, "/api/commerce/placement/v1/resources");
});

test("loadConfig rejects invalid protocol enabled flags", () => {
  assert.throws(() => loadConfig({ TABBIT_POOL_PROTOCOL_ENABLED: "maybe" }), /Invalid protocol enabled/);
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

test("normalizePort rejects invalid ports instead of silently changing behavior", () => {
  assert.equal(normalizePort(undefined, 50124), 50124);
  assert.equal(normalizePort("50125", 50124), 50125);
  assert.throws(() => normalizePort("0", 50124), /Invalid port/);
  assert.throws(() => normalizePort("70000", 50124), /Invalid port/);
  assert.throws(() => normalizePort("abc", 50124), /Invalid port/);
});
