import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileProtocolFixtureStore,
  ProtocolProbeRunner,
  buildProtocolProbeFixture,
} from "../src/protocol-probe.js";

const NOW = "2026-07-02T03:00:00.000Z";

function memoryAccountStore(accounts = []) {
  return {
    async loadAccounts() {
      return JSON.parse(JSON.stringify(accounts));
    },
  };
}

function memorySecretStore(secrets = {}) {
  return {
    async readSecret(ref) {
      return Object.prototype.hasOwnProperty.call(secrets, ref) ? secrets[ref] : null;
    },
  };
}

function memoryFixtureStore(events = []) {
  return {
    async writeFixture(fixture) {
      events.push(["writeFixture", JSON.parse(JSON.stringify(fixture))]);
      return "fixtures/protocol-probes/probe.json";
    },
  };
}

test("buildProtocolProbeFixture redacts sensitive request, response, and error fields", () => {
  const fixture = buildProtocolProbeFixture({
    observedAt: NOW,
    accountId: "acct_a",
    operation: "verifySession",
    status: "failed",
    account: {
      id: "acct_a",
      email: "alpha-user@example.test",
      status: "active",
      cookieJarRef: "secrets\/acct_a\.cookie",
      cookieHeader: "tabbit_session=secret-cookie",
      token: "secret-token",
    },
    input: {
      email: "alpha-user@example.test",
      authorization: "Bearer secret-token-123",
      code: "123456",
      session: "tabbit_session=secret-cookie",
    },
    result: {
      ok: false,
      token: "secret-token",
      message: "alpha-user@example.test token=secret code 123456",
    },
    error: {
      category: "login_required",
      code: "LOGIN",
      status: 401,
      message: "alpha-user@example.test token=secret code 123456",
    },
  });

  const serialized = JSON.stringify(fixture);
  assert.equal(fixture.version, 1);
  assert.equal(fixture.kind, "protocol_probe");
  assert.equal(fixture.operation, "verifySession");
  assert.equal(fixture.status, "failed");
  assert.equal(fixture.account.email, "al***@example.test");
  assert.equal(fixture.account.cookieJarRef, undefined);
  assert.equal(fixture.advice.category, "login_required");
  assert.doesNotMatch(serialized, /alpha-user@example.test/);
  assert.doesNotMatch(serialized, /secret-cookie|secret-token/);
  assert.doesNotMatch(serialized, /123456/);
});

test("ProtocolProbeRunner returns a redacted session_missing fixture when local secret is absent", async () => {
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_missing", status: "active", email: "missing@example.test", cookieJarRef: "secrets/missing.cookie" }]),
    secretStore: memorySecretStore(),
    now: () => NOW,
  });

  const result = await runner.probeAccount({ accountId: "acct_missing", operation: "verifySession" });

  assert.equal(result.status, "failed");
  assert.equal(result.fixture.status, "failed");
  assert.equal(result.fixture.error.category, "session_missing");
  assert.equal(result.advice.category, "session_missing");
  assert.equal(JSON.stringify(result.fixture).includes("missing@example.test"), false);
});

test("ProtocolProbeRunner hydrates an injected verifier and writes a sanitized fixture", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_a", status: "active", email: "alpha-user@example.test", cookieJarRef: "secrets\/acct_a\.cookie" }]),
    secretStore: memorySecretStore({ "secrets\/acct_a\.cookie": "tabbit_session=secret-cookie" }),
    fixtureStore: memoryFixtureStore(events),
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async verifySession({ account: runtimeAccount, session }) {
          events.push(["verifySession", account.id, runtimeAccount.cookieHeader, session]);
          return { ok: true, userId: "user_1", accessTier: "pro", token: "secret-token" };
        },
      };
    },
  });

  const result = await runner.probeAccount({ accountId: "acct_a", operation: "verifySession", writeFixture: true });

  assert.equal(result.status, "success");
  assert.equal(result.fixtureRef, "fixtures/protocol-probes/probe.json");
  assert.deepEqual(events[0], ["verifySession", "acct_a", "tabbit_session=secret-cookie", "tabbit_session=secret-cookie"]);
  assert.equal(events[1][0], "writeFixture");
  assert.equal(JSON.stringify(result.fixture).includes("secret-cookie"), false);
  assert.equal(JSON.stringify(events[1][1]).includes("secret-token"), false);
});

