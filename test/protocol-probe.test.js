import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileProtocolFixtureStore,
  ProtocolProbeRunner,
  buildProtocolProbeFixture,
  sanitizeProtocolProbeFixture,
} from "../src/protocol-probe.js";
import { buildProtocolFixtureAudit } from "../src/observability.js";

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

test("sanitizeProtocolProbeFixture keeps safe error codes while redacting input codes", () => {
  const fixture = sanitizeProtocolProbeFixture(buildProtocolProbeFixture({
    observedAt: NOW,
    accountId: "acct_chat",
    operation: "sendMessage",
    status: "failed",
    input: { code: "123456", messages: [{ role: "user", content: "secret prompt" }] },
    result: { ok: false, error: { category: "invalid_request", code: "MISSING_CHAT_SESSION_ID" } },
    error: { category: "invalid_request", code: "MISSING_CHAT_SESSION_ID", message: "missing chat session id" },
  }));

  const serialized = JSON.stringify(fixture);
  assert.equal(fixture.error.code, "MISSING_CHAT_SESSION_ID");
  assert.equal(fixture.result.error.code, "MISSING_CHAT_SESSION_ID");
  assert.equal(fixture.input.code, "***");
  assert.equal(fixture.input.messages[0].content, "***");
  assert.doesNotMatch(serialized, /123456|secret prompt/);
});

test("buildProtocolProbeFixture redacts sendMessage prompt and stream text", () => {
  const fixture = buildProtocolProbeFixture({
    observedAt: NOW,
    accountId: "acct_chat",
    operation: "sendMessage",
    status: "success",
    input: {
      model: "tabbit/priority",
      messages: [{ role: "user", content: "private prompt should not be persisted" }],
      content: "direct private prompt",
      body: { prompt: "nested private prompt" },
      metadatas: { html_content: "<p>private prompt should not be persisted</p>" },
    },
    result: {
      content: "private assistant response",
      contentBlocks: [{ type: "text", text: "private stream text" }],
      streamDeltas: ["private", " stream", " text"],
    },
  });

  const serialized = JSON.stringify(fixture);
  assert.equal(fixture.input.messages[0].content, "***");
  assert.equal(fixture.input.content, "***");
  assert.equal(fixture.input.body.prompt, "***");
  assert.equal(fixture.input.metadatas.html_content, "***");
  assert.equal(fixture.result.content, "***");
  assert.equal(fixture.result.contentBlocks[0].text, "***");
  assert.deepEqual(fixture.result.streamDeltas, ["***", "***", "***"]);
  assert.doesNotMatch(serialized, /private prompt|private stream|private assistant/);
});

test("buildProtocolProbeFixture redacts auto-created chat session and raw tool event details", () => {
  const fixture = buildProtocolProbeFixture({
    observedAt: NOW,
    accountId: "acct_chat",
    operation: "sendMessage",
    status: "success",
    result: {
      ok: true,
      chatSessionId: "12c4903b-f540-4fcd-84bd-02b5c5d56907",
      contentBlocks: [
        { type: "text", text: "private assistant response" },
        {
          type: "tool_use",
          id: "call_private_tool_id",
          name: "parallel_web_search",
          input: {
            query: [
              "private prompt search term",
              "private diagnostic query",
            ],
          },
        },
      ],
      raw: {
        kind: "stream",
        format: "sse",
        events: [
          {
            event: "ready",
            data: {
              chat_session_id: "12c4903b-f540-4fcd-84bd-02b5c5d56907",
              request_message_id: "request-message-private",
            },
          },
          {
            event: "message_tool_call_delta",
            data: {
              tool_call_id: "call_private_tool_id",
              arguments: "{\"query\":[\"private prompt search term\"]}",
            },
          },
        ],
        text: "private upstream text",
      },
      streamDeltas: ["private upstream text"],
    },
  });

  const serialized = JSON.stringify(fixture);
  assert.equal(fixture.result.chatSessionId, "***");
  assert.equal(fixture.result.contentBlocks[1].input.query[0], "***");
  assert.equal(fixture.result.raw.events[0].data, "***");
  assert.equal(fixture.result.raw.events[1].data, "***");
  assert.doesNotMatch(serialized, /12c4903b|private prompt search term|private diagnostic query|request-message-private|call_private_tool_id|private upstream text/);
});

test("buildProtocolProbeFixture redacts real user identifiers from payloads", () => {
  const fixture = buildProtocolProbeFixture({
    observedAt: NOW,
    accountId: "acct_session",
    operation: "verifySession",
    status: "success",
    input: {
      userId: "real-user-input",
      body: { user_id: "real-user-body" },
    },
    result: {
      ok: true,
      userId: "real-user-result",
      raw: {
        data: {
          user_info: {
            id: "real-user-info-id",
            nickname: "real user nickname",
          },
        },
      },
    },
  });

  const serialized = JSON.stringify(fixture);
  assert.equal(fixture.input.userId, "***");
  assert.equal(fixture.input.body.user_id, "***");
  assert.equal(fixture.result.userId, "***");
  assert.equal(fixture.result.raw.data.user_info.id, "***");
  assert.equal(fixture.result.raw.data.user_info.nickname, "***");
  assert.doesNotMatch(serialized, /real-user|real user nickname/);
});

