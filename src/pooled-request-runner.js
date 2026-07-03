import { AccountPoolError } from "./account-pool.js";

export class PooledRequestError extends Error {
  constructor(message, { category = "pooled_request_error", code = null, retryable = false, cooldownMs = 0, detail = null } = {}) {
    super(message);
    this.name = "PooledRequestError";
    this.category = category;
    this.code = code;
    this.retryable = retryable;
    this.cooldownMs = cooldownMs;
    this.detail = detail;
  }
}

function normalizeError(error) {
  if (!error) return new PooledRequestError("Unknown pooled request failure.", { category: "unknown" });
  if (error instanceof PooledRequestError) return error;
  return new PooledRequestError(error.message || "Pooled request failed.", {
    category: error.category || "unknown",
    code: error.code || null,
    retryable: Boolean(error.retryable),
    cooldownMs: Number.isFinite(error.cooldownMs) ? error.cooldownMs : 0,
    detail: error.detail || null,
  });
}

function errorResult(error, attemptedAccounts, fallbackHappened = false) {
  return { ok: false, error: normalizeError(error), attemptedAccounts, fallbackHappened };
}

function normalizeRetryLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PooledRequestError("Invalid retryLimit: must be a non-negative safe integer.", {
      category: "invalid_request",
      code: "INVALID_RETRY_LIMIT",
    });
  }
  return value;
}

export class PooledRequestRunner {
  constructor({ accountPool, protocolClientFactory, retryLimit = 1 } = {}) {
    if (!accountPool) throw new PooledRequestError("accountPool is required", { category: "invalid_request", code: "MISSING_ACCOUNT_POOL" });
    if (typeof protocolClientFactory !== "function") throw new PooledRequestError("protocolClientFactory is required", { category: "invalid_request", code: "MISSING_PROTOCOL_CLIENT_FACTORY" });
    this.accountPool = accountPool;
    this.protocolClientFactory = protocolClientFactory;
    this.retryLimit = normalizeRetryLimit(retryLimit);
  }

  pickInitial({ model, requiresPremium }) {
    try {
      return this.accountPool.pickAccount({ model, requiresPremium }).account;
    } catch (error) {
      if (error instanceof AccountPoolError) {
        return { __poolError: error };
      }
      throw error;
    }
  }

  async run({
    model = "tabbit/priority",
    messages = [],
    attachments = [],
    stream = false,
    tools = null,
    toolChoice = null,
    parallelToolCalls = null,
    requiresPremium = false,
    requestId = null,
  } = {}) {
    const first = this.pickInitial({ model, requiresPremium });
    if (first?.__poolError) {
      return errorResult(new PooledRequestError(first.__poolError.message, { category: first.__poolError.category, code: first.__poolError.code, detail: first.__poolError.candidates }), []);
    }

    const attemptedAccounts = [];
    let account = first;
    let retryCount = 0;
    let fallbackHappened = false;
    let lastError = null;

    while (account) {
      attemptedAccounts.push(account.id);
      const client = this.protocolClientFactory(account);
      if (!client || typeof client.sendMessage !== "function") {
        return errorResult(new PooledRequestError("protocol client must expose sendMessage", {
          category: "invalid_request",
          code: "MISSING_SEND_MESSAGE",
          retryable: false,
        }), attemptedAccounts, fallbackHappened);
      }
      let result;
      try {
        result = await client.sendMessage({
          account,
          model,
          messages,
          attachments,
          stream,
          tools,
          toolChoice,
          parallelToolCalls,
        });
      } catch (error) {
        result = { ok: false, error: normalizeError(error) };
      }

      if (result?.ok) {
        await this.accountPool.recordSuccess(account.id, { requestId });
        return {
          ...result,
          accountId: account.id,
          attemptedAccounts,
          fallbackHappened,
          selectedModel: result.selectedModel || model,
        };
      }

      lastError = normalizeError(result?.error);
      await this.accountPool.recordFailure(account.id, lastError, { requestId });
      const decision = this.accountPool.shouldFallback({
        error: lastError,
        attemptedAccountIds: attemptedAccounts,
        model,
        retryCount,
        retryLimit: this.retryLimit,
        requiresPremium,
      });
      if (!decision.fallback) {
        return errorResult(lastError, attemptedAccounts, fallbackHappened);
      }
      fallbackHappened = true;
      retryCount += 1;
      account = decision.nextAccount;
    }

    return errorResult(lastError || new PooledRequestError("No account attempted.", { category: "no_available_account" }), attemptedAccounts, fallbackHappened);
  }
}
