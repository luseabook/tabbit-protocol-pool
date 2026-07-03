import { normalizeAccount } from "./account-pool.js";
import { redactSensitiveValue } from "./redact.js";

const PAID_TIERS = new Set(["pro", "premium"]);

export class BenefitsMaintainerError extends Error {
  constructor(message, code = "BENEFITS_MAINTAINER_ERROR") {
    super(message);
    this.name = "BenefitsMaintainerError";
    this.code = code;
  }
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nowDate(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value : new Date(value || Date.now());
}

function sameUtcDate(a, b) {
  if (!a || !b) return false;
  const left = new Date(a);
  const right = new Date(b);
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return false;
  return left.getUTCFullYear() === right.getUTCFullYear()
    && left.getUTCMonth() === right.getUTCMonth()
    && left.getUTCDate() === right.getUTCDate();
}

function errorSummary(error) {
  return {
    message: redactSensitiveValue(error?.message || String(error || "Unknown maintenance error.")),
    ...(error?.code ? { code: String(error.code) } : {}),
    ...(error?.category ? { category: String(error.category) } : {}),
    ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {}),
    ...(Number.isFinite(error?.cooldownMs) ? { cooldownMs: error.cooldownMs } : {}),
  };
}

function defaultCooldownMs(category) {
  if (category === "rate_limited") return 60_000;
  if (category === "upstream_error") return 10_000;
  if (category === "network_error") return 60_000;
  return 0;
}

function maintenanceStatusForError(error) {
  const category = String(error?.category || "");
  if (category === "login_required") return "login_expired";
  if (category === "quota_exhausted") return "quota_exhausted";
  if (category === "protocol_changed" || category === "forbidden") return "suspect";
  if (["rate_limited", "upstream_error", "network_error"].includes(category)) return "cooldown";
  return null;
}

function applyMaintenanceFailure(account, error, observedAt) {
  const nextStatus = maintenanceStatusForError(error);
  if (!nextStatus) return { account, changed: false };
  const observedMs = Date.parse(observedAt);
  const cooldownMs = Number.isFinite(error?.cooldownMs) && error.cooldownMs > 0
    ? error.cooldownMs
    : defaultCooldownMs(error?.category);
  return {
    account: {
      ...account,
      status: nextStatus,
      lastMaintainedAt: observedAt,
      cooldownUntil: nextStatus === "cooldown" && cooldownMs > 0 && Number.isFinite(observedMs)
        ? new Date(observedMs + cooldownMs).toISOString()
        : null,
      lastError: {
        category: String(error?.category || "unknown"),
        message: redactSensitiveValue(error?.message || String(error || "Unknown maintenance error.")),
        ...(error?.code ? { code: String(error.code) } : {}),
        ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {}),
        ...(cooldownMs > 0 ? { cooldownMs } : {}),
      },
    },
    changed: true,
  };
}

function action(name, status, { changed = false, detail = null, error = null } = {}) {
  return {
    name,
    status,
    changed,
    ...(detail ? { detail } : {}),
    ...(error ? { error } : {}),
  };
}

function cloneAccount(account) {
  return normalizeAccount({ ...account, audit: Array.isArray(account?.audit) ? [...account.audit] : [] });
}

function normalizeQuotaList(quotaState, source = "unknown") {
  return (Array.isArray(quotaState) ? quotaState : []).map((entry) => normalizeQuotaState(entry, { source }));
}

function hasExhaustedQuota(quotaState = []) {
  return quotaState.some((quota) => quota.exhausted === true);
}

function hasAvailableQuota(quotaState = []) {
  return quotaState.some((quota) => quota.exhausted === false && (quota.remaining === null || quota.remaining > 0));
}