test("buildProtocolProbeFixture redacts reset coupon codes from payloads", () => {
  const fixture = buildProtocolProbeFixture({
    observedAt: NOW,
    accountId: "acct_coupon",
    operation: "useResetCoupon",
    status: "success",
    input: {
      couponCode: "real-coupon-code-input",
      body: { coupon_code: "real-coupon-code-body" },
    },
    result: {
      ok: true,
      raw: {
        data: {
          couponCode: "real-coupon-code-result",
          coupon_code: "real-coupon-code-raw",
        },
      },
    },
  });

  const serialized = JSON.stringify(fixture);
  assert.equal(fixture.input.couponCode, "***");
  assert.equal(fixture.input.body.coupon_code, "***");
  assert.equal(fixture.result.raw.data.couponCode, "***");
  assert.equal(fixture.result.raw.data.coupon_code, "***");
  assert.doesNotMatch(serialized, /real-coupon-code/);
});

test("buildProtocolProbeFixture redacts auth captcha challenge fields", () => {
  const fixture = buildProtocolProbeFixture({
    observedAt: NOW,
    accountId: "acct_auth",
    operation: "sendVerificationCode",
    status: "failed",
    input: {
      body: {
        mobile: "10000000000",
        uuid: "00000000-0000-4000-8000-000000000000",
        smsCode: "000000",
        captchaToken: "captcha-token-value",
      },
    },
    result: {
      data: {
        requestCode: "yoda-request-code-value",
        verifyUrl: "https://verify.example.test/yoda?requestCode=yoda-request-code-value",
      },
    },
  });

  const serialized = JSON.stringify(fixture);
  assert.equal(fixture.input.body.mobile, "***");
  assert.equal(fixture.input.body.uuid, "***");
  assert.equal(fixture.input.body.smsCode, "***");
  assert.equal(fixture.input.body.captchaToken, "***");
  assert.equal(fixture.result.data.requestCode, "***");
  assert.equal(fixture.result.data.verifyUrl, "***");
  assert.doesNotMatch(serialized, /10000000000|00000000-0000-4000-8000-000000000000|captcha-token-value|yoda-request-code-value|verify\.example/);
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

test("ProtocolProbeRunner preserves safe upstream evidence markers for live sendMessage fixtures", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_stream", status: "active", email: "stream@example.test", cookieJarRef: "secrets/acct_stream.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_stream.cookie": "placeholder-stream-session" }),
    fixtureStore: memoryFixtureStore(events),
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async sendMessage({ account: runtimeAccount, messages, stream }) {
          events.push(["sendMessage", account.id, runtimeAccount.cookieHeader, messages[0].content, stream]);
          return {
            ok: true,
            upstreamEvidence: {
              source: "tabbit-live",
              real: true,
              stream: true,
              format: "sse",
              backpressure: true,
              firstTokenFlush: true,
              delayedSecondChunk: true,
            },
            raw: {
              kind: "stream",
              format: "sse",
              events: [{ event: "message", data: "private upstream text" }],
            },
            streamDeltas: ["private upstream text"],
          };
        },
      };
    },
  });

  const result = await runner.probeAccount({
    accountId: "acct_stream",
    operation: "sendMessage",
    input: {
      model: "tabbit/priority",
      messages: [{ role: "user", content: "private prompt should not persist" }],
      stream: true,
    },
    writeFixture: true,
  });

  assert.equal(result.status, "success");
  assert.deepEqual(events[0], ["sendMessage", "acct_stream", "placeholder-stream-session", "private prompt should not persist", true]);
  assert.equal(events[1][0], "writeFixture");
  const fixture = events[1][1];
  assert.equal(fixture.operation, "sendMessage");
  assert.deepEqual(fixture.result.upstreamEvidence, {
    source: "tabbit-live",
    real: true,
    stream: true,
    format: "sse",
    backpressure: true,
    firstTokenFlush: true,
    delayedSecondChunk: true,
  });
  assert.deepEqual(fixture.result.streamDeltas, ["***"]);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /stream-secret|private prompt|private upstream text/);

  const audit = buildProtocolFixtureAudit({ scope: "upstream", fixtures: [fixture], now: () => NOW });
  assert.equal(audit.counts.realUpstream, 1);
  assert.equal(audit.counts.upstreamBackpressure, 1);
  assert.equal(audit.coverage.upstreamBackpressure.status, "ready");
});

test("ProtocolProbeRunner uses redacted default sendMessage content when input is omitted", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_default_send", status: "active", email: "default-send@example.test", cookieJarRef: "secrets/acct_default_send.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_default_send.cookie": "placeholder-default-send-session" }),
    now: () => NOW,
    protocolClientFactory() {
      return {
        async sendMessage({ account: runtimeAccount, messages, stream }) {
          events.push(["sendMessage", runtimeAccount.cookieHeader, messages[0].content, stream]);
          return { ok: true, content: "private upstream text" };
        },
      };
    },
  });

  const result = await runner.probeAccount({
    accountId: "acct_default_send",
    operation: "sendMessage",
  });

  assert.equal(result.status, "success");
  assert.deepEqual(events[0], ["sendMessage", "placeholder-default-send-session", "<redacted-message-content>", false]);
  const serialized = JSON.stringify(result.fixture);
  assert.doesNotMatch(serialized, /\bping\b|placeholder-default-send-session|private upstream text/);
});