test("ProtocolProbeRunner dispatches uploadAttachment with hydrated session and sanitized fixture", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_upload", status: "active", email: "upload@example.test", cookieJarRef: "secrets/acct_upload.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_upload.cookie": "tabbit_session=upload-secret" }),
    fixtureStore: memoryFixtureStore(events),
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async uploadAttachment({ account: runtimeAccount, attachment }) {
          events.push(["uploadAttachment", account.id, runtimeAccount.cookieHeader, attachment]);
          return {
            ok: true,
            attachment: { id: "att_probe", name: attachment.filename, mimeType: attachment.mimeType, size: 12 },
            raw: { cookieHeader: "tabbit_session=upload-secret", token: "secret-token" },
          };
        },
      };
    },
  });

  const input = {
    attachment: {
      filename: "probe.txt",
      mimeType: "text/plain",
      data: "base64-probe-payload",
    },
  };
  const result = await runner.probeAccount({
    accountId: "acct_upload",
    operation: "uploadAttachment",
    input,
    writeFixture: true,
  });

  assert.equal(result.status, "success");
  assert.equal(result.fixture.operation, "uploadAttachment");
  assert.equal(result.fixture.result.attachment.id, "att_probe");
  assert.deepEqual(events[0], ["uploadAttachment", "acct_upload", "tabbit_session=upload-secret", input.attachment]);
  assert.equal(events[1][0], "writeFixture");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("tabbit_session=upload-secret"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("base64-probe-payload"), false);
});

test("ProtocolProbeRunner dispatches read-only benefits probes with hydrated session", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_benefits", status: "active", userId: "user_benefits", cookieJarRef: "secrets/acct_benefits.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_benefits.cookie": "tabbit_session=benefits-secret" }),
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async getNewbieExplorationMe({ account: runtimeAccount, viewMode, includeCompletions, includeRewards }) {
          events.push(["getNewbieExplorationMe", account.id, runtimeAccount.cookieHeader, viewMode, includeCompletions, includeRewards]);
          return { ok: true, source: "tabbit-newbie-exploration", viewMode, status: "not_available" };
        },
        async listRewardCardRecords({ account: runtimeAccount, userId, limit }) {
          events.push(["listRewardCardRecords", account.id, runtimeAccount.cookieHeader, userId, limit]);
          return { ok: true, source: "tabbit-reward-card-records", total: 0, records: [] };
        },
        async getPlacementResources({ account: runtimeAccount, placementCode, clientVersion }) {
          events.push(["getPlacementResources", account.id, runtimeAccount.cookieHeader, placementCode, clientVersion]);
          return { ok: true, source: "tabbit-placement-resources", placementCode, resources: [] };
        },
      };
    },
  });

  const newbie = await runner.probeAccount({
    accountId: "acct_benefits",
    operation: "getNewbieExplorationMe",
    input: { viewMode: "activity_page", includeCompletions: true, includeRewards: true },
  });
  const reward = await runner.probeAccount({
    accountId: "acct_benefits",
    operation: "listRewardCardRecords",
    input: { userId: "user_input", limit: 10 },
  });
  const placement = await runner.probeAccount({
    accountId: "acct_benefits",
    operation: "getPlacementResources",
    input: { placementCode: "home.input_below", clientVersion: "1.3.26" },
  });

  assert.equal(newbie.status, "success");
  assert.equal(newbie.fixture.operation, "getNewbieExplorationMe");
  assert.equal(reward.status, "success");
  assert.equal(placement.status, "success");
  assert.equal(placement.fixture.operation, "getPlacementResources");
  assert.deepEqual(events, [
    ["getNewbieExplorationMe", "acct_benefits", "tabbit_session=benefits-secret", "activity_page", true, true],
    ["listRewardCardRecords", "acct_benefits", "tabbit_session=benefits-secret", "user_input", 10],
    ["getPlacementResources", "acct_benefits", "tabbit_session=benefits-secret", "home.input_below", "1.3.26"],
  ]);
  assert.equal(JSON.stringify([newbie, reward, placement]).includes("tabbit_session=benefits-secret"), false);
});

