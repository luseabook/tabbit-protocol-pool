import { randomUUID } from "node:crypto";

import { normalizeAccount } from "./account-pool.js";
import { redactSensitiveValue } from "./redact.js";

const DIRECT_SECRET_FIELDS = new Set([
  "apiKey",
  "apikey",
  "authorization",
  "cookie",
  "cookieHeader",
  "cookieJar",
  "password",
  "secret",
  "session",
  "sessionToken",
  "token",
]);

export class AccountProvisionerError extends Error {
  constructor(message, code = "ACCOUNT_PROVISIONER_ERROR") {
    super(message);
    this.name = "AccountProvisionerError";
    this.code = code;
  }
}

function nowDate(now) {
  const value = typeof now === "function" ? now() : now;
  return value instanceof Date ? value : new Date(value || Date.now());
}

function sanitizeErrorMessage(message) {
  return redactSensitiveValue(message).replace(/\b\d{4,8}\b/g, "***");
}

function verifierAccountStatus(result, fallback = "login_expired") {
  return typeof result?.accountStatus === "string" && result.accountStatus
    ? result.accountStatus
    : (typeof result?.status === "string" && result.status ? result.status : fallback);
}

function errorSummary(error, fallback = "Provisioning operation failed.") {
  return {
    message: sanitizeErrorMessage(error?.message || String(error || fallback)),
    ...(error?.code ? { code: String(error.code) } : {}),
    ...(error?.category ? { category: String(error.category) } : {}),
  };
}

function provisionerError(message, { code, category } = {}) {
  return Object.assign(new Error(message), {
    ...(code ? { code } : {}),
    ...(category ? { category } : {}),
  });
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

function stripDirectSecrets(account = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(account)) {
    if (!DIRECT_SECRET_FIELDS.has(key)) clean[key] = value;
  }
  return clean;
}

function cloneAccount(account) {
  const normalized = normalizeAccount(stripDirectSecrets(account || {}));
  return { ...normalized, audit: Array.isArray(normalized.audit) ? [...normalized.audit] : [] };
}

function addAudit(account, entry) {
  return {
    ...account,
    audit: [...(Array.isArray(account.audit) ? account.audit : []), entry],
  };
}

function missingOperation(name) {
  return provisionerError(`protocol operation is not configured: ${name}`, {
    code: "PROTOCOL_OPERATION_MISSING",
    category: "protocol_missing",
  });
}

function accountIdFrom(input = {}, idGenerator) {
  const explicit = String(input.accountId || input.id || "").trim();
  if (explicit) return explicit;
  const generated = typeof idGenerator === "function" ? idGenerator(input) : null;
  return String(generated || `acct_${randomUUID()}`);
}

function defaultSecretRef(accountId) {
  return `secrets/${accountId}.cookie`;
}

function ensureStore(accountStore) {
  return accountStore
    && typeof accountStore.loadAccounts === "function"
    && typeof accountStore.saveAccounts === "function";
}

function ensureSecretStore(secretStore) {
  return secretStore
    && typeof secretStore.writeSecret === "function"
    && typeof secretStore.readSecret === "function";
}

export function extractSessionSecret(result = {}) {
  if (typeof result?.cookieHeader === "string" && result.cookieHeader) return result.cookieHeader;
  if (result?.cookieJar !== undefined && result.cookieJar !== null) {
    return typeof result.cookieJar === "string" ? result.cookieJar : JSON.stringify(result.cookieJar);
  }
  if (typeof result?.cookie === "string" && result.cookie) return result.cookie;
  if (typeof result?.session === "string" && result.session) return result.session;
  if (typeof result?.sessionToken === "string" && result.sessionToken) return result.sessionToken;
  if (typeof result?.token === "string" && result.token) return result.token;
  return null;
}

