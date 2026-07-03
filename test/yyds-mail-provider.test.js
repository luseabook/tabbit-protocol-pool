import test from "node:test";
import assert from "node:assert/strict";

import { MailProviderError, YYDSMailProvider, extractVerificationCode } from "../src/yyds-mail-provider.js";

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lowerHeaders[name.toLowerCase()] ?? null },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

test("createInbox posts localPart/domain using X-API-Key and normalizes response", async () => {
  let captured;
  const fetch = async (url, options) => {
    captured = { url, options };
    return jsonResponse({ id: "in_1", address: "tabbit@example.com", token: "temp-token", expiresAt: "2026-07-03T00:00:00.000Z" });
  };
  const provider = new YYDSMailProvider({ apiKey: "AC-test-key", fetch });

  const inbox = await provider.createInbox({ localPart: "tabbit", domain: "example.com" });

  assert.equal(captured.url, "https://maliapi.215.im/v1/accounts");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers["X-API-Key"], "AC-test-key");
  assert.equal(captured.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(captured.options.body), { localPart: "tabbit", domain: "example.com" });
  assert.deepEqual(inbox, { id: "in_1", address: "tabbit@example.com", tempToken: "temp-token", expiresAt: "2026-07-03T00:00:00.000Z" });
});

test("standard YYDS error envelope becomes MailProviderError", async () => {
  const provider = new YYDSMailProvider({
    apiKey: "AC-test-key",
    fetch: async () => jsonResponse({ success: false, error: "bad input", errorCode: "BAD_INPUT" }, { status: 400 }),
  });

  await assert.rejects(
    () => provider.createInbox({ localPart: "bad" }),
    (error) => {
      assert.equal(error instanceof MailProviderError, true);
      assert.equal(error.code, "BAD_INPUT");
      assert.equal(error.status, 400);
      assert.equal(error.retryAfterMs, null);
      assert.match(error.message, /bad input/);
      return true;
    },
  );
});

test("429 response records Retry-After in milliseconds", async () => {
  const provider = new YYDSMailProvider({
    apiKey: "AC-test-key",
    fetch: async () => jsonResponse({ success: false, error: "slow down", errorCode: "RATE_LIMITED" }, { status: 429, headers: { "Retry-After": "2" } }),
  });

  await assert.rejects(
    () => provider.createInbox({ localPart: "tabbit" }),
    (error) => {
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 2000);
      return true;
    },
  );
});

test("waitForVerificationCode polls messages, fetches details, and extracts code", async () => {
  const calls = [];
  const sleeps = [];
  const responses = [
    jsonResponse({ messages: [] }),
    jsonResponse({ messages: [{ id: "m1", subject: "Tabbit" }] }),
    jsonResponse({ id: "m1", subject: "Your verification code", text: "Use 123456 to continue" }),
  ];
  const provider = new YYDSMailProvider({
    apiKey: "AC-test-key",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    sleep: async (ms) => { sleeps.push(ms); },
  });

  const result = await provider.waitForVerificationCode({ address: "tabbit@example.com", timeoutMs: 30, intervalMs: 10 });

  assert.equal(result.code, "123456");
  assert.equal(result.message.id, "m1");
  assert.deepEqual(sleeps, [10]);
  assert.equal(calls[0].url, "https://maliapi.215.im/v1/messages?address=tabbit%40example.com");
  assert.equal(calls[2].url, "https://maliapi.215.im/v1/messages/m1?address=tabbit%40example.com");
});

test("waitForVerificationCode returns timeout when no message contains a code", async () => {
  const provider = new YYDSMailProvider({
    apiKey: "AC-test-key",
    fetch: async () => jsonResponse({ messages: [] }),
    sleep: async () => {},
  });

  await assert.rejects(
    () => provider.waitForVerificationCode({ address: "tabbit@example.com", timeoutMs: 20, intervalMs: 10 }),
    (error) => {
      assert.equal(error.code, "MAIL_TIMEOUT");
      return true;
    },
  );
});

test("extractVerificationCode handles subject, text, html, raw, and ambiguous messages", () => {
  assert.deepEqual(extractVerificationCode({ subject: "Tabbit code 246810" }), { code: "246810", source: "subject" });
  assert.deepEqual(extractVerificationCode({ text: "Your verification code is 123456" }), { code: "123456", source: "text" });
  assert.deepEqual(extractVerificationCode({ html: "<p>验证码：654321</p>" }), { code: "654321", source: "html" });
  assert.deepEqual(extractVerificationCode({ raw: "verification code: 112233" }), { code: "112233", source: "raw" });
  assert.throws(() => extractVerificationCode({ text: "codes 123456 and 654321" }), /ambiguous/i);
});
