import test from "node:test";
import assert from "node:assert/strict";

import { AccountProvisioner, AccountProvisionerError, extractSessionSecret } from "../src/account-provisioner.js";

const FIXED_NOW = "2026-07-02T10:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function memoryAccountStore(initialAccounts = [], events = []) {
  let accounts = clone(initialAccounts);
  return {
    get accounts() {
      return clone(accounts);
    },
    events,
    async loadAccounts() {
      return clone(accounts);
    },
    async saveAccounts(nextAccounts) {
      accounts = clone(nextAccounts);
      events.push(["saveAccounts", accounts.map((account) => [account.id, account.status])]);
      return clone(accounts);
    },
    async updateAccounts(mutator) {
      const next = await mutator(clone(accounts));
      return await this.saveAccounts(next);
    },
  };
}

function memorySecretStore(events = [], { failWrite = false } = {}) {
  const secrets = new Map();
  return {
    events,
    writes: [],
    async writeSecret(ref, value) {
      events.push(["writeSecret", ref]);
      if (failWrite) throw Object.assign(new Error("disk full while writing cookie=secret"), { code: "EIO" });
      secrets.set(ref, String(value));
      this.writes.push({ ref, value: String(value) });
      return ref;
    },
    async readSecret(ref) {
      events.push(["readSecret", ref]);
      return secrets.has(ref) ? secrets.get(ref) : null;
    },
  };
}

function provisionerOptions(overrides = {}) {
  const events = overrides.events || [];
  return {
    accountStore: overrides.accountStore || memoryAccountStore([], events),
    secretStore: overrides.secretStore || memorySecretStore(events),
    idGenerator: overrides.idGenerator || (() => "acct_new"),
    now: () => new Date(FIXED_NOW),
    ...overrides,
  };
}

test("extractSessionSecret accepts known session fields without coercing missing values", () => {
  assert.equal(extractSessionSecret({ cookieHeader: "tabbit_session=cookie" }), "tabbit_session=cookie");
  assert.equal(extractSessionSecret({ cookieJar: [{ name: "sid", value: "abc" }] }), JSON.stringify([{ name: "sid", value: "abc" }]));
  assert.equal(extractSessionSecret({ session: "session-token" }), "session-token");
  assert.equal(extractSessionSecret({ token: "token-value" }), "token-value");
  assert.equal(extractSessionSecret({}), null);
});

test("createAccount orchestrates inbox, code submission, secret storage, and active account persistence", async () => {
  const events = [];
  const accountStore = memoryAccountStore([], events);
  const secretStore = memorySecretStore(events);
  const provisioner = new AccountProvisioner(provisionerOptions({
    events,
    accountStore,
    secretStore,
    mailProvider: {
      async createInbox(input) {
        events.push(["createInbox", input.localPartPrefix]);
        return { id: "inbox_1", address: "new-user@example.test" };
      },
      async waitForVerificationCode({ inbox, timeoutMs }) {
        events.push(["waitForVerificationCode", inbox.address, timeoutMs]);
        return { code: "123456", messageId: "msg_1" };
      },
    },
    protocolClient: {
      async sendVerificationCode({ email }) {
        events.push(["sendVerificationCode", email]);
        return { ok: true };
      },
      async submitRegistrationOrLogin({ email, code }) {
        events.push(["submitRegistrationOrLogin", email, code]);
        return { cookieHeader: "tabbit_session=secret-cookie", userId: "user_1", accessTier: "free" };
      },
    },
    benefitsMaintainer: {
      async maintainAccount(account) {
        events.push(["initializeBenefits", account.id]);
        return {
          account: { ...account, accessTier: "pro", proClaimed: true },
          changed: true,
          actions: [{ name: "refreshQuota", status: "success", changed: true }],
        };
      },
    },
  }));

  const result = await provisioner.createAccount({ localPartPrefix: "new-user", timeoutMs: 5000 });

  assert.equal(result.changed, true);
  assert.equal(result.account.id, "acct_new");
  assert.equal(result.account.status, "active");
  assert.equal(result.account.email, "new-user@example.test");
  assert.equal(result.account.userId, "user_1");
  assert.equal(result.account.accessTier, "pro");
  assert.equal(result.account.proClaimed, true);
  assert.equal(result.account.cookieJarRef, "secrets/acct_new.cookie");
  assert.deepEqual(result.actions.map((item) => [item.name, item.status]), [
    ["createInbox", "success"],
    ["sendVerificationCode", "success"],
    ["waitForVerificationCode", "success"],
    ["submitRegistrationOrLogin", "success"],
    ["saveSession", "success"],
    ["initializeBenefits", "success"],
  ]);

  const eventNames = events.map((event) => event[0]);
  assert.deepEqual(eventNames, [
    "createInbox",
    "saveAccounts",
    "sendVerificationCode",
    "waitForVerificationCode",
    "submitRegistrationOrLogin",
    "writeSecret",
    "initializeBenefits",
    "saveAccounts",
  ]);
  assert.ok(eventNames.indexOf("writeSecret") < eventNames.lastIndexOf("saveAccounts"));
  assert.deepEqual(secretStore.writes, [{ ref: "secrets/acct_new.cookie", value: "tabbit_session=secret-cookie" }]);

  const [stored] = accountStore.accounts;
  assert.equal(stored.status, "active");
  assert.equal(stored.cookieJarRef, "secrets/acct_new.cookie");
  assert.equal(stored.cookieHeader, undefined);
  assert.equal(stored.cookie, undefined);
  assert.equal(stored.session, undefined);
  assert.equal(stored.token, undefined);
});