test("ProtocolProbeRunner captures bounded async stream backpressure evidence without raw text", async () => {
  const events = [];
  const consumed = [];
  let closed = false;
  const streamDeltas = {
    async *[Symbol.asyncIterator]() {
      try {
        consumed.push("first");
        yield "private first token";
        consumed.push("second");
        yield "private second token";
        consumed.push("third");
        yield "private third token";
      } finally {
        closed = true;
      }
    },
  };
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_stream_capture", status: "active", email: "stream-capture@example.test", cookieJarRef: "secrets/acct_stream_capture.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_stream_capture.cookie": "placeholder-stream-capture-session" }),
    fixtureStore: memoryFixtureStore(events),
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async sendMessage({ account: runtimeAccount, messages, stream }) {
          events.push(["sendMessage", account.id, runtimeAccount.cookieHeader, messages[0].content, stream]);
          return {
            ok: true,
            upstreamEvidence: {
              source: "tabbit-live",
              real: true,
              stream: true,
              format: "sse",
            },
            raw: { kind: "stream", format: "sse", async: true, events: [] },
            streamDeltas,
          };
        },
      };
    },
  });

  const result = await runner.probeAccount({
    accountId: "acct_stream_capture",
    operation: "sendMessage",
    input: {
      model: "tabbit/priority",
      messages: [{ role: "user", content: "private prompt should not persist" }],
      stream: true,
      streamEvidence: {
        mode: "first_token_backpressure",
        maxDeltas: 2,
      },
    },
    writeFixture: true,
  });

  assert.equal(result.status, "success");
  assert.deepEqual(consumed, ["first", "second"]);
  assert.equal(closed, true);
  assert.equal(events[1][0], "writeFixture");
  const fixture = events[1][1];
  assert.equal(fixture.operation, "sendMessage");
  assert.equal(fixture.result.upstreamEvidence.backpressure, true);
  assert.equal(fixture.result.upstreamEvidence.firstTokenFlush, true);
  assert.equal(fixture.result.upstreamEvidence.delayedSecondChunk, true);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /stream-capture-secret|private prompt|private first token|private second token|private third token/);

  const audit = buildProtocolFixtureAudit({ scope: "upstream", fixtures: [fixture], now: () => NOW });
  assert.equal(audit.counts.upstreamBackpressure, 1);
  assert.equal(audit.coverage.upstreamBackpressure.status, "ready");
});

test("ProtocolProbeRunner fails streamEvidence probes without a real async upstream marker", async () => {
  const events = [];
  const streamDeltas = {
    async *[Symbol.asyncIterator]() {
      yield "private unmarked stream text";
    },
  };
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_stream_unmarked", status: "active", email: "stream-unmarked@example.test", cookieJarRef: "secrets/acct_stream_unmarked.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_stream_unmarked.cookie": "placeholder-stream-unmarked-session" }),
    fixtureStore: memoryFixtureStore(events),
    now: () => NOW,
    protocolClientFactory() {
      return {
        async sendMessage({ account: runtimeAccount, messages }) {
          events.push(["sendMessage", runtimeAccount.cookieHeader, messages[0].content]);
          return {
            ok: true,
            raw: { kind: "stream", format: "sse", async: true, events: [] },
            streamDeltas,
          };
        },
      };
    },
  });

  const result = await runner.probeAccount({
    accountId: "acct_stream_unmarked",
    operation: "sendMessage",
    input: {
      model: "tabbit/priority",
      messages: [{ role: "user", content: "private unmarked prompt should not persist" }],
      stream: true,
      streamEvidence: {
        mode: "cancel_after_first_delta",
        maxDeltas: 2,
      },
    },
    writeFixture: true,
  });

  assert.equal(result.status, "failed");
  assert.equal(events[1][0], "writeFixture");
  const fixture = events[1][1];
  assert.equal(fixture.error.code, "STREAM_EVIDENCE_NOT_CAPTURED");
  assert.equal(fixture.result.upstreamEvidence, undefined);
  const audit = buildProtocolFixtureAudit({ scope: "upstream", fixtures: [fixture], now: () => NOW });
  assert.equal(audit.counts.realUpstream, 0);
  assert.equal(audit.counts.upstreamCancellation, 0);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /stream-unmarked-secret|private unmarked prompt|private unmarked stream text/);
});

