import { loadConfig } from "./config.js";
import { JsonAccountStore, StoredAccountPool } from "./account-store.js";
import { PooledRequestRunner } from "./pooled-request-runner.js";
import { LocalToolLoopRunner } from "./local-tool-loop-runner.js";
import { OpenAICompat } from "./openai-compat.js";
import { AnthropicCompat } from "./anthropic-compat.js";
import { ProtocolTabbitClient, ProtocolTabbitError } from "./protocol-tabbit-client.js";
import { createProtocolPoolServer } from "./http-server.js";
import { FileSecretStore } from "./secret-store.js";
import { createGatewayHealthProvider } from "./observability.js";

export async function hydrateAccountSecrets(account = {}, secretStore = null) {
  const hydrated = { ...account, audit: Array.isArray(account.audit) ? [...account.audit] : account.audit };
  if (!hydrated.cookie && !hydrated.cookieHeader && hydrated.cookieJarRef && secretStore?.readSecret) {
    const secret = await secretStore.readSecret(hydrated.cookieJarRef);
    if (secret) hydrated.cookieHeader = secret;
  }
  return hydrated;
}

export function createSecretHydratingProtocolClientFactory(baseFactory, secretStore) {
  return (account) => ({
    async sendMessage(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      return await client.sendMessage({ ...input, account: hydratedAccount });
    },
    async verifySession(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.verifySession !== "function") return { ok: false, category: "protocol_missing", code: "VERIFY_SESSION_MISSING", message: "protocol operation is not configured" };
      const session = input.session || hydratedAccount.cookieHeader || hydratedAccount.cookie || null;
      return await client.verifySession({ ...input, account: hydratedAccount, session });
    },
    async uploadAttachment(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.uploadAttachment !== "function") {
        return {
          ok: false,
          error: new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "UPLOAD_ATTACHMENT_MISSING" }),
        };
      }
      return await client.uploadAttachment({ ...input, account: hydratedAccount });
    },
    async refreshQuota(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.refreshQuota !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "REFRESH_QUOTA_MISSING" });
      }
      return await client.refreshQuota({ ...input, account: hydratedAccount });
    },
    async getLotteryExplorationMe(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.getLotteryExplorationMe !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "GET_LOTTERY_EXPLORATION_ME_MISSING" });
      }
      return await client.getLotteryExplorationMe({ ...input, account: hydratedAccount });
    },
    async getNewbieExplorationMe(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.getNewbieExplorationMe !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "GET_NEWBIE_EXPLORATION_ME_MISSING" });
      }
      return await client.getNewbieExplorationMe({ ...input, account: hydratedAccount });
    },
    async getPlacementResources(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.getPlacementResources !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "GET_PLACEMENT_RESOURCES_MISSING" });
      }
      return await client.getPlacementResources({ ...input, account: hydratedAccount });
    },
    async listRewardCardRecords(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.listRewardCardRecords !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "LIST_REWARD_CARD_RECORDS_MISSING" });
      }
      return await client.listRewardCardRecords({ ...input, account: hydratedAccount });
    },
    async listLotteryHitRecords(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.listLotteryHitRecords !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "LIST_LOTTERY_HIT_RECORDS_MISSING" });
      }
      return await client.listLotteryHitRecords({ ...input, account: hydratedAccount });
    },
    async getDailySignInStatus(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.getDailySignInStatus !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "GET_DAILY_SIGN_IN_STATUS_MISSING" });
      }
      return await client.getDailySignInStatus({ ...input, account: hydratedAccount });
    },
    async dailySignIn(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.dailySignIn !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "DAILY_SIGN_IN_MISSING" });
      }
      return await client.dailySignIn({ ...input, account: hydratedAccount });
    },
    async listBenefitCoupons(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.listBenefitCoupons !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "LIST_BENEFIT_COUPONS_MISSING" });
      }
      return await client.listBenefitCoupons({ ...input, account: hydratedAccount });
    },
    async participateResetCouponActivity(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.participateResetCouponActivity !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "PARTICIPATE_RESET_COUPON_ACTIVITY_MISSING" });
      }
      return await client.participateResetCouponActivity({ ...input, account: hydratedAccount });
    },
    async participateActivity(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.participateActivity !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "PARTICIPATE_ACTIVITY_MISSING" });
      }
      return await client.participateActivity({ ...input, account: hydratedAccount });
    },
    async getUsageResetCouponSku(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.getUsageResetCouponSku !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "GET_USAGE_RESET_COUPON_SKU_MISSING" });
      }
      return await client.getUsageResetCouponSku({ ...input, account: hydratedAccount });
    },
    async getAvailableLotteryChanceCount(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.getAvailableLotteryChanceCount !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "GET_AVAILABLE_LOTTERY_CHANCE_COUNT_MISSING" });
      }
      return await client.getAvailableLotteryChanceCount({ ...input, account: hydratedAccount });
    },
    async getActiveMainPools(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.getActiveMainPools !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "GET_ACTIVE_MAIN_POOLS_MISSING" });
      }
      return await client.getActiveMainPools({ ...input, account: hydratedAccount });
    },
    async listLotteryChanceRecords(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.listLotteryChanceRecords !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "LIST_LOTTERY_CHANCE_RECORDS_MISSING" });
      }
      return await client.listLotteryChanceRecords({ ...input, account: hydratedAccount });
    },
    async drawLottery(input = {}) {
      const hydratedAccount = await hydrateAccountSecrets(input.account || account, secretStore);
      const client = baseFactory(hydratedAccount);
      if (!client || typeof client.drawLottery !== "function") {
        throw new ProtocolTabbitError("protocol operation is not configured", { category: "protocol_missing", code: "DRAW_LOTTERY_MISSING" });
      }
      return await client.drawLottery({ ...input, account: hydratedAccount });
    },
  });
}

