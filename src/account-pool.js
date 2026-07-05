const BLOCKED_STATUSES = new Set(["disabled", "provisioning", "login_expired", "quota_exhausted", "suspect"]);
const ACCESS_TIER_RANK = new Map([
  ["free", 0],
  ["unknown", 0],
  ["pro", 1],
  ["premium", 1],
]);

export class AccountPoolError extends Error {
  constructor(message, { code = "ACCOUNT_POOL_ERROR", category = "account_pool_error", candidates = [] } = {}) {
    super(message);
    this.name = "AccountPoolError";
    this.code = code;
    this.category = category;
    this.candidates = candidates;
  }
}

function timestampMs(value) {
  if (!value) return null;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(ms) { return new Date(ms).toISOString(); }

export function normalizeAccount(account = {}) {
  return {
    ...account,
    id: String(account.id || ""),
    status: account.status || "active",
    accessTier: account.accessTier || "unknown",
    quotaState: Array.isArray(account.quotaState) ? account.quotaState : [],
    resetCouponCount: Number.isFinite(account.resetCouponCount) ? account.resetCouponCount : 0,
    failureStreak: Number.isFinite(account.failureStreak) ? account.failureStreak : 0,
    audit: Array.isArray(account.audit) ? account.audit : [],
  };
}

function normalizeRequiredAccessTier({ requiresPremium = false, requiredAccessTier = null } = {}) {
  const required = String(requiredAccessTier || "").trim().toLowerCase();
  if (required === "premium") return "pro";
  if (required === "pro") return "pro";
  return requiresPremium ? "pro" : null;
}

function hasRequiredAccessTier(accessTier, requiredAccessTier) {
  if (!requiredAccessTier) return true;
  const currentRank = ACCESS_TIER_RANK.get(String(accessTier || "unknown").toLowerCase()) ?? 0;
  const requiredRank = ACCESS_TIER_RANK.get(requiredAccessTier) ?? 0;
  return currentRank >= requiredRank;
}

export function isAccountSelectable(account, { now = Date.now(), requiresPremium = false, requiredAccessTier = null, excludeAccountIds = [] } = {}) {
  const normalized = normalizeAccount(account);
  const requiredTier = normalizeRequiredAccessTier({ requiresPremium, requiredAccessTier });
  if (excludeAccountIds.includes(normalized.id)) return { selectable: false, reason: "excluded_by_request" };
  if (normalized.status === "cooldown") {
    const until = timestampMs(normalized.cooldownUntil);
    if (until && until > now) return { selectable: false, reason: `cooldown_until_${iso(until)}` };
  } else if (BLOCKED_STATUSES.has(normalized.status)) {
    return { selectable: false, reason: normalized.status === "quota_exhausted" ? "quota_exhausted" : `status_${normalized.status}` };
  }
  if (requiredTier && !hasRequiredAccessTier(normalized.accessTier, requiredTier)) {
    return { selectable: false, reason: "requires_premium" };
  }
  return { selectable: true, reason: "selectable" };
}

export function scoreAccount(account, { now = Date.now() } = {}) {
  const normalized = normalizeAccount(account);
  let score = 100 - normalized.failureStreak * 10;
  const quotaRemaining = normalized.quotaState.map((item) => (Number.isFinite(item?.remaining) ? item.remaining : null)).filter((value) => value !== null);
  if (quotaRemaining.length) score += Math.min(25, Math.max(...quotaRemaining));
  const lastSuccessAt = timestampMs(normalized.lastSuccessAt);
  if (lastSuccessAt) {
    const ageMinutes = Math.max(0, (now - lastSuccessAt) / 60_000);
    score += Math.max(0, 10 - Math.min(10, ageMinutes / 60));
  }
  return score;
}

function defaultCooldownMs(category, failureStreak = 0) {
  if (category === "rate_limited") return 60_000;
  if (category === "upstream_error") return 10_000;
  if (category === "network_error") return Math.min(60_000, 1000 * 2 ** Math.max(0, failureStreak));
  if (category === "unknown") return 60_000;
  return 0;
}

function stateForFailure(category) {
  if (category === "model_entitlement") return "active";
  if (category === "login_required") return "login_expired";
  if (category === "quota_exhausted") return "quota_exhausted";
  if (category === "protocol_changed" || category === "forbidden") return "suspect";
  if (["rate_limited", "upstream_error", "network_error", "unknown"].includes(category)) return "cooldown";
  return "cooldown";
}

function compactLastError(error, cooldownMs) {
  return {
    category: error.category || "unknown",
    message: error.message || "Account request failed.",
    retryable: Boolean(error.retryable),
    cooldownMs,
  };
}

export class AccountPool {
  constructor({ accounts = [], now = () => Date.now() } = {}) {
    this.now = now;
    this.accounts = accounts.map((account) => normalizeAccount(account));
    this.cursor = 0;
  }

  listAccounts() { return this.accounts.map((account) => ({ ...account, audit: [...account.audit] })); }

  getAccount(accountId) {
    const account = this.accounts.find((item) => item.id === accountId);
    return account ? { ...account, audit: [...account.audit] } : null;
  }

  requireAccount(accountId) {
    const index = this.accounts.findIndex((item) => item.id === accountId);
    if (index < 0) throw new AccountPoolError(`Account not found: ${accountId}`, { code: "ACCOUNT_NOT_FOUND", category: "account_not_found" });
    return { index, account: this.accounts[index] };
  }

  replaceAccount(index, account) {
    this.accounts[index] = normalizeAccount(account);
    return this.getAccount(this.accounts[index].id);
  }

  pickAccount({ model, requiresPremium = false, requiredAccessTier = null, excludeAccountIds = [] } = {}) {
    const now = this.now();
    const candidates = this.accounts.map((account, index) => {
      const selectable = isAccountSelectable(account, { now, requiresPremium, requiredAccessTier, excludeAccountIds });
      if (!selectable.selectable) return { accountId: account.id, score: null, excludedReason: selectable.reason, index };
      return { accountId: account.id, score: scoreAccount(account, { now }), index };
    });
    const selectable = candidates.filter((candidate) => candidate.excludedReason === undefined);
    if (!selectable.length) {
      throw new AccountPoolError("No available account can satisfy the request.", {
        code: "NO_AVAILABLE_ACCOUNT", category: "no_available_account", candidates: candidates.map(({ index, ...candidate }) => candidate),
      });
    }
    const rotated = [];
    for (let offset = 0; offset < this.accounts.length; offset += 1) {
      const index = (this.cursor + offset) % this.accounts.length;
      const candidate = selectable.find((item) => item.index === index);
      if (candidate) rotated.push(candidate);
    }
    const bestScore = Math.max(...selectable.map((candidate) => candidate.score));
    const selected = rotated.find((candidate) => candidate.score === bestScore) || rotated[0];
    this.cursor = (selected.index + 1) % this.accounts.length;
    return { account: this.getAccount(selected.accountId), reason: `selected_for_${model || "request"}`, candidates: candidates.map(({ index, ...candidate }) => candidate) };
  }

  recordSuccess(accountId, { requestId = null } = {}) {
    const { index, account } = this.requireAccount(accountId);
    const observedAt = iso(this.now());
    const updated = {
      ...account,
      status: "active",
      failureStreak: 0,
      cooldownUntil: null,
      lastError: null,
      lastSuccessAt: observedAt,
      audit: [...account.audit, { type: "success", requestId, observedAt, fromStatus: account.status, toStatus: "active", reason: "request_succeeded" }],
    };
    return this.replaceAccount(index, updated);
  }

  recordFailure(accountId, error = {}, { requestId = null } = {}) {
    const { index, account } = this.requireAccount(accountId);
    const observedAtMs = this.now();
    const observedAt = iso(observedAtMs);
    const category = error.category || "unknown";
    const toStatus = stateForFailure(category);
    const nextFailureStreak = account.failureStreak + 1;
    const cooldownMs = Number.isFinite(error.cooldownMs) && error.cooldownMs > 0 ? error.cooldownMs : defaultCooldownMs(category, account.failureStreak);
    const updated = {
      ...account,
      status: toStatus,
      failureStreak: nextFailureStreak,
      cooldownUntil: toStatus === "cooldown" && cooldownMs > 0 ? iso(observedAtMs + cooldownMs) : null,
      lastError: compactLastError(error, cooldownMs),
      audit: [...account.audit, { type: "failure", requestId, observedAt, fromStatus: account.status, toStatus, reason: category }],
    };
    return this.replaceAccount(index, updated);
  }

  shouldFallback({ error = {}, attemptedAccountIds = [], model = "tabbit/priority", retryCount = 0, retryLimit = 1, requiresPremium = false, requiredAccessTier = null } = {}) {
    const category = error.category || "unknown";
    if (!error.retryable || ["protocol_changed", "login_required", "forbidden"].includes(category)) {
      return { fallback: false, reason: `global_or_non_retryable_${category}` };
    }
    if (retryCount >= retryLimit) {
      return { fallback: false, reason: "retry_budget_exhausted" };
    }
    const savedCursor = this.cursor;
    try {
      const picked = this.pickAccount({ model, requiresPremium, requiredAccessTier, excludeAccountIds: attemptedAccountIds });
      return { fallback: true, reason: `retryable_${category}`, nextAccount: picked.account, candidates: picked.candidates };
    } catch (candidateError) {
      if (candidateError instanceof AccountPoolError && candidateError.code === "NO_AVAILABLE_ACCOUNT") {
        return { fallback: false, reason: "no_candidate_account" };
      }
      throw candidateError;
    } finally {
      this.cursor = savedCursor;
    }
  }
}