test("ProtocolProbeRunner fails backpressure streamEvidence when the second delta is missing", async () => {
  const events = [];
  const consumed = [];
  const streamDeltas = {
    async *[Symbol.asyncIterator]() {
      consumed.push("first");
      yield "private lone token";
    },
  };
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_stream_short", status: "active", email: "stream-short@example.test", cookieJarRef: "secrets/acct_stream_short.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_stream_short.cookie": "placeholder-stream-short-session" }),
    fixtureStore: memoryFixtureStore(events),
    now: () => NOW,
    protocolClientFactory() {
      return {
        async sendMessage({ account: runtimeAccount, messages }) {
          events.push(["sendMessage", runtimeAccount.cookieHeader, messages[0].content]);
          return {
            ok: true,
            upstreamEvidence: {
              source: "tabbit-live",
              real: true,
              stream: true,
              format: "sse",
            },
            raw: { kind: "stream", format: "sse", async: true, events: [] },
            streamDeltas,
          };
        },
      };
    },
  });

  const result = await runner.probeAccount({
    accountId: "acct_stream_short",
    operation: "sendMessage",
    input: {
      model: "tabbit/priority",
      messages: [{ role: "user", content: "private short stream prompt should not persist" }],
      stream: true,
      streamEvidence: {
        mode: "first_token_backpressure",
        maxDeltas: 2,
      },
    },
    writeFixture: true,
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(consumed, ["first"]);
  assert.equal(events[1][0], "writeFixture");
  const fixture = events[1][1];
  assert.equal(fixture.error.code, "STREAM_EVIDENCE_NOT_CAPTURED");
  assert.equal(fixture.result.upstreamEvidence.backpressure, undefined);
  assert.equal(fixture.result.upstreamEvidence.firstTokenFlush, undefined);
  assert.equal(fixture.result.upstreamEvidence.delayedSecondChunk, undefined);
  const audit = buildProtocolFixtureAudit({ scope: "upstream", fixtures: [fixture], now: () => NOW });
  assert.equal(audit.counts.realUpstream, 1);
  assert.equal(audit.counts.upstreamBackpressure, 0);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /stream-short-secret|private short stream prompt|private lone token/);
});

test("ProtocolProbeRunner captures async stream cancellation evidence without raw text", async () => {
  const events = [];
  const consumed = [];
  let closed = false;
  const streamDeltas = {
    async *[Symbol.asyncIterator]() {
      try {
        consumed.push("first");
        yield "private first cancellation token";
        consumed.push("second");
        yield "private second cancellation token";
      } finally {
        closed = true;
      }
    },
  };
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_stream_cancel", status: "active", email: "stream-cancel@example.test", cookieJarRef: "secrets/acct_stream_cancel.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_stream_cancel.cookie": "placeholder-stream-cancel-session" }),
    fixtureStore: memoryFixtureStore(events),
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async sendMessage({ account: runtimeAccount, messages, stream }) {
          events.push(["sendMessage", account.id, runtimeAccount.cookieHeader, messages[0].content, stream]);
          return {
            ok: true,
            upstreamEvidence: {
              source: "tabbit-live",
              real: true,
              stream: true,
              format: "sse",
            },
            raw: { kind: "stream", format: "sse", async: true, events: [] },
            streamDeltas,
          };
        },
      };
    },
  });

  const result = await runner.probeAccount({
    accountId: "acct_stream_cancel",
    operation: "sendMessage",
    input: {
      model: "tabbit/priority",
      messages: [{ role: "user", content: "private cancellation prompt should not persist" }],
      stream: true,
      streamEvidence: {
        mode: "cancel_after_first_delta",
        maxDeltas: 2,
      },
    },
    writeFixture: true,
  });

  assert.equal(result.status, "success");
  assert.deepEqual(consumed, ["first"]);
  assert.equal(closed, true);
  assert.equal(events[1][0], "writeFixture");
  const fixture = events[1][1];
  assert.equal(fixture.operation, "sendMessage");
  assert.equal(fixture.result.upstreamEvidence.cancellation, true);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /stream-cancel-secret|private cancellation prompt|private first cancellation token|private second cancellation token/);

  const audit = buildProtocolFixtureAudit({ scope: "upstream", fixtures: [fixture], now: () => NOW });
  assert.equal(audit.counts.upstreamCancellation, 1);
  assert.equal(audit.coverage.upstreamCancellation.status, "ready");
});