export function createDefaultProtocolClientFactory({ protocolClientOptions = {}, fetch: fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  return () => new ProtocolTabbitClient({
    ...protocolClientOptions,
    fetch: protocolClientOptions.fetch || fetchImpl,
    now: protocolClientOptions.now || now,
  });
}

function configuredProtocolClientOptions(config = {}) {
  if (!config.protocol?.enabled) return {};
  const options = {};
  for (const key of ["baseUrl", "signKeyPath", "modelCatalogPath", "modelCatalogScene", "sendPath", "attachmentUploadPath", "attachmentCompleteUploadPath", "quotaUsagePath", "activityLotteryPath", "newbieExplorationPath", "placementResourcesPath", "rewardCardRecordsPath", "lotteryHitRecordsPath", "signInStatusPath", "signInPath", "benefitCouponListPath", "activityParticipatePath", "usageResetCouponSkuPath", "lotteryAvailableChancesPath", "lotteryActiveMainPoolsPath", "lotteryChanceRecordsPath", "lotteryDrawPath", "sessionVerifyPath", "sessionVerifyMethod", "reqCtx", "defaultChatSessionId"]) {
    if (config.protocol[key]) options[key] = config.protocol[key];
  }
  return options;
}

function createProtocolModelsProvider(baseProtocolClientFactory, config = {}) {
  if (!config.protocol?.enabled || typeof baseProtocolClientFactory !== "function") return null;
  return {
    async listModels(input = {}) {
      const client = baseProtocolClientFactory({});
      return await client.listModels(input);
    },
  };
}

function localToolExecutorFromOptions(options = {}) {
  if (typeof options.executeLocalToolUse === "function") return options.executeLocalToolUse;
  if (typeof options.localToolExecutor === "function") return options.localToolExecutor;
  if (typeof options.localToolExecutor?.execute === "function") {
    return options.localToolExecutor.execute.bind(options.localToolExecutor);
  }
  return null;
}

export async function listen(server, { host = "127.0.0.1", port = 0 } = {}) {
  if (server.listening) return server;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  return server;
}

export async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function createProtocolPoolGateway(options = {}) {
  const config = options.config || loadConfig(options.env, options);
  const accountNow = options.now || (() => Date.now());
  const startedAt = options.startedAt ?? accountNow();
  const compatNow = options.compatNow || (() => Math.floor(accountNow() / 1000));
  const store = options.store || new JsonAccountStore({ stateDir: config.stateDir });
  const secretStore = options.secretStore || new FileSecretStore({ stateDir: config.stateDir });
  const accountPool = options.accountPool || await StoredAccountPool.load({ store, now: accountNow });
  const configuredClientOptions = configuredProtocolClientOptions(config);
  const baseProtocolClientFactory = options.protocolClientFactory || createDefaultProtocolClientFactory({
    protocolClientOptions: { ...configuredClientOptions, ...(options.protocolClientOptions || {}) },
    fetch: options.fetch,
    now: options.protocolNow || accountNow,
  });
  const protocolClientFactory = options.hydrateSecrets === false
    ? baseProtocolClientFactory
    : createSecretHydratingProtocolClientFactory(baseProtocolClientFactory, secretStore);
  const baseRunner = options.runner || new PooledRequestRunner({
    accountPool,
    protocolClientFactory,
    retryLimit: config.retryLimit,
  });
  const runner = options.toolLoopRunner || new LocalToolLoopRunner({
    runner: baseRunner,
    mode: config.compat?.toolLoopMode,
    executeToolUse: localToolExecutorFromOptions(options),
  });
  const openAiCompat = options.openAiCompat || new OpenAICompat({
    runner,
    now: compatNow,
    idFactory: options.idFactory,
    stripClientTools: config.compat?.stripClientTools,
  });
  const anthropicCompat = options.anthropicCompat || new AnthropicCompat({
    runner,
    now: compatNow,
    idFactory: options.idFactory,
    stripClientTools: config.compat?.stripClientTools,
  });
  const compat = options.compat || {
    handleChatCompletions: openAiCompat.handleChatCompletions.bind(openAiCompat),
    handleResponses: openAiCompat.handleResponses.bind(openAiCompat),
    handleMessages: anthropicCompat.handleMessages.bind(anthropicCompat),
  };
  const health = Object.prototype.hasOwnProperty.call(options, "health")
    ? options.health
    : createGatewayHealthProvider({
      accountPool,
      modelCache: options.modelCache,
      startedAt,
      now: accountNow,
    });
  const modelsProvider = Object.prototype.hasOwnProperty.call(options, "modelsProvider")
    ? options.modelsProvider
    : createProtocolModelsProvider(baseProtocolClientFactory, config);
  const server = options.server || createProtocolPoolServer({
    apiKey: config.apiKey,
    compat,
    modelsProvider,
    health,
  });

  return {
    config,
    store,
    secretStore,
    accountPool,
    protocolClientFactory,
    runner,
    openAiCompat,
    anthropicCompat,
    compat,
    server,
    async start(startOptions = {}) {
      await listen(server, {
        host: startOptions.host || config.host,
        port: startOptions.port ?? config.port,
      });
      return server;
    },
    async close() {
      await closeServer(server);
    },
  };
}