export class AccountProvisioner {
  constructor({
    accountStore,
    secretStore,
    mailProvider = {},
    protocolClient = {},
    benefitsMaintainer = null,
    now = () => new Date(),
    idGenerator = null,
    secretRefGenerator = defaultSecretRef,
  } = {}) {
    if (!ensureStore(accountStore)) {
      throw new AccountProvisionerError("accountStore with loadAccounts() and saveAccounts() is required", "MISSING_ACCOUNT_STORE");
    }
    if (!ensureSecretStore(secretStore)) {
      throw new AccountProvisionerError("secretStore with readSecret() and writeSecret() is required", "MISSING_SECRET_STORE");
    }
    this.accountStore = accountStore;
    this.secretStore = secretStore;
    this.mailProvider = mailProvider || {};
    this.protocolClient = protocolClient || {};
    this.benefitsMaintainer = benefitsMaintainer;
    this.now = now;
    this.idGenerator = idGenerator;
    this.secretRefGenerator = secretRefGenerator;
  }

  nowIso() {
    return nowDate(this.now).toISOString();
  }

  secretRefFor(account, input = {}) {
    if (input.cookieJarRef) return String(input.cookieJarRef);
    return String(this.secretRefGenerator(account.id, account, input));
  }

  async loadAccounts() {
    return (await this.accountStore.loadAccounts()).map((account) => cloneAccount(account));
  }

  async saveAccounts(accounts) {
    return await this.accountStore.saveAccounts(accounts.map((account) => cloneAccount(account)));
  }

  async upsertAccount(account) {
    const clean = cloneAccount(account);
    const current = await this.loadAccounts();
    const index = current.findIndex((item) => item.id === clean.id);
    if (index >= 0) current[index] = clean;
    else current.push(clean);
    await this.saveAccounts(current);
    return clean;
  }

  async findAccount(accountId) {
    const accounts = await this.loadAccounts();
    return accounts.find((account) => account.id === accountId) || null;
  }

  async markFailure(account, stage, error, { status = "provisioning" } = {}) {
    const observedAt = this.nowIso();
    const failed = cloneAccount(addAudit({
      ...account,
      status,
      lastProvisioningStage: stage,
      lastError: {
        ...errorSummary(error),
        stage,
      },
    }, {
      type: "provisioning_failure",
      stage,
      observedAt,
      code: error?.code || "PROVISIONING_FAILED",
    }));
    await this.upsertAccount(failed);
    return failed;
  }