test("ProtocolProbeRunner captures async stream error-frame evidence without raw text", async () => {
  const events = [];
  const consumed = [];
  const streamDeltas = {
    async *[Symbol.asyncIterator]() {
      consumed.push("first");
      yield "private first error token";
      const error = new Error("private upstream error frame should not persist");
      error.category = "protocol_changed";
      error.code = "UPSTREAM_STREAM_ERROR";
      error.status = 502;
      throw error;
    },
  };
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_stream_error", status: "active", email: "stream-error@example.test", cookieJarRef: "secrets/acct_stream_error.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_stream_error.cookie": "placeholder-stream-error-session" }),
    fixtureStore: memoryFixtureStore(events),
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async sendMessage({ account: runtimeAccount, messages, stream }) {
          events.push(["sendMessage", account.id, runtimeAccount.cookieHeader, messages[0].content, stream]);
          return {
            ok: true,
            upstreamEvidence: {
              source: "tabbit-live",
              real: true,
              stream: true,
              format: "sse",
            },
            raw: {
              kind: "stream",
              format: "sse",
              async: true,
              events: [{ event: "error", data: "private raw error frame should not persist" }],
            },
            streamDeltas,
          };
        },
      };
    },
  });

  const result = await runner.probeAccount({
    accountId: "acct_stream_error",
    operation: "sendMessage",
    input: {
      model: "tabbit/priority",
      messages: [{ role: "user", content: "private error prompt should not persist" }],
      stream: true,
      streamEvidence: {
        mode: "error_frame",
        maxDeltas: 2,
      },
    },
    writeFixture: true,
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(consumed, ["first"]);
  assert.equal(events[1][0], "writeFixture");
  const fixture = events[1][1];
  assert.equal(fixture.operation, "sendMessage");
  assert.equal(fixture.result.upstreamEvidence.streamErrorFrame, true);
  assert.equal(fixture.error.category, "protocol_changed");
  assert.equal(fixture.error.code, "UPSTREAM_STREAM_ERROR");
  assert.equal(fixture.error.status, 502);
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /stream-error-secret|private error prompt|private first error token|private upstream error frame|private raw error frame/);

  const audit = buildProtocolFixtureAudit({ scope: "upstream", fixtures: [fixture], now: () => NOW });
  assert.equal(audit.counts.upstreamErrorFrame, 1);
  assert.equal(audit.coverage.upstreamErrorFrame.status, "ready");
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
    secretStore: memorySecretStore({ "secrets/acct_benefits_post.cookie": "tabbit_session=bp" }),
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
        async useResetCoupon({ account: runtimeAccount, userId, couponCode, couponType, requestNo, confirmSideEffect }) {
          events.push(["useResetCoupon", account.id, runtimeAccount.cookieHeader, userId, couponCode, couponType, requestNo, confirmSideEffect]);
          return { ok: true, source: "tabbit-reset-coupon-use", used: true };
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
  const useCoupon = await runner.probeAccount({
    accountId: "acct_benefits_post",
    operation: "useResetCoupon",
    input: { couponCode: "coupon-code", couponType: "weekly_reset_coupon", requestNo: "coupon-use-probe", confirmSideEffect: true },
  });
  const draw = await runner.probeAccount({
    accountId: "acct_benefits_post",
    operation: "drawLottery",
    input: { body: { activity_id: "activity_1" }, confirmSideEffect: true },
  });

  assert.equal(status.status, "success");
  assert.equal(participate.status, "success");
  assert.equal(useCoupon.status, "success");
  assert.equal(draw.status, "success");
  assert.deepEqual(events, [
    ["getDailySignInStatus", "acct_benefits_post", "tabbit_session=bp", ["desktop_pet"]],
    ["participateResetCouponActivity", "acct_benefits_post", "tabbit_session=bp", "user_input", "reset-probe", true],
    ["useResetCoupon", "acct_benefits_post", "tabbit_session=bp", "user_benefits", "coupon-code", "weekly_reset_coupon", "coupon-use-probe", true],
    ["drawLottery", "acct_benefits_post", "tabbit_session=bp", { activity_id: "activity_1", user_id: "user_benefits" }, true],
  ]);
  assert.equal(JSON.stringify([status, participate, useCoupon, draw]).includes("tabbit_session=bp"), false);
});

test("ProtocolProbeRunner hydrates missing userId through verifySession for commerce probes", async () => {
  const originalAccount = { id: "acct_commerce", status: "active", cookieJarRef: "secrets/commerce.cookie" };
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([originalAccount]),
    secretStore: memorySecretStore({ "secrets/commerce.cookie": "placeholder-commerce-session" }),
    now: () => NOW,
    protocolClientFactory() {
      return {
        async verifySession({ account: runtimeAccount, session }) {
          events.push(["verifySession", runtimeAccount.id, runtimeAccount.cookieHeader, session]);
          return { ok: true, userId: "user_from_session" };
        },
        async listBenefitCoupons({ account: runtimeAccount, userId }) {
          events.push(["listBenefitCoupons", runtimeAccount.id, runtimeAccount.userId, userId]);
          return { ok: true, coupons: [] };
        },
      };
    },
  });

  const result = await runner.probeAccount({ accountId: "acct_commerce", operation: "listBenefitCoupons" });

  assert.equal(result.status, "success");
  assert.deepEqual(events, [
    ["verifySession", "acct_commerce", "placeholder-commerce-session", "placeholder-commerce-session"],
    ["listBenefitCoupons", "acct_commerce", "user_from_session", "user_from_session"],
  ]);
  assert.equal(originalAccount.userId, undefined);
});