test("createAccount keeps provisioning account and redacts timeout errors", async () => {
  const events = [];
  const accountStore = memoryAccountStore([], events);
  const secretStore = memorySecretStore(events);
  const provisioner = new AccountProvisioner(provisionerOptions({
    events,
    accountStore,
    secretStore,
    mailProvider: {
      async createInbox() {
        events.push(["createInbox"]);
        return { id: "inbox_timeout", address: "timeout-user@example.test" };
      },
      async waitForVerificationCode() {
        events.push(["waitForVerificationCode"]);
        throw Object.assign(new Error("timeout waiting for 123456 sent to timeout-user@example.test with token secret-token"), {
          code: "MAIL_TIMEOUT",
          category: "mail_timeout",
        });
      },
    },
    protocolClient: {
      async sendVerificationCode() {
        events.push(["sendVerificationCode"]);
        return { ok: true };
      },
    },
  }));

  const result = await provisioner.createAccount({ timeoutMs: 1000 });

  assert.equal(result.changed, true);
  assert.equal(result.account.status, "provisioning");
  assert.equal(result.actions.at(-1).name, "waitForVerificationCode");
  assert.equal(result.actions.at(-1).status, "failed");
  assert.equal(result.actions.at(-1).error.code, "MAIL_TIMEOUT");
  assert.doesNotMatch(result.actions.at(-1).error.message, /123456/);
  assert.doesNotMatch(result.actions.at(-1).error.message, /timeout-user@example\.test/);
  assert.equal(secretStore.writes.length, 0);
  assert.equal(accountStore.accounts[0].status, "provisioning");
  assert.equal(accountStore.accounts[0].lastError.code, "MAIL_TIMEOUT");
});

test("createAccount marks suspect when registration succeeds without session material", async () => {
  const events = [];
  const accountStore = memoryAccountStore([], events);
  const secretStore = memorySecretStore(events);
  const provisioner = new AccountProvisioner(provisionerOptions({
    events,
    accountStore,
    secretStore,
    mailProvider: {
      async createInbox() {
        return { id: "inbox_missing_session", address: "missing@example.test" };
      },
      async waitForVerificationCode() {
        return { code: "654321" };
      },
    },
    protocolClient: {
      async sendVerificationCode() {
        return { ok: true };
      },
      async submitRegistrationOrLogin() {
        return { userId: "user_without_cookie", accessTier: "free" };
      },
    },
  }));

  const result = await provisioner.createAccount({ timeoutMs: 1000 });

  assert.equal(result.account.status, "suspect");
  assert.equal(result.actions.at(-1).name, "saveSession");
  assert.equal(result.actions.at(-1).status, "failed");
  assert.equal(result.actions.at(-1).error.code, "SESSION_MISSING");
  assert.equal(secretStore.writes.length, 0);
  assert.equal(accountStore.accounts[0].status, "suspect");
  assert.equal(accountStore.accounts[0].cookieJarRef, undefined);
});

test("importSession writes session secrets before saving active metadata", async () => {
  const events = [];
  const accountStore = memoryAccountStore([], events);
  const secretStore = memorySecretStore(events);
  const provisioner = new AccountProvisioner(provisionerOptions({ events, accountStore, secretStore }));

  const result = await provisioner.importSession({
    accountId: "acct_imported",
    email: "imported@example.test",
    cookieHeader: "tabbit_session=imported-secret",
    userId: "user_imported",
    accessTier: "premium",
  });

  assert.equal(result.changed, true);
  assert.equal(result.account.status, "active");
  assert.equal(result.account.cookieJarRef, "secrets/acct_imported.cookie");
  assert.deepEqual(result.actions.map((item) => [item.name, item.status]), [["saveSession", "success"]]);
  assert.deepEqual(events.map((event) => event[0]), ["writeSecret", "saveAccounts"]);
  assert.deepEqual(secretStore.writes, [{ ref: "secrets/acct_imported.cookie", value: "tabbit_session=imported-secret" }]);
  assert.equal(accountStore.accounts[0].cookieHeader, undefined);
});