  async createAccount(input = {}) {
    const actions = [];
    let account = null;
    let inbox;

    try {
      if (typeof this.mailProvider.createInbox !== "function") {
        throw provisionerError("mailProvider.createInbox is not configured", { code: "MAIL_OPERATION_MISSING", category: "mail_missing" });
      }
      inbox = await this.mailProvider.createInbox({
        localPartPrefix: input.localPartPrefix,
        domain: input.domain,
        subdomain: input.subdomain,
      });
      actions.push(action("createInbox", "success", { changed: true }));
    } catch (error) {
      actions.push(action("createInbox", "failed", { error: errorSummary(error) }));
      return { account: null, changed: false, actions };
    }

    const email = String(inbox?.address || input.email || "");
    const accountId = accountIdFrom({ ...input, email, inbox }, this.idGenerator);
    const observedAt = this.nowIso();
    account = cloneAccount(addAudit({
      id: accountId,
      email,
      status: "provisioning",
      accessTier: "unknown",
      createdAt: observedAt,
      lastProvisioningStage: "createInbox",
    }, { type: "provisioning_started", stage: "createInbox", observedAt }));
    await this.upsertAccount(account);

    try {
      if (typeof this.protocolClient.sendVerificationCode !== "function") throw missingOperation("sendVerificationCode");
      await this.protocolClient.sendVerificationCode({ account: cloneAccount(account), inbox, email, input });
      actions.push(action("sendVerificationCode", "success", { changed: false }));
    } catch (error) {
      const failed = await this.markFailure(account, "sendVerificationCode", error);
      actions.push(action("sendVerificationCode", "failed", { error: errorSummary(error) }));
      return { account: failed, changed: true, actions };
    }

    let verification;
    try {
      if (typeof this.mailProvider.waitForVerificationCode !== "function") {
        throw provisionerError("mailProvider.waitForVerificationCode is not configured", { code: "MAIL_OPERATION_MISSING", category: "mail_missing" });
      }
      verification = await this.mailProvider.waitForVerificationCode({ inbox, email, timeoutMs: input.timeoutMs });
      if (!verification?.code && typeof verification !== "string") {
        throw provisionerError("verification code was not found in mail result", { code: "VERIFICATION_CODE_MISSING", category: "mail_parse_failed" });
      }
      actions.push(action("waitForVerificationCode", "success", { changed: false }));
    } catch (error) {
      const failed = await this.markFailure(account, "waitForVerificationCode", error);
      actions.push(action("waitForVerificationCode", "failed", { error: errorSummary(error) }));
      return { account: failed, changed: true, actions };
    }

    const code = typeof verification === "string" ? verification : verification.code;
    let registration;
    try {
      if (typeof this.protocolClient.submitRegistrationOrLogin !== "function") throw missingOperation("submitRegistrationOrLogin");
      registration = await this.protocolClient.submitRegistrationOrLogin({
        account: cloneAccount(account),
        inbox,
        email,
        code,
        verification,
        input,
      });
      actions.push(action("submitRegistrationOrLogin", "success", { changed: false }));
    } catch (error) {
      const failed = await this.markFailure(account, "submitRegistrationOrLogin", error);
      actions.push(action("submitRegistrationOrLogin", "failed", { error: errorSummary(error) }));
      return { account: failed, changed: true, actions };
    }

    const secret = extractSessionSecret(registration);
    if (!secret) {
      const error = provisionerError("registration response did not include session material", {
        code: "SESSION_MISSING",
        category: "session_missing",
      });
      const failed = await this.markFailure(account, "saveSession", error, { status: "suspect" });
      actions.push(action("saveSession", "failed", { error: errorSummary(error) }));
      return { account: failed, changed: true, actions };
    }

    const cookieJarRef = registration?.cookieJarRef || this.secretRefFor(account, input);
    try {
      await this.secretStore.writeSecret(cookieJarRef, secret);
      actions.push(action("saveSession", "success", { changed: true }));
    } catch (error) {
      const failed = await this.markFailure(account, "saveSession", error);
      actions.push(action("saveSession", "failed", { error: errorSummary(error) }));
      return { account: failed, changed: true, actions };
    }

    account = cloneAccount(addAudit({
      ...account,
      status: "active",
      cookieJarRef,
      userId: registration?.userId || account.userId || null,
      accessTier: registration?.accessTier || account.accessTier || "unknown",
      lastProvisionedAt: this.nowIso(),
      lastProvisioningStage: "saveSession",
      lastError: null,
    }, { type: "provisioning_stage", stage: "saveSession", observedAt: this.nowIso() }));

    if (this.benefitsMaintainer && typeof this.benefitsMaintainer.maintainAccount === "function") {
      try {
        const maintained = await this.benefitsMaintainer.maintainAccount(account);
        account = cloneAccount(maintained?.account || account);
        actions.push(action("initializeBenefits", "success", { changed: Boolean(maintained?.changed) }));
      } catch (error) {
        account = cloneAccount({
          ...account,
          lastError: { ...errorSummary(error), stage: "initializeBenefits" },
        });
        actions.push(action("initializeBenefits", "failed", { error: errorSummary(error) }));
      }
    }

    account = await this.upsertAccount(account);
    return { account, changed: true, actions };
  }

  async importSession(input = {}) {
    const actions = [];
    const secret = extractSessionSecret(input);
    if (!secret) {
      const error = provisionerError("session material is required", { code: "SESSION_MISSING", category: "session_missing" });
      actions.push(action("saveSession", "failed", { error: errorSummary(error) }));
      return { account: null, changed: false, actions };
    }

    const accountId = accountIdFrom(input, this.idGenerator);
    const baseAccount = cloneAccount({
      id: accountId,
      email: input.email || null,
      status: "active",
      userId: input.userId || null,
      accessTier: input.accessTier || "unknown",
      importedAt: this.nowIso(),
    });
    const cookieJarRef = this.secretRefFor(baseAccount, input);

    try {
      await this.secretStore.writeSecret(cookieJarRef, secret);
    } catch (error) {
      actions.push(action("saveSession", "failed", { error: errorSummary(error) }));
      return { account: null, changed: false, actions };
    }

    const account = await this.upsertAccount({
      ...baseAccount,
      cookieJarRef,
      lastProvisionedAt: this.nowIso(),
    });
    actions.push(action("saveSession", "success", { changed: true }));
    return { account, changed: true, actions };
  }

