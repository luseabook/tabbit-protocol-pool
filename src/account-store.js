import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { AccountPool, normalizeAccount } from "./account-pool.js";

const STORE_VERSION = 1;
const SECRET_FIELD_NAMES = new Set([
  "apikey",
  "authorization",
  "cookie",
  "cookieheader",
  "password",
  "secret",
  "session",
  "sessiontoken",
  "token",
]);

export class AccountStoreError extends Error {
  constructor(message, { code = "ACCOUNT_STORE_ERROR", cause = null } = {}) {
    super(message);
    this.name = "AccountStoreError";
    this.code = code;
    if (cause) this.cause = cause;
  }
}

export function resolveAccountStorePath({ stateDir, filePath } = {}) {
  if (filePath) return filePath;
  if (!stateDir) throw new AccountStoreError("stateDir or filePath is required", { code: "MISSING_ACCOUNT_STORE_PATH" });
  return path.join(stateDir, "accounts.json");
}

function isDirectSecretField(key) {
  return SECRET_FIELD_NAMES.has(String(key || "").toLowerCase());
}

export function sanitizeAccountForStorage(account = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(account || {})) {
    if (isDirectSecretField(key)) continue;
    clean[key] = value;
  }
  return normalizeAccount(clean);
}

function accountArrayFromDocument(document) {
  if (Array.isArray(document)) return document;
  if (document && typeof document === "object" && Array.isArray(document.accounts)) return document.accounts;
  throw new AccountStoreError("Account store document must contain an accounts array", { code: "INVALID_ACCOUNT_STORE_SHAPE" });
}

export function normalizeAccountStoreDocument(document = {}) {
  return {
    version: STORE_VERSION,
    updatedAt: typeof document?.updatedAt === "string" ? document.updatedAt : null,
    accounts: accountArrayFromDocument(document).map((account) => sanitizeAccountForStorage(account)),
  };
}

function isNotFound(error) {
  return error?.code === "ENOENT";
}

export class JsonAccountStore {
  constructor({ stateDir, filePath, fs: fsImpl = fs, now = () => new Date().toISOString() } = {}) {
    this.filePath = resolveAccountStorePath({ stateDir, filePath });
    this.fs = fsImpl;
    this.now = now;
  }

  async loadDocument() {
    let text;
    try {
      text = await this.fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return { version: STORE_VERSION, updatedAt: null, accounts: [] };
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AccountStoreError("Account store file is not valid JSON", { code: "INVALID_ACCOUNT_STORE_JSON", cause: error });
    }
    return normalizeAccountStoreDocument(parsed);
  }

  async loadAccounts() {
    return (await this.loadDocument()).accounts;
  }

  async saveAccounts(accounts = []) {
    if (!Array.isArray(accounts)) {
      throw new AccountStoreError("accounts must be an array", { code: "INVALID_ACCOUNT_LIST" });
    }
    const normalized = accounts.map((account) => sanitizeAccountForStorage(account));
    const document = { version: STORE_VERSION, updatedAt: this.now(), accounts: normalized };
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await this.fs.writeFile(tmpPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await this.fs.rename(tmpPath, this.filePath);
    return normalized;
  }

  async updateAccounts(mutator) {
    if (typeof mutator !== "function") {
      throw new AccountStoreError("account mutator must be a function", { code: "INVALID_ACCOUNT_MUTATOR" });
    }
    const current = await this.loadAccounts();
    const next = await mutator(current.map((account) => ({ ...account, audit: [...account.audit] })));
    if (!Array.isArray(next)) {
      throw new AccountStoreError("account mutator must return an account array", { code: "INVALID_ACCOUNT_LIST" });
    }
    return await this.saveAccounts(next);
  }
}

export class StoredAccountPool extends AccountPool {
  constructor({ store, accounts = [], now = () => Date.now() } = {}) {
    if (!store || typeof store.loadAccounts !== "function" || typeof store.saveAccounts !== "function") {
      throw new AccountStoreError("store with loadAccounts() and saveAccounts() is required", { code: "MISSING_ACCOUNT_STORE" });
    }
    super({ accounts, now });
    this.store = store;
  }

  static async load({ store, now = () => Date.now() } = {}) {
    if (!store || typeof store.loadAccounts !== "function") {
      throw new AccountStoreError("store with loadAccounts() is required", { code: "MISSING_ACCOUNT_STORE" });
    }
    return new StoredAccountPool({ store, accounts: await store.loadAccounts(), now });
  }

  async persist() {
    await this.store.saveAccounts(this.listAccounts());
  }

  async recordSuccess(accountId, options = {}) {
    const updated = super.recordSuccess(accountId, options);
    await this.persist();
    return updated;
  }

  async recordFailure(accountId, error = {}, options = {}) {
    const updated = super.recordFailure(accountId, error, options);
    await this.persist();
    return updated;
  }
}