test("importSession fails without session material and does not persist active account when secret write fails", async () => {
  const accountStore = memoryAccountStore();
  const provisioner = new AccountProvisioner(provisionerOptions({ accountStore, secretStore: memorySecretStore() }));

  const missing = await provisioner.importSession({ accountId: "acct_missing", email: "missing@example.test" });
  assert.equal(missing.changed, false);
  assert.equal(missing.account, null);
  assert.equal(missing.actions[0].status, "failed");
  assert.equal(missing.actions[0].error.code, "SESSION_MISSING");
  assert.equal(accountStore.accounts.length, 0);

  const failEvents = [];
  const failingStore = memoryAccountStore([], failEvents);
  const failingSecrets = memorySecretStore(failEvents, { failWrite: true });
  const failingProvisioner = new AccountProvisioner(provisionerOptions({ events: failEvents, accountStore: failingStore, secretStore: failingSecrets }));

  const failed = await failingProvisioner.importSession({ accountId: "acct_eio", email: "eio@example.test", cookieHeader: "cookie=secret" });
  assert.equal(failed.changed, false);
  assert.equal(failed.actions[0].status, "failed");
  assert.equal(failed.actions[0].error.code, "EIO");
  assert.equal(failingStore.accounts.length, 0);
});

test("resumeProvisioning skips non-provisioning accounts and missing protocol hooks", async () => {
  const accountStore = memoryAccountStore([
    { id: "acct_active", status: "active", email: "active@example.test" },
    { id: "acct_pending", status: "provisioning", email: "pending@example.test" },
  ]);
  const provisioner = new AccountProvisioner(provisionerOptions({ accountStore, secretStore: memorySecretStore(), protocolClient: {} }));

  const active = await provisioner.resumeProvisioning("acct_active");
  assert.equal(active.changed, false);
  assert.equal(active.actions[0].status, "skipped");
  assert.match(active.actions[0].detail, /not provisioning/);

  const pending = await provisioner.resumeProvisioning("acct_pending");
  assert.equal(pending.changed, false);
  assert.equal(pending.actions[0].status, "skipped");
  assert.match(pending.actions[0].detail, /not configured/);
});

test("verifyAccount reads stored session and updates account status from verifier result", async () => {
  const events = [];
  const accountStore = memoryAccountStore([{ id: "acct_verify", status: "login_expired", email: "verify@example.test", cookieJarRef: "secrets/acct_verify.cookie" }], events);
  const secretStore = memorySecretStore(events);
  await secretStore.writeSecret("secrets/acct_verify.cookie", "tabbit_session=verify-secret");
  events.length = 0;

  const provisioner = new AccountProvisioner(provisionerOptions({
    events,
    accountStore,
    secretStore,
    protocolClient: {
      async verifySession({ account, session }) {
        events.push(["verifySession", account.id, session]);
        return { ok: true, userId: "verified_user", accessTier: "pro" };
      },
    },
  }));

  const result = await provisioner.verifyAccount("acct_verify");

  assert.equal(result.changed, true);
  assert.equal(result.account.status, "active");
  assert.equal(result.account.userId, "verified_user");
  assert.equal(result.account.accessTier, "pro");
  assert.deepEqual(events.map((event) => event[0]), ["readSecret", "verifySession", "saveAccounts"]);
});

test("verifyAccount honors verifier accountStatus on failed checks", async () => {
  const store = memoryAccountStore([{ id: "acct_suspect", status: "active", cookieJarRef: "secrets/acct_suspect.cookie" }]);
  const secretStore = memorySecretStore();
  await secretStore.writeSecret("secrets/acct_suspect.cookie", "tabbit_session=verify-secret");
  const provisioner = new AccountProvisioner({
    accountStore: store,
    secretStore,
    protocolClient: {
      async verifySession() {
        return {
          ok: false,
          category: "protocol_missing",
          code: "MISSING_SESSION_VERIFY_PATH",
          message: "verification endpoint missing",
          accountStatus: "suspect",
        };
      },
    },
    now: () => new Date("2026-07-02T05:00:00.000Z"),
  });

  const result = await provisioner.verifyAccount("acct_suspect");

  assert.equal(result.changed, true);
  assert.equal(result.account.status, "suspect");
  assert.equal(result.account.lastError.category, "protocol_missing");
});

test("verifyAccount marks login_expired when stored session is missing", async () => {
  const accountStore = memoryAccountStore([{ id: "acct_missing_secret", status: "active", email: "missing@example.test", cookieJarRef: "secrets/missing.cookie" }]);
  const provisioner = new AccountProvisioner(provisionerOptions({ accountStore, secretStore: memorySecretStore(), protocolClient: {} }));

  const result = await provisioner.verifyAccount("acct_missing_secret");

  assert.equal(result.changed, true);
  assert.equal(result.account.status, "login_expired");
  assert.equal(result.actions[0].status, "failed");
  assert.equal(result.actions[0].error.code, "SESSION_MISSING");
  assert.equal(accountStore.accounts[0].status, "login_expired");
});

test("AccountProvisioner validates required account and secret stores", () => {
  assert.throws(() => new AccountProvisioner(), AccountProvisionerError);
  assert.throws(() => new AccountProvisioner({ accountStore: memoryAccountStore() }), AccountProvisionerError);
  assert.throws(() => new AccountProvisioner({ secretStore: memorySecretStore() }), AccountProvisionerError);
});
