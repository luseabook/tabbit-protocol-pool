import test from "node:test";
import assert from "node:assert/strict";

import { redactObject, redactSensitiveValue } from "../src/redact.js";

test("redactSensitiveValue masks API keys, cookies, bearer tokens, emails, and codes", () => {
  assert.equal(redactSensitiveValue("AC-abcdef123456"), "AC-***");
  assert.equal(redactSensitiveValue("Authorization: Bearer token-secret-123"), "Authorization: Bearer ***");
  assert.equal(redactSensitiveValue("next-auth.session-token=secret-cookie-value"), "next-auth.session-token=***");
  assert.match(redactSensitiveValue("user@example.com"), /^us\*+@[a-z0-9.-]+$/);
  assert.equal(redactSensitiveValue("Your verification code is 123456"), "Your verification code is ***");
});

test("redactObject recursively masks sensitive fields without mutating input", () => {
  const input = {
    apiKey: "AC-secret-value",
    nested: { cookie: "session=secret-cookie" },
    list: ["code 654321"],
  };
  const output = redactObject(input);

  assert.equal(output.apiKey, "AC-***");
  assert.equal(output.nested.cookie, "session=***");
  assert.equal(output.list[0], "code ***");
  assert.equal(input.apiKey, "AC-secret-value");
});