  async resumeProvisioning(accountId) {
    const account = await this.findAccount(accountId);
    if (!account) {
      const error = provisionerError(`account not found: ${accountId}`, { code: "ACCOUNT_NOT_FOUND", category: "account_not_found" });
      return { account: null, changed: false, actions: [action("resumeProvisioning", "failed", { error: errorSummary(error) })] };
    }
    if (account.status !== "provisioning") {
      return {
        account,
        changed: false,
        actions: [action("resumeProvisioning", "skipped", { detail: "account is not provisioning" })],
      };
    }
    if (typeof this.protocolClient.resumeProvisioning !== "function") {
      return {
        account,
        changed: false,
        actions: [action("resumeProvisioning", "skipped", { detail: "protocol operation is not configured" })],
      };
    }

    try {
      const result = await this.protocolClient.resumeProvisioning({ account: cloneAccount(account) });
      if (result?.account) {
        const updated = await this.upsertAccount(result.account);
        return { account: updated, changed: true, actions: [action("resumeProvisioning", "success", { changed: true })] };
      }
      return { account, changed: false, actions: [action("resumeProvisioning", "skipped", { detail: "resume hook returned no account changes" })] };
    } catch (error) {
      const failed = await this.markFailure(account, "resumeProvisioning", error);
      return { account: failed, changed: true, actions: [action("resumeProvisioning", "failed", { error: errorSummary(error) })] };
    }
  }

  async verifyAccount(accountId) {
    const account = await this.findAccount(accountId);
    if (!account) {
      const error = provisionerError(`account not found: ${accountId}`, { code: "ACCOUNT_NOT_FOUND", category: "account_not_found" });
      return { account: null, changed: false, actions: [action("verifySession", "failed", { error: errorSummary(error) })] };
    }

    const session = account.cookieJarRef ? await this.secretStore.readSecret(account.cookieJarRef) : null;
    if (!session) {
      const error = provisionerError("stored session material is missing", { code: "SESSION_MISSING", category: "session_missing" });
      const updated = await this.upsertAccount({
        ...account,
        status: "login_expired",
        lastVerifiedAt: this.nowIso(),
        lastError: { ...errorSummary(error), stage: "verifySession" },
      });
      return { account: updated, changed: true, actions: [action("verifySession", "failed", { error: errorSummary(error) })] };
    }

    if (typeof this.protocolClient.verifySession !== "function") {
      return {
        account,
        changed: false,
        actions: [action("verifySession", "skipped", { detail: "protocol operation is not configured" })],
      };
    }

    try {
      const result = await this.protocolClient.verifySession({ account: cloneAccount(account), session });
      if (result?.ok === false) {
        const error = provisionerError(result.message || "session verification failed", {
          code: result.code || "SESSION_INVALID",
          category: result.category || "login_required",
        });
        const updated = await this.upsertAccount({
          ...account,
          status: verifierAccountStatus(result),
          lastVerifiedAt: this.nowIso(),
          lastError: { ...errorSummary(error), stage: "verifySession" },
        });
        return { account: updated, changed: true, actions: [action("verifySession", "failed", { error: errorSummary(error) })] };
      }

      const updated = await this.upsertAccount({
        ...account,
        status: "active",
        userId: result?.userId || account.userId || null,
        accessTier: result?.accessTier || account.accessTier || "unknown",
        lastVerifiedAt: this.nowIso(),
        lastError: null,
      });
      return { account: updated, changed: true, actions: [action("verifySession", "success", { changed: true })] };
    } catch (error) {
      const status = error?.category === "login_required" ? "login_expired" : "suspect";
      const updated = await this.upsertAccount({
        ...account,
        status,
        lastVerifiedAt: this.nowIso(),
        lastError: { ...errorSummary(error), stage: "verifySession" },
      });
      return { account: updated, changed: true, actions: [action("verifySession", "failed", { error: errorSummary(error) })] };
    }
  }
}