test("ProtocolProbeRunner hydrates userId for confirmed commerce side-effect probes", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_side_effect_user", status: "active", cookieJarRef: "secrets/side-effect.cookie" }]),
    secretStore: memorySecretStore({ "secrets/side-effect.cookie": "placeholder-side-effect-session" }),
    now: () => NOW,
    protocolClientFactory() {
      return {
        async verifySession({ account: runtimeAccount, session }) {
          events.push(["verifySession", runtimeAccount.id, runtimeAccount.cookieHeader, session]);
          return { ok: true, userId: "user_from_session" };
        },
        async participateResetCouponActivity({ account: runtimeAccount, userId, requestNo, confirmSideEffect }) {
          events.push(["participateResetCouponActivity", runtimeAccount.id, runtimeAccount.userId, userId, requestNo, confirmSideEffect]);
          return { ok: true, source: "tabbit-reset-coupon-activity-participate" };
        },
        async drawLottery({ account: runtimeAccount, body, confirmSideEffect }) {
          events.push(["drawLottery", runtimeAccount.id, runtimeAccount.userId, body, confirmSideEffect]);
          return { ok: true, source: "tabbit-lottery-draw" };
        },
      };
    },
  });

  const participate = await runner.probeAccount({
    accountId: "acct_side_effect_user",
    operation: "participateResetCouponActivity",
    input: { requestNo: "reset-probe", confirmSideEffect: true },
  });
  const draw = await runner.probeAccount({
    accountId: "acct_side_effect_user",
    operation: "drawLottery",
    input: { body: { lottery_activity_id: "123", request_no: "draw-probe" }, confirmSideEffect: true },
  });

  assert.equal(participate.status, "success");
  assert.equal(draw.status, "success");
  assert.deepEqual(events, [
    ["verifySession", "acct_side_effect_user", "placeholder-side-effect-session", "placeholder-side-effect-session"],
    ["participateResetCouponActivity", "acct_side_effect_user", "user_from_session", "user_from_session", "reset-probe", true],
    ["verifySession", "acct_side_effect_user", "placeholder-side-effect-session", "placeholder-side-effect-session"],
    ["drawLottery", "acct_side_effect_user", "user_from_session", { lottery_activity_id: "123", request_no: "draw-probe", user_id: "user_from_session" }, true],
  ]);
  assert.equal(JSON.stringify([participate, draw]).includes("placeholder-side-effect-session"), false);
  assert.equal(JSON.stringify([participate, draw]).includes("user_from_session"), false);
});

test("ProtocolProbeRunner does not verify session when commerce probe input already has userId", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_commerce_input", status: "active", cookieJarRef: "secrets/commerce-input.cookie" }]),
    secretStore: memorySecretStore({ "secrets/commerce-input.cookie": "placeholder-commerce-input-session" }),
    now: () => NOW,
    protocolClientFactory() {
      return {
        async verifySession() {
          events.push(["verifySession"]);
          return { ok: true, userId: "unexpected" };
        },
        async listBenefitCoupons({ account: runtimeAccount, userId }) {
          events.push(["listBenefitCoupons", runtimeAccount.id, runtimeAccount.userId, userId]);
          return { ok: true, coupons: [] };
        },
      };
    },
  });

  const result = await runner.probeAccount({
    accountId: "acct_commerce_input",
    operation: "listBenefitCoupons",
    input: { userId: "user_from_input" },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(events, [
    ["listBenefitCoupons", "acct_commerce_input", undefined, "user_from_input"],
  ]);
});

test("ProtocolProbeRunner does not hydrate userId before reporting a missing target operation", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_commerce_missing", status: "active", cookieJarRef: "secrets/commerce-missing.cookie" }]),
    secretStore: memorySecretStore({ "secrets/commerce-missing.cookie": "placeholder-commerce-missing-session" }),
    now: () => NOW,
    protocolClientFactory() {
      return {
        async verifySession() {
          events.push(["verifySession"]);
          return { ok: true, userId: "should_not_be_used" };
        },
      };
    },
  });

  const result = await runner.probeAccount({ accountId: "acct_commerce_missing", operation: "listBenefitCoupons" });

  assert.equal(result.status, "skipped");
  assert.equal(result.fixture.error.category, "protocol_missing");
  assert.deepEqual(events, []);
});

test("ProtocolProbeRunner keeps target operation classification when userId hydration fails", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_commerce_verify_failed", status: "active", cookieJarRef: "secrets/commerce-verify-failed.cookie" }]),
    secretStore: memorySecretStore({ "secrets/commerce-verify-failed.cookie": "placeholder-commerce-verify-failed-session" }),
    now: () => NOW,
    protocolClientFactory() {
      return {
        async verifySession() {
          events.push(["verifySession"]);
          throw Object.assign(new Error("session verifier failed"), { category: "login_required", code: "LOGIN_REQUIRED" });
        },
        async listBenefitCoupons({ userId }) {
          events.push(["listBenefitCoupons", userId]);
          return {
            ok: false,
            category: "invalid_request",
            code: "MISSING_USER_ID",
            message: "user id is required",
          };
        },
      };
    },
  });

  const result = await runner.probeAccount({ accountId: "acct_commerce_verify_failed", operation: "listBenefitCoupons" });

  assert.equal(result.status, "failed");
  assert.equal(result.fixture.error.category, "invalid_request");
  assert.equal(result.fixture.error.code, "MISSING_USER_ID");
  assert.deepEqual(events, [
    ["verifySession"],
    ["listBenefitCoupons", undefined],
  ]);
});