export function normalizeQuotaState(entry = {}, { source = "unknown" } = {}) {
  const remaining = toFiniteNumber(entry.remaining);
  const limit = toFiniteNumber(entry.limit);
  const exhausted = typeof entry.exhausted === "boolean" ? entry.exhausted : remaining === 0;
  return {
    model: String(entry.model || entry.name || "unknown"),
    remaining,
    limit,
    unit: String(entry.unit || "unknown"),
    resetAt: entry.resetAt || entry.reset_at || null,
    exhausted,
    source: String(entry.source || source || "unknown"),
  };
}

export class BenefitsMaintainer {
  constructor({ protocolClient, accountStore = null, now = () => new Date() } = {}) {
    if (!protocolClient || typeof protocolClient !== "object") {
      throw new BenefitsMaintainerError("protocolClient object is required", "MISSING_PROTOCOL_CLIENT");
    }
    if (accountStore && typeof accountStore.loadAccounts !== "function") {
      throw new BenefitsMaintainerError("accountStore with loadAccounts() is required", "MISSING_ACCOUNT_STORE");
    }
    this.protocolClient = protocolClient;
    this.accountStore = accountStore;
    this.now = now;
  }

  nowIso() {
    return nowDate(this.now).toISOString();
  }

  async refreshQuota(account) {
    const next = cloneAccount(account);
    if (typeof this.protocolClient.refreshQuota !== "function") {
      return { account: next, changed: false, action: action("refreshQuota", "skipped", { detail: "protocol operation is not configured" }) };
    }

    try {
      const result = await this.protocolClient.refreshQuota(next);
      const quotaState = normalizeQuotaList(result?.quotaState, result?.source || "unknown");
      if (quotaState.length) next.quotaState = quotaState;
      if (Number.isFinite(result?.resetCouponCount)) next.resetCouponCount = result.resetCouponCount;
      if (result?.accessTier) next.accessTier = String(result.accessTier);
      if (hasExhaustedQuota(next.quotaState)) next.status = "quota_exhausted";
      if (next.status === "quota_exhausted" && hasAvailableQuota(next.quotaState)) next.status = "active";
      next.lastMaintainedAt = this.nowIso();
      return { account: next, changed: true, action: action("refreshQuota", "success", { changed: true }) };
    } catch (error) {
      const failure = applyMaintenanceFailure(next, error, this.nowIso());
      return { account: failure.account, changed: failure.changed, action: action("refreshQuota", "failed", { changed: failure.changed, error: errorSummary(error) }) };
    }
  }

  async dailyCheckin(account) {
    const next = cloneAccount(account);
    const nowIso = this.nowIso();
    if (sameUtcDate(next.lastCheckinAt, nowIso)) {
      return { account: next, changed: false, action: action("dailyCheckin", "skipped", { detail: "already checked in today" }) };
    }
    if (typeof this.protocolClient.dailyCheckin !== "function") {
      return { account: next, changed: false, action: action("dailyCheckin", "skipped", { detail: "protocol operation is not configured" }) };
    }

    try {
      await this.protocolClient.dailyCheckin(next);
      next.lastCheckinAt = nowIso;
      next.lastMaintainedAt = nowIso;
      return { account: next, changed: true, action: action("dailyCheckin", "success", { changed: true }) };
    } catch (error) {
      const failure = applyMaintenanceFailure(next, error, this.nowIso());
      return { account: failure.account, changed: failure.changed, action: action("dailyCheckin", "failed", { changed: failure.changed, error: errorSummary(error) }) };
    }
  }

