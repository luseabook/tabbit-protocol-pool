import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { createPowerShellFetch } from "../src/powershell-fetch.js";

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

test("PowerShell fetch sends sensitive request data through stdin only", async () => {
  const secretCookie = "tabbit_session=fake_cookie_secret";
  const secretAuth = "Bearer fake_auth_secret";
  const rawBody = JSON.stringify({ prompt: "fake prompt secret", model: "Default" });
  let capturedInvocation = null;

  const fetchImpl = createPowerShellFetch({
    command: "pwsh-test",
    runPowerShell: async (invocation) => {
      capturedInvocation = invocation;
      return {
        status: 0,
        stdout: JSON.stringify({
          status: 201,
          headers: { "content-type": ["application/json"], "x-upstream": ["accepted"] },
          bodyBase64: encodedJson({ ok: true }),
        }),
        stderr: "",
      };
    },
  });

  const response = await fetchImpl("https://web.tabbit.ai/api/v1/chat/completion", {
    method: "POST",
    headers: {
      Cookie: secretCookie,
      Authorization: secretAuth,
      "content-type": "application/json",
    },
    body: rawBody,
  });

  assert.equal(response.status, 201);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), { ok: true });

  assert.ok(capturedInvocation);
  const commandLine = [capturedInvocation.command, ...capturedInvocation.args].join(" ");
  assert.doesNotMatch(commandLine, /fake_cookie_secret|fake_auth_secret|fake prompt secret|tabbit_session|Bearer/);

  const payload = JSON.parse(capturedInvocation.input);
  assert.equal(payload.url, "https://web.tabbit.ai/api/v1/chat/completion");
  assert.equal(payload.method, "POST");
  assert.equal(payload.headers.Cookie, secretCookie);
  assert.equal(payload.headers.Authorization, secretAuth);
  assert.equal(payload.bodyBase64, Buffer.from(rawBody, "utf8").toString("base64"));
});

test("PowerShell fetch redacts child process failures", async () => {
  const fetchImpl = createPowerShellFetch({
    runPowerShell: async () => ({
      status: 1,
      stdout: "",
      stderr: "upstream rejected Cookie tabbit_session=fake_cookie_secret body fake prompt secret",
    }),
  });

  await assert.rejects(
    () => fetchImpl("https://web.tabbit.ai/chat/sign-key", {
      headers: { Cookie: "tabbit_session=fake_cookie_secret" },
      body: "fake prompt secret",
    }),
    (error) => {
      const serialized = `${error.name}\n${error.message}\n${error.stack || ""}`;
      assert.match(error.message, /PowerShell fetch failed/);
      assert.doesNotMatch(serialized, /fake_cookie_secret|fake prompt secret|tabbit_session/);
      return true;
    },
  );
});