test("ProtocolProbeRunner dispatches auth probes only with explicit confirmation", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_auth_probe", status: "active", email: "auth-user@example.test", cookieJarRef: "secrets/acct_auth_probe.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_auth_probe.cookie": "tabbit_session=ap" }),
    fixtureStore: memoryFixtureStore(events),
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async sendVerificationCode({ account: runtimeAccount, email, body, confirmSideEffect }) {
          events.push(["sendVerificationCode", account.id, runtimeAccount.cookieHeader, email, body, confirmSideEffect]);
          return { ok: true, raw: { email, token: "secret-token" } };
        },
        async submitRegistrationOrLogin({ account: runtimeAccount, email, code, body, confirmSideEffect }) {
          events.push(["submitRegistrationOrLogin", account.id, runtimeAccount.cookieHeader, email, code, body, confirmSideEffect]);
          return { ok: true, cookieHeader: "tabbit_session=na", userId: "user_auth", raw: { code, token: "secret-token" } };
        },
      };
    },
  });

  const sendInput = {
    email: "auth-user@example.test",
    body: { email_address: "auth-user@example.test", scene: "login" },
    confirmSideEffect: true,
  };
  const send = await runner.probeAccount({
    accountId: "acct_auth_probe",
    operation: "sendVerificationCode",
    input: sendInput,
    writeFixture: true,
  });
  const submitInput = {
    email: "auth-user@example.test",
    code: "123456",
    body: { email_address: "auth-user@example.test", verify_code: "123456" },
    confirmSideEffect: true,
  };
  const submit = await runner.probeAccount({
    accountId: "acct_auth_probe",
    operation: "submitRegistrationOrLogin",
    input: submitInput,
    writeFixture: true,
  });

  assert.equal(send.status, "success");
  assert.equal(send.fixture.operation, "sendVerificationCode");
  assert.equal(submit.status, "success");
  assert.equal(submit.fixture.operation, "submitRegistrationOrLogin");
  assert.deepEqual(events[0], ["sendVerificationCode", "acct_auth_probe", "tabbit_session=ap", "auth-user@example.test", sendInput.body, true]);
  assert.deepEqual(events[2], ["submitRegistrationOrLogin", "acct_auth_probe", "tabbit_session=ap", "auth-user@example.test", "123456", submitInput.body, true]);
  const serialized = JSON.stringify([send, submit, events[1][1], events[3][1]]);
  assert.equal(serialized.includes("auth-user@example.test"), false);
  assert.equal(serialized.includes("123456"), false);
  assert.equal(serialized.includes("tabbit_session=ap"), false);
  assert.equal(serialized.includes("tabbit_session=na"), false);
  assert.equal(serialized.includes("secret-token"), false);
});

test("ProtocolProbeRunner rejects auth probes without confirmation before client dispatch", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_auth_guard", status: "active", email: "guard-user@example.test", cookieJarRef: "secrets/acct_auth_guard.cookie" }]),
    secretStore: memorySecretStore({ "secrets/acct_auth_guard.cookie": "tabbit_session=ag" }),
    now: () => NOW,
    protocolClientFactory() {
      return {
        async sendVerificationCode() {
          events.push(["sendVerificationCode"]);
          return { ok: true };
        },
        async submitRegistrationOrLogin() {
          events.push(["submitRegistrationOrLogin"]);
          return { ok: true };
        },
      };
    },
  });

  const send = await runner.probeAccount({
    accountId: "acct_auth_guard",
    operation: "sendVerificationCode",
    input: { email: "guard-user@example.test", confirmSideEffect: false },
  });
  const submit = await runner.probeAccount({
    accountId: "acct_auth_guard",
    operation: "submitRegistrationOrLogin",
    input: { email: "guard-user@example.test", code: "654321" },
  });

  assert.equal(send.status, "failed");
  assert.equal(send.fixture.error.category, "invalid_request");
  assert.equal(submit.status, "failed");
  assert.equal(submit.fixture.error.category, "invalid_request");
  assert.deepEqual(events, []);
  const serialized = JSON.stringify([send, submit]);
  assert.equal(serialized.includes("guard-user@example.test"), false);
  assert.equal(serialized.includes("654321"), false);
  assert.equal(serialized.includes("tabbit_session=ag"), false);
});