test("ProtocolProbeRunner dispatches calibrated benefits side-effect probes only through explicit operations", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_benefits_post", status: "active", userId: "user_benefits", cookieJarRef: "secrets/acct_benefits_post.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_benefits_post.cookie": "tabbit_session=benefits-post-secret" }),
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async getDailySignInStatus({ account: runtimeAccount, sceneCodes }) {
          events.push(["getDailySignInStatus", account.id, runtimeAccount.cookieHeader, sceneCodes]);
          return { ok: true, source: "tabbit-daily-sign-in-status", signedToday: false };
        },
        async participateResetCouponActivity({ account: runtimeAccount, userId, requestNo, confirmSideEffect }) {
          events.push(["participateResetCouponActivity", account.id, runtimeAccount.cookieHeader, userId, requestNo, confirmSideEffect]);
          return { ok: true, source: "tabbit-reset-coupon-activity-participate" };
        },
        async drawLottery({ account: runtimeAccount, body, confirmSideEffect }) {
          events.push(["drawLottery", account.id, runtimeAccount.cookieHeader, body, confirmSideEffect]);
          return { ok: true, source: "tabbit-lottery-draw" };
        },
      };
    },
  });

  const status = await runner.probeAccount({
    accountId: "acct_benefits_post",
    operation: "getDailySignInStatus",
    input: { sceneCodes: ["desktop_pet"] },
  });
  const participate = await runner.probeAccount({
    accountId: "acct_benefits_post",
    operation: "participateResetCouponActivity",
    input: { userId: "user_input", requestNo: "reset-probe", confirmSideEffect: true },
  });
  const draw = await runner.probeAccount({
    accountId: "acct_benefits_post",
    operation: "drawLottery",
    input: { body: { activity_id: "activity_1" }, confirmSideEffect: true },
  });

  assert.equal(status.status, "success");
  assert.equal(participate.status, "success");
  assert.equal(draw.status, "success");
  assert.deepEqual(events, [
    ["getDailySignInStatus", "acct_benefits_post", "tabbit_session=benefits-post-secret", ["desktop_pet"]],
    ["participateResetCouponActivity", "acct_benefits_post", "tabbit_session=benefits-post-secret", "user_input", "reset-probe", true],
    ["drawLottery", "acct_benefits_post", "tabbit_session=benefits-post-secret", { activity_id: "activity_1" }, true],
  ]);
  assert.equal(JSON.stringify([status, participate, draw]).includes("tabbit_session=benefits-post-secret"), false);
});

test("FileProtocolFixtureStore writes fixture JSON below stateDir", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-probe-fixtures-"));
  const store = new FileProtocolFixtureStore({
    stateDir,
    now: () => NOW,
    idFactory: () => "probe_1",
  });

  const ref = await store.writeFixture({
    version: 1,
    kind: "protocol_probe",
    observedAt: NOW,
    accountId: "acct_a",
    operation: "verifySession",
    status: "success",
  });

  assert.equal(ref, "fixtures/protocol-probes/probe_1.json");
  const saved = JSON.parse(await readFile(path.join(stateDir, ref), "utf8"));
  assert.equal(saved.kind, "protocol_probe");
  assert.equal(saved.operation, "verifySession");
});