  async claimProIfAvailable(account) {
    const next = cloneAccount(account);
    if (PAID_TIERS.has(String(next.accessTier || "").toLowerCase())) {
      return { account: next, changed: false, action: action("claimProIfAvailable", "skipped", { detail: "account already has paid access" }) };
    }
    if (next.proClaimed === true) {
      return { account: next, changed: false, action: action("claimProIfAvailable", "skipped", { detail: "pro already claimed" }) };
    }
    if (typeof this.protocolClient.claimProIfAvailable !== "function") {
      return { account: next, changed: false, action: action("claimProIfAvailable", "skipped", { detail: "protocol operation is not configured" }) };
    }

    try {
      const result = await this.protocolClient.claimProIfAvailable(next);
      if (result?.accessTier) next.accessTier = String(result.accessTier);
      if (typeof result?.proClaimed === "boolean") next.proClaimed = result.proClaimed;
      else next.proClaimed = true;
      next.lastMaintainedAt = this.nowIso();
      return { account: next, changed: true, action: action("claimProIfAvailable", "success", { changed: true }) };
    } catch (error) {
      const failure = applyMaintenanceFailure(next, error, this.nowIso());
      return { account: failure.account, changed: failure.changed, action: action("claimProIfAvailable", "failed", { changed: failure.changed, error: errorSummary(error) }) };
    }
  }

  async useResetCoupon(account) {
    const next = cloneAccount(account);
    if (next.status !== "quota_exhausted") {
      return { account: next, changed: false, action: action("useResetCoupon", "skipped", { detail: "account is not quota_exhausted" }) };
    }
    if (!Number.isFinite(next.resetCouponCount) || next.resetCouponCount <= 0) {
      return { account: next, changed: false, action: action("useResetCoupon", "skipped", { detail: "no reset coupons available" }) };
    }
    if (typeof this.protocolClient.useResetCoupon !== "function") {
      return { account: next, changed: false, action: action("useResetCoupon", "skipped", { detail: "protocol operation is not configured" }) };
    }

    try {
      const result = await this.protocolClient.useResetCoupon(next);
      next.resetCouponCount = Math.max(0, next.resetCouponCount - 1);
      const quotaState = normalizeQuotaList(result?.quotaState, result?.source || "reset");
      if (quotaState.length) next.quotaState = quotaState;
      next.status = "active";
      next.lastMaintainedAt = this.nowIso();
      return { account: next, changed: true, action: action("useResetCoupon", "success", { changed: true }) };
    } catch (error) {
      const failure = applyMaintenanceFailure(next, error, this.nowIso());
      return { account: failure.account, changed: failure.changed, action: action("useResetCoupon", "failed", { changed: failure.changed, error: errorSummary(error) }) };
    }
  }

  async maintainAccount(account) {
    let current = cloneAccount(account);
    const actions = [];
    let changed = false;

    for (const methodName of ["refreshQuota", "claimProIfAvailable", "dailyCheckin", "useResetCoupon"]) {
      const result = await this[methodName](current);
      current = result.account;
      actions.push(result.action);
      changed = changed || result.changed;
    }

    return { account: current, changed, actions };
  }

  async maintainAllAccounts(accounts = null) {
    let sourceAccounts = accounts;
    const shouldPersist = sourceAccounts === null || sourceAccounts === undefined;
    if (shouldPersist) {
      if (!this.accountStore) {
        throw new BenefitsMaintainerError("accounts array or accountStore is required", "MISSING_ACCOUNT_SOURCE");
      }
      sourceAccounts = await this.accountStore.loadAccounts();
    }
    if (!Array.isArray(sourceAccounts)) {
      throw new BenefitsMaintainerError("accounts must be an array", "INVALID_ACCOUNT_LIST");
    }

    const nextAccounts = [];
    const results = [];
    let changed = false;

    for (const account of sourceAccounts) {
      const result = await this.maintainAccount(account);
      nextAccounts.push(result.account);
      results.push({
        accountId: account?.id || result.account?.id || null,
        account: result.account,
        changed: result.changed,
        actions: result.actions,
      });
      changed = changed || result.changed;
    }

    if (shouldPersist && changed) {
      if (typeof this.accountStore.saveAccounts !== "function") {
        throw new BenefitsMaintainerError("accountStore with saveAccounts() is required to persist changed accounts", "MISSING_ACCOUNT_STORE_SAVE");
      }
      await this.accountStore.saveAccounts(nextAccounts);
    }

    return { accounts: nextAccounts, changed, results };
  }
}