test("ProtocolProbeRunner dispatches confirmed auth probes without stored session material", async () => {
  const events = [];
  const runner = new ProtocolProbeRunner({
    accountStore: memoryAccountStore([{ id: "acct_auth_no_session", status: "provisioning", email: "new-user@example.test" }]),
    secretStore: {
      async readSecret(ref) {
        events.push(["readSecret", ref]);
        return null;
      },
    },
    now: () => NOW,
    protocolClientFactory(account) {
      return {
        async sendVerificationCode({ account: runtimeAccount, email, confirmSideEffect }) {
          events.push(["sendVerificationCode", account.id, runtimeAccount.cookieHeader, email, confirmSideEffect]);
          return { ok: true, raw: { email, token: "secret-token" } };
        },
      };
    },
  });

  const result = await runner.probeAccount({
    accountId: "acct_auth_no_session",
    operation: "sendVerificationCode",
    input: { email: "new-user@example.test", confirmSideEffect: true },
  });

  assert.equal(result.status, "success");
  assert.equal(result.fixture.operation, "sendVerificationCode");
  assert.deepEqual(events, [
    ["sendVerificationCode", "acct_auth_no_session", undefined, "new-user@example.test", true],
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("new-user@example.test"), false);
  assert.equal(serialized.includes("secret-token"), false);
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

test("FileProtocolFixtureStore can write sanitized fixtures below an explicit fixtureDir", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-probe-state-readonly-"));
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "tabbit-probe-fixture-dir-"));
  const store = new FileProtocolFixtureStore({
    stateDir,
    fixtureDir,
    now: () => NOW,
    idFactory: () => "probe_1",
  });

  const ref = await store.writeFixture({
    version: 1,
    kind: "protocol_probe",
    observedAt: NOW,
    accountId: "acct_a",
    operation: "dailySignIn",
    status: "success",
    result: { token: "secret-token", signInResult: "success" },
  });

  assert.equal(ref, "fixtures/protocol-probes/probe_1.json");
  await assert.rejects(() => readFile(path.join(stateDir, ref), "utf8"), { code: "ENOENT" });
  const saved = JSON.parse(await readFile(path.join(fixtureDir, "probe_1.json"), "utf8"));
  assert.equal(saved.kind, "protocol_probe");
  assert.equal(saved.operation, "dailySignIn");
  assert.equal(JSON.stringify(saved).includes("secret-token"), false);
  assert.deepEqual((await store.listFixtures()).map((item) => item.ref), ["fixtures/protocol-probes/probe_1.json"]);
  const readBack = await store.readFixture(ref);
  assert.equal(readBack.operation, "dailySignIn");
  await assert.rejects(() => store.readFixture("fixtures/other/probe_1.json"), /protocol probe fixtures/);
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

test("FileProtocolFixtureStore lists sanitized session recovery strategy fixtures", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-probe-session-recovery-list-"));
  await mkdir(path.join(stateDir, "fixtures", "protocol-probes"), { recursive: true });
  await writeFile(path.join(stateDir, "fixtures", "protocol-probes", "session-recovery.json"), JSON.stringify({
    kind: "session_recovery_strategy",
    operation: "recoverSession",
    status: "success",
    observedAt: "2026-07-04T03:00:00.000Z",
    evidence: {
      strategy: "automated_reauth",
      automatedRefresh: "calibrated_reauth_probe",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: { raw: { cookie: "tabbit_session=secret" } },
  }), "utf8");
  await writeFile(path.join(stateDir, "fixtures", "protocol-probes", "unknown.json"), JSON.stringify({
    kind: "unknown_fixture",
    operation: "recoverSession",
    status: "success",
  }), "utf8");

  const store = new FileProtocolFixtureStore({ stateDir });
  const fixtures = await store.listFixtures();

  assert.deepEqual(fixtures, [{
    ref: "fixtures/protocol-probes/session-recovery.json",
    observedAt: "2026-07-04T03:00:00.000Z",
    operation: "recoverSession",
    status: "success",
  }]);
  assert.doesNotMatch(JSON.stringify(fixtures), /tabbit_session|secret/);
});

test("FileProtocolFixtureStore lists sanitized reset coupon consumption evidence fixtures", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "tabbit-probe-reset-coupon-list-"));
  await mkdir(path.join(stateDir, "fixtures", "protocol-probes"), { recursive: true });
  await writeFile(path.join(stateDir, "fixtures", "protocol-probes", "reset-coupon-consumption.json"), JSON.stringify({
    kind: "reset_coupon_consumption_evidence",
    operation: "consumeResetCoupon",
    status: "success",
    observedAt: "2026-07-04T03:10:00.000Z",
    evidence: {
      endpointHash: "sha256:endpoint-private-shape",
      bodyHash: "sha256:body-private-shape",
      resultHash: "sha256:result-private-shape",
      safe: true,
      sanitized: true,
      rawPayload: false,
    },
    result: {
      resetCouponConsumed: true,
      consumeResult: "success",
    },
    ignoredRaw: {
      cookie: "tabbit_session=secret",
      prompt: "placeholder prompt",
    },
  }), "utf8");
  await writeFile(path.join(stateDir, "fixtures", "protocol-probes", "unknown.json"), JSON.stringify({
    kind: "unknown_fixture",
    operation: "consumeResetCoupon",
    status: "success",
  }), "utf8");

  const store = new FileProtocolFixtureStore({ stateDir });
  const fixtures = await store.listFixtures();

  assert.deepEqual(fixtures, [{
    ref: "fixtures/protocol-probes/reset-coupon-consumption.json",
    observedAt: "2026-07-04T03:10:00.000Z",
    operation: "consumeResetCoupon",
    status: "success",
  }]);
  assert.doesNotMatch(JSON.stringify(fixtures), /tabbit_session|placeholder prompt|endpoint-private-shape|body-private-shape|result-private-shape/);
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