test("FileProtocolFixtureStore lists only protocol probe fixtures as redacted summaries", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-probe-list-"));
  await mkdir(path.join(stateDir, "fixtures", "protocol-probes"), { recursive: true });
  await mkdir(path.join(stateDir, "fixtures", "other"), { recursive: true });
  await writeFile(path.join(stateDir, "fixtures", "protocol-probes", "old.json"), JSON.stringify({
    version: 1,
    kind: "protocol_probe",
    observedAt: "2026-07-02T02:00:00.000Z",
    operation: "verifySession",
    accountId: "acct_old",
    status: "failed",
    advice: { category: "login_required", severity: "error", recommendation: "refresh" },
  }), "utf8");
  await writeFile(path.join(stateDir, "fixtures", "protocol-probes", "new.json"), JSON.stringify({
    version: 1,
    kind: "protocol_probe",
    observedAt: "2026-07-02T03:00:00.000Z",
    operation: "sendMessage",
    accountId: "acct_new",
    status: "success",
    result: { token: "secret-token" },
    advice: { category: "unknown", severity: "info", recommendation: "inspect" },
  }), "utf8");
  await writeFile(path.join(stateDir, "fixtures", "protocol-probes", "not-probe.json"), JSON.stringify({ kind: "other" }), "utf8");
  await writeFile(path.join(stateDir, "fixtures", "protocol-probes", "notes.txt"), "ignore", "utf8");
  await writeFile(path.join(stateDir, "fixtures", "other", "hidden.json"), JSON.stringify({ kind: "protocol_probe" }), "utf8");

  const store = new FileProtocolFixtureStore({ stateDir });
  const fixtures = await store.listFixtures();

  assert.deepEqual(fixtures.map((item) => item.ref), [
    "fixtures/protocol-probes/new.json",
    "fixtures/protocol-probes/old.json",
  ]);
  assert.deepEqual(fixtures[0], {
    ref: "fixtures/protocol-probes/new.json",
    observedAt: "2026-07-02T03:00:00.000Z",
    operation: "sendMessage",
    status: "success",
    accountId: "acct_new",
    adviceCategory: "unknown",
  });
  assert.equal(JSON.stringify(fixtures).includes("secret-token"), false);
});

test("FileProtocolFixtureStore reads sanitized fixtures and rejects traversal refs", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-probe-show-"));
  await mkdir(path.join(stateDir, "fixtures", "protocol-probes"), { recursive: true });
  await writeFile(path.join(stateDir, "fixtures", "protocol-probes", "probe.json"), JSON.stringify({
    version: 1,
    kind: "protocol_probe",
    observedAt: NOW,
    operation: "verifySession",
    accountId: "acct_a",
    status: "failed",
    account: {
      id: "acct_a",
      email: "alpha-user@example.test",
      status: "active",
      cookieJarRef: "secrets\/acct_a\.cookie",
      cookieHeader: "tabbit_session=secret-cookie",
      token: "secret-token",
    },
    input: { code: "123456", cookieJarRef: "secrets\/acct_a\.cookie" },
    result: { authorization: "Bearer secret-token-123", message: "alpha-user@example.test code 123456" },
  }), "utf8");

  const store = new FileProtocolFixtureStore({ stateDir });
  const fixture = await store.readFixture("fixtures/protocol-probes/probe.json");
  const serialized = JSON.stringify(fixture);

  assert.equal(fixture.kind, "protocol_probe");
  assert.equal(fixture.account.email, "al***@example.test");
  assert.equal(fixture.account.cookieJarRef, undefined);
  assert.doesNotMatch(serialized, /alpha-user@example.test|secret-cookie|secret-token|123456|secrets\/acct_a\.cookie/);
  await assert.rejects(
    () => store.readFixture("fixtures/protocol-probes/../secrets\/acct_a\.cookie"),
    /fixture ref must stay inside protocol probe fixtures/,
  );
});
