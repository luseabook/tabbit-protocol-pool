import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProtocolPoolGateway, createSecretHydratingProtocolClientFactory } from "../src/protocol-pool-gateway.js";

const NOW = Date.parse("2026-07-02T03:00:00.000Z");

async function tempStateDir() {
  return await mkdtemp(join(tmpdir(), "tabbit-gateway-"));
}

async function writeAccounts(stateDir, accounts) {
  await writeFile(join(stateDir, "accounts.json"), JSON.stringify({
    version: 1,
    updatedAt: "2026-07-02T00:00:00.000Z",
    accounts,
  }, null, 2), "utf8");
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function withServer(server, fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await closeServer(server);
  }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function requestText(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lowerHeaders[name.toLowerCase()] ?? null },
    async json() { return body; },
    async text() { return typeof body === "string" ? body : JSON.stringify(body); },
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function streamingTextResponse({ firstChunk, secondChunk, releaseSecond, contentType = "text/event-stream", status = 200 }) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      await releaseSecond.promise;
      controller.enqueue(encoder.encode(secondChunk));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    body,
    async text() {
      throw new Error("streaming gateway response should not be buffered through text()");
    },
  };
}

async function readUntil(reader, decoder, pattern) {
  let text = "";
  while (!pattern.test(text)) {
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), 1000)),
    ]);
    if (next.done) return text;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

test("gateway factory wires stored accounts through chat completions and persists success", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [{
    id: "acct_a",
    status: "active",
    accessTier: "unknown",
    cookieJarRef: "secrets/acct_a.cookie",
  }]);
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_API_KEY: "sk-tabbit-local",
      TABBIT_POOL_RETRY_LIMIT: "0",
    },
    now: () => NOW,
    compatNow: () => 1782961200,
    idFactory: (kind) => `${kind}_gateway_test`,
    protocolClientFactory: (account) => ({
      async sendMessage(input) {
        calls.push({ account, input });
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "gateway ok" }],
          selectedModel: input.model,
        };
      },
    }),
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.id, "chat_gateway_test");
    assert.equal(response.body.choices[0].message.content, "gateway ok");
    assert.equal(response.body.metadata.account_id, "acct_a");
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].account.id, "acct_a");
  assert.equal(calls[0].input.messages[0].content, "hello");

  const raw = JSON.parse(await readFile(join(stateDir, "accounts.json"), "utf8"));
  assert.equal(raw.accounts[0].lastSuccessAt, "2026-07-02T03:00:00.000Z");
  assert.equal(raw.accounts[0].audit.at(-1).type, "success");
});

test("gateway passes compat strip client tools option to OpenAI handler", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [{
    id: "acct_strip_tools",
    status: "active",
    accessTier: "unknown",
  }]);
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_API_KEY: "sk-tabbit-local",
      TABBIT_POOL_RETRY_LIMIT: "0",
      TABBIT_POOL_COMPAT_STRIP_CLIENT_TOOLS: "true",
    },
    protocolClientFactory: () => ({
      async sendMessage(input) {
        calls.push(input);
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "stripped" }],
          selectedModel: input.model,
        };
      },
    }),
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        input: "hello",
        tools: [
          { type: "function", name: "update_plan", parameters: { type: "object" } },
          { type: "function", name: "request_user_input", parameters: { type: "object" } },
          { type: "function", name: "view_image", parameters: { type: "object" } },
        ],
        tool_choice: "auto",
        parallel_tool_calls: false,
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.output_text, "stripped");
  });

  assert.equal(calls[0].tools, null);
  assert.equal(calls[0].toolChoice, null);
  assert.equal(calls[0].parallelToolCalls, null);
});

test("gateway local tool loop mode executes injected tools without native protocol tool fields", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [{
    id: "acct_local_tools",
    status: "active",
    accessTier: "unknown",
  }]);
  const sendCalls = [];
  const toolCalls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_API_KEY: "sk-tabbit-local",
      TABBIT_POOL_RETRY_LIMIT: "0",
      TABBIT_POOL_TOOL_LOOP_MODE: "local_executes_tools",
    },
    idFactory: (kind) => `${kind}_local_tool_loop`,
    protocolClientFactory: () => ({
      async sendMessage(input) {
        sendCalls.push(input);
        const hasToolResult = input.messages.some((message) => message.role === "tool");
        if (!hasToolResult) {
          return {
            ok: true,
            contentBlocks: [{
              type: "text",
              text: JSON.stringify({
                type: "tool_use",
                id: "call_lookup",
                name: "lookup",
                input: { query: "tabbit" },
              }),
            }],
            selectedModel: input.model,
          };
        }
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "lookup result accepted" }],
          selectedModel: input.model,
        };
      },
    }),
    localToolExecutor: {
      async execute(call) {
        toolCalls.push(call);
        return { result: "found" };
      },
    },
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "lookup tabbit" }],
        tools: [{
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object" },
          },
        }],
        tool_choice: "auto",
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].message.content, "lookup result accepted");
  });

  assert.equal(sendCalls.length, 2);
  assert.equal(sendCalls[0].tools, null);
  assert.equal(sendCalls[0].toolChoice, null);
  assert.equal(sendCalls[0].parallelToolCalls, null);
  assert.deepEqual(toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    input: call.input,
  })), [{
    id: "call_lookup",
    name: "lookup",
    input: { query: "tabbit" },
  }]);
  assert.deepEqual(sendCalls[1].messages.at(-1), {
    role: "tool",
    tool_call_id: "call_lookup",
    content: "{\"result\":\"found\"}",
  });
});

test("gateway default protocol client uses explicit protocol env sendPath", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [{
    id: "acct_protocol_env",
    status: "active",
    accessTier: "unknown",
    cookieJarRef: "secrets/acct_protocol_env.cookie",
  }]);
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await writeFile(join(stateDir, "secrets", "acct_protocol_env.cookie"), "tabbit_session=protocol-env", "utf8");
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_API_KEY: "sk-tabbit-local",
      TABBIT_POOL_RETRY_LIMIT: "0",
      TABBIT_POOL_PROTOCOL_SEND_PATH: "/chat/send",
    },
    now: () => NOW,
    compatNow: () => 1782961200,
    idFactory: (kind) => `${kind}_protocol_env`,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-gateway-env");
      return jsonResponse({ text: "gateway protocol env ok" }, { headers: { "content-type": "application/json" } });
    },
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].message.content, "gateway protocol env ok");
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://web.tabbit.ai/chat/sign-key");
  assert.equal(calls[1].url, "https://web.tabbit.ai/chat/send");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=protocol-env");
});

test("gateway default protocol client wires restored chat completion env options", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [{
    id: "acct_real_protocol_env",
    status: "active",
    accessTier: "unknown",
    cookieJarRef: "secrets/acct_real_protocol_env.cookie",
  }]);
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await writeFile(join(stateDir, "secrets", "acct_real_protocol_env.cookie"), "tabbit_session=real-protocol-env", "utf8");
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_API_KEY: "sk-tabbit-local",
      TABBIT_POOL_RETRY_LIMIT: "0",
      TABBIT_POOL_PROTOCOL_BASE_URL: "https://web.tabbit.ai",
      TABBIT_POOL_PROTOCOL_SEND_PATH: "/api/v1/chat/completion",
      TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID: "session_from_env",
      TABBIT_POOL_PROTOCOL_REQ_CTX: "ctx-from-env",
    },
    now: () => 1783034819752,
    compatNow: () => 1782961200,
    idFactory: (kind) => `${kind}_real_protocol_env`,
    protocolClientOptions: {
      signature: () => "00000000-0000-4000-8000-000000000000",
      uniqueUuid: () => "660001aa-2222-3333-4444-555555555555",
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("f8d0e6a73f8d4b1a9c3d2e1f9a4b7c6d");
      return jsonResponse([
        "event: message_chunk",
        "data: {\"content\":\"real env ok\"}",
        "",
        "event: finish",
        "data: {}",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    },
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].message.content, "real env ok");
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://web.tabbit.ai/chat/sign-key");
  assert.equal(calls[1].url, "https://web.tabbit.ai/api/v1/chat/completion");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=real-protocol-env");
  assert.equal(calls[1].options.headers["x-req-ctx"], "ctx-from-env");
  assert.equal(calls[1].options.headers["unique-uuid"], "660001aa-2222-3333-4444-555555555555");
  assert.equal(JSON.parse(calls[1].options.body).chat_session_id, "session_from_env");
  assert.equal(JSON.parse(calls[1].options.body).selected_model, "Default");
});

test("gateway default protocol client uses explicit attachment upload path with hydrated cookies", async () => {
  const stateDir = await tempStateDir();
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await writeFile(join(stateDir, "secrets", "acct_upload.cookie"), "tabbit_session=protocol-upload", "utf8");
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH: "/chat/attachments/upload",
    },
    now: () => NOW,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-gateway-upload");
      return jsonResponse({ data: { attachmentId: "att_gateway", filename: "gateway.png" } }, { headers: { "content-type": "application/json" } });
    },
  });

  const client = gateway.protocolClientFactory({
    id: "acct_upload",
    cookieJarRef: "secrets/acct_upload.cookie",
  });
  const result = await client.uploadAttachment({
    attachment: { filename: "gateway.png", mimeType: "image/png", data: "base64-payload" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.attachment, {
    id: "att_gateway",
    name: "gateway.png",
    mimeType: null,
    size: null,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://web.tabbit.ai/chat/attachments/upload");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=protocol-upload");
});

test("gateway chat completions auto uploads raw attachments through configured COS paths", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [{
    id: "acct_raw_upload",
    status: "active",
    accessTier: "unknown",
    cookieJarRef: "secrets/acct_raw_upload.cookie",
  }]);
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await writeFile(join(stateDir, "secrets", "acct_raw_upload.cookie"), "tabbit_session=protocol-raw-upload", "utf8");
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_API_KEY: "sk-tabbit-local",
      TABBIT_POOL_RETRY_LIMIT: "0",
      TABBIT_POOL_PROTOCOL_SEND_PATH: "/api/v1/chat/completion",
      TABBIT_POOL_PROTOCOL_CHAT_SESSION_ID: "session_from_env",
      TABBIT_POOL_PROTOCOL_ATTACHMENT_UPLOAD_PATH: "/proxy/v0/cos/presigned-upload-url",
      TABBIT_POOL_PROTOCOL_ATTACHMENT_COMPLETE_UPLOAD_PATH: "/api/v0/cos/complete-upload",
    },
    now: () => 1783034819752,
    compatNow: () => 1782961200,
    idFactory: (kind) => `${kind}_raw_upload`,
    protocolClientOptions: {
      signature: () => "00000000-0000-4000-8000-000000000000",
      uniqueUuid: () => "660001aa-2222-3333-4444-555555555555",
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/proxy/v0/cos/presigned-upload-url")) {
        return jsonResponse({
          url: "https://cos.example.test/upload/gateway-notes.txt",
          file_id: "file_gateway_raw",
        }, { headers: { "content-type": "application/json" } });
      }
      if (url === "https://cos.example.test/upload/gateway-notes.txt") {
        return jsonResponse("", { headers: { "content-type": "text/plain" } });
      }
      if (url.endsWith("/api/v0/cos/complete-upload")) {
        return jsonResponse({ success: true }, { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/chat/sign-key")) return jsonResponse("f8d0e6a73f8d4b1a9c3d2e1f9a4b7c6d");
      return jsonResponse([
        "event: message_chunk",
        "data: {\"content\":\"uploaded\"}",
        "",
        "event: finish",
        "data: {}",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    },
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        messages: [{ role: "user", content: "read attachment" }],
        attachments: [{
          filename: "gateway-notes.txt",
          mimeType: "text/plain",
          data: "gateway raw text",
        }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].message.content, "uploaded");
  });

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/proxy/v0/cos/presigned-upload-url",
    "/upload/gateway-notes.txt",
    "/api/v0/cos/complete-upload",
    "/chat/sign-key",
    "/api/v1/chat/completion",
  ]);
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=protocol-raw-upload");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    file_category: "document",
    original_filename: "gateway-notes.txt",
    content_type: "text/plain",
  });
  assert.equal(Buffer.from(calls[1].options.body).toString("utf8"), "gateway raw text");
  assert.deepEqual(JSON.parse(calls[2].options.body), { file_id: "file_gateway_raw" });
  const sendBody = JSON.parse(calls[4].options.body);
  assert.deepEqual(sendBody.references, [{
    type: "document",
    title: "gateway-notes.txt",
    content: "",
    metadata: { file_id: "file_gateway_raw" },
  }]);
});

test("gateway protocol client refreshQuota uses explicit quota path with hydrated cookies", async () => {
  const stateDir = await tempStateDir();
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await writeFile(join(stateDir, "secrets", "acct_quota.cookie"), "tabbit_session=protocol-quota", "utf8");
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_QUOTA_USAGE_PATH: "/api/commerce/quota/v1/usage",
    },
    now: () => NOW,
    protocolClientOptions: {
      uniqueUuid: () => "00000000-0000-4000-8000-000000000002",
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        member_level: "free",
        usage_percentage: "31.37%",
        current_cycle_end: "2026.07.10",
        unused_reset_coupon_count: 0,
      }, { headers: { "content-type": "application/json" } });
    },
  });

  const client = gateway.protocolClientFactory({
    id: "acct_quota",
    userId: "user_gateway_quota",
    cookieJarRef: "secrets/acct_quota.cookie",
  });
  const result = await client.refreshQuota();

  assert.equal(result.ok, true);
  assert.equal(result.source, "tabbit-quota-usage");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/quota/v1/usage?user_id=user_gateway_quota");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=protocol-quota");
  assert.equal(calls[0].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000002");
});

test("gateway protocol client wires read-only benefits paths with hydrated cookies", async () => {
  const stateDir = await tempStateDir();
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await writeFile(join(stateDir, "secrets", "acct_benefits.cookie"), "tabbit_session=protocol-benefits", "utf8");
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_PROTOCOL_NEWBIE_EXPLORATION_PATH: "/api/commerce/activity/v1/newbie-exploration/me",
      TABBIT_POOL_PROTOCOL_REWARD_CARD_RECORDS_PATH: "/api/commerce/reward/v1/card-records",
      TABBIT_POOL_PROTOCOL_PLACEMENT_RESOURCES_PATH: "/api/commerce/placement/v1/resources",
      TABBIT_POOL_PROTOCOL_SIGN_IN_STATUS_PATH: "/api/commerce/activity/v1/sign-in/status",
      TABBIT_POOL_PROTOCOL_BENEFIT_COUPON_LIST_PATH: "/api/commerce/benefit/v1/coupon/list",
    },
    now: () => NOW,
    protocolClientOptions: {
      uniqueUuid: () => "00000000-0000-4000-8000-000000000005",
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/newbie-exploration/")) {
        return jsonResponse({
          view_mode: "activity_page",
          visible: false,
          status: "not_available",
        }, { headers: { "content-type": "application/json" } });
      }
      if (url.includes("/sign-in/status")) {
        return jsonResponse({
          sign_in_date: "2026-07-03",
          results: [{ scene_code: "desktop_pet", signed_today: false }],
        }, { headers: { "content-type": "application/json" } });
      }
      return jsonResponse({ total: 0, records: [] }, { headers: { "content-type": "application/json" } });
    },
  });

  const client = gateway.protocolClientFactory({
    id: "acct_benefits",
    userId: "user_gateway_benefits",
    cookieJarRef: "secrets/acct_benefits.cookie",
  });
  const newbie = await client.getNewbieExplorationMe({ viewMode: "activity_page" });
  const reward = await client.listRewardCardRecords({ limit: 10 });
  const placement = await client.getPlacementResources({ placementCode: "home.input_below" });
  const signIn = await client.getDailySignInStatus({ sceneCodes: ["desktop_pet"] });
  const coupons = await client.listBenefitCoupons({ limit: 50 });

  assert.equal(newbie.ok, true);
  assert.equal(reward.ok, true);
  assert.equal(placement.ok, true);
  assert.equal(signIn.ok, true);
  assert.equal(coupons.ok, true);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/activity/v1/newbie-exploration/me?view_mode=activity_page&include_completions=true&include_rewards=true");
  assert.equal(calls[1].url, "https://web.tabbit.ai/api/commerce/reward/v1/card-records?user_id=user_gateway_benefits&offset=0&limit=10&order.field=award_time&order.order=desc");
  assert.equal(calls[2].url, "https://web.tabbit.ai/api/commerce/placement/v1/resources?placement_code=home.input_below");
  assert.equal(calls[3].url, "https://web.tabbit.ai/api/commerce/activity/v1/sign-in/status?scene_codes=desktop_pet");
  assert.equal(calls[4].url, "https://web.tabbit.ai/api/commerce/benefit/v1/coupon/list?user_id=user_gateway_benefits&coupon_type=weekly_reset_coupon&offset=0&limit=50");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=protocol-benefits");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=protocol-benefits");
  assert.equal(calls[2].options.headers.Cookie, "tabbit_session=protocol-benefits");
  assert.equal(calls[3].options.headers.Cookie, "tabbit_session=protocol-benefits");
  assert.equal(calls[4].options.headers.Cookie, "tabbit_session=protocol-benefits");
});

test("gateway stream preserves configured protocol SSE text deltas as separate OpenAI chat chunks", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [{
    id: "acct_protocol_stream",
    status: "active",
    accessTier: "unknown",
    cookieJarRef: "secrets/acct_protocol_stream.cookie",
  }]);
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await writeFile(join(stateDir, "secrets", "acct_protocol_stream.cookie"), "tabbit_session=protocol-stream", "utf8");
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_API_KEY: "sk-tabbit-local",
      TABBIT_POOL_RETRY_LIMIT: "0",
      TABBIT_POOL_PROTOCOL_SEND_PATH: "/chat/send",
    },
    now: () => NOW,
    compatNow: () => 1782961200,
    idFactory: (kind) => `${kind}_protocol_stream`,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-gateway-stream");
      return jsonResponse([
        "data: {\"delta\":\"Hel\"}",
        "",
        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}",
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    },
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestText(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.ok(response.contentType?.startsWith("text/event-stream"));
    assert.match(response.body, /"delta":\{"content":"Hel"\}/);
    assert.match(response.body, /"delta":\{"content":"lo"\}/);
    assert.doesNotMatch(response.body, /"delta":\{"content":"Hello"\}/);
    assert.equal((response.body.match(/"delta":\{"content":/g) || []).length, 2);
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://web.tabbit.ai/chat/send");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=protocol-stream");
});

test("gateway streams configured protocol SSE body before upstream completion", async () => {
  const stateDir = await tempStateDir();
  const releaseSecond = createDeferred();
  await writeAccounts(stateDir, [{
    id: "acct_protocol_async_stream",
    status: "active",
    accessTier: "unknown",
    cookieJarRef: "secrets/acct_protocol_async_stream.cookie",
  }]);
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await writeFile(join(stateDir, "secrets", "acct_protocol_async_stream.cookie"), "tabbit_session=protocol-async-stream", "utf8");
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_API_KEY: "sk-tabbit-local",
      TABBIT_POOL_RETRY_LIMIT: "0",
      TABBIT_POOL_PROTOCOL_SEND_PATH: "/chat/send",
    },
    now: () => NOW,
    compatNow: () => 1782961200,
    idFactory: (kind) => `${kind}_protocol_async_stream`,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-gateway-async-stream");
      return streamingTextResponse({
        firstChunk: 'data: {"delta":"Hel"}\n\n',
        secondChunk: 'data: {"delta":"lo"}\n\ndata: [DONE]\n\n',
        releaseSecond,
      });
    },
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-tabbit-local",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tabbit/priority",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith("text/event-stream"));
    assert.equal(response.headers.has("content-length"), false);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const beforeSecond = await readUntil(reader, decoder, /"delta":\{"content":"Hel"\}/);

    assert.match(beforeSecond, /"delta":\{"content":"Hel"\}/);
    assert.doesNotMatch(beforeSecond, /"delta":\{"content":"lo"\}/);

    releaseSecond.resolve();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value, { stream: true });
    }
    rest += decoder.decode();

    assert.match(rest, /"delta":\{"content":"lo"\}/);
    assert.match(rest, /data: \[DONE\]/);
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://web.tabbit.ai/chat/send");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=protocol-async-stream");
});

test("gateway default models provider uses explicit protocol env model catalog path", async () => {
  const stateDir = await tempStateDir();
  const calls = [];
  const gateway = await createProtocolPoolGateway({
    env: {
      TABBIT_POOL_STATE_DIR: stateDir,
      TABBIT_POOL_API_KEY: "sk-tabbit-local",
      TABBIT_POOL_PROTOCOL_MODEL_CATALOG_PATH: "/proxy/v1/model_config/models",
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        data: [{
          model: "Gemini-2.5-Pro",
          label: "Gemini 2.5 Pro",
          supportsTools: true,
          supportsImages: true,
          modelAccessType: "pro",
        }],
      }, { headers: { "content-type": "application/json" } });
    },
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/models", {
      headers: { Authorization: "Bearer sk-tabbit-local" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.map((model) => model.id), [
      "tabbit/priority",
      "tabbit/Gemini-2.5-Pro",
    ]);
    assert.equal(response.body.data[1].supports_tools, true);
    assert.equal(response.body.data[1].supports_images, true);
    assert.equal(response.body.data[1].model_access_type, "pro");
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/proxy/v1/model_config/models?a=0&scene=chat");
  assert.equal(calls[0].options.method, "GET");
});

test("gateway exposes injected models provider and starts on the local default host", async () => {
  const stateDir = await tempStateDir();
  const gateway = await createProtocolPoolGateway({
    env: { TABBIT_POOL_STATE_DIR: stateDir },
    protocolClientFactory: () => ({
      async sendMessage() {
        throw new Error("not used");
      },
    }),
    modelsProvider: async () => [{
      id: "tabbit/priority",
      selectedModel: null,
      supports_tools: true,
      supports_images: false,
      model_access_type: "priority",
    }],
  });

  assert.equal(gateway.config.host, "127.0.0.1");

  await gateway.start({ port: 0 });
  try {
    const { address, port } = gateway.server.address();
    assert.equal(address, "127.0.0.1");
    const response = await requestJson(`http://127.0.0.1:${port}`, "/v1/models", {
      headers: { "x-api-key": "sk-tabbit-local" },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      object: "list",
      data: [{
        id: "tabbit/priority",
        object: "model",
        owned_by: "tabbit",
        tabbit_selected_model: null,
        supports_tools: true,
        supports_images: false,
        model_access_type: "priority",
      }],
    });
  } finally {
    await gateway.close();
  }

  assert.equal(gateway.server.listening, false);
});

test("gateway default health exposes redacted account summary", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [
    {
      id: "acct_health_active",
      email: "health-active@example.test",
      status: "active",
      cookieJarRef: "secrets/acct_health_active.cookie",
      cookieHeader: "tabbit_session=secret",
    },
    {
      id: "acct_health_expired",
      email: "expired@example.test",
      status: "login_expired",
      token: "secret-token",
      lastError: { category: "login_required", message: "expired@example.test session=secret" },
    },
  ]);

  const gateway = await createProtocolPoolGateway({
    env: { TABBIT_POOL_STATE_DIR: stateDir },
    now: () => NOW,
    protocolClientFactory: () => ({
      async sendMessage() {
        throw new Error("not used");
      },
    }),
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/health");

    assert.equal(response.status, 200);
    assert.equal(response.body.status, "degraded");
    assert.equal(response.body.mode, "protocol-pool");
    assert.equal(response.body.accounts.total, 2);
    assert.equal(response.body.accounts.active, 1);
    assert.equal(response.body.accounts.byStatus.login_expired, 1);
    assert.equal(JSON.stringify(response.body).includes("health-active@example.test"), false);
    assert.equal(JSON.stringify(response.body).includes("cookieJarRef"), false);
    assert.equal(JSON.stringify(response.body).includes("tabbit_session"), false);
    assert.equal(JSON.stringify(response.body).includes("secret-token"), false);
  });
});

test("gateway hydrates cookieJarRef from the secret store without persisting raw cookies", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [{
    id: "acct_secret_ref",
    status: "active",
    cookieJarRef: "secrets/acct_secret_ref.cookie",
  }]);
  await mkdir(join(stateDir, "secrets"), { recursive: true });
  await writeFile(join(stateDir, "secrets", "acct_secret_ref.cookie"), "placeholder-cookie-value", "utf8");
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: { TABBIT_POOL_STATE_DIR: stateDir },
    now: () => NOW,
    protocolClientFactory: (account) => ({
      async sendMessage(input) {
        calls.push({ factoryAccount: account, inputAccount: input.account });
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "hydrated" }],
          selectedModel: input.model,
        };
      },
    }),
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.choices[0].message.content, "hydrated");
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].factoryAccount.cookieHeader, "placeholder-cookie-value");
  assert.equal(calls[0].inputAccount.cookieHeader, "placeholder-cookie-value");
  const raw = JSON.parse(await readFile(join(stateDir, "accounts.json"), "utf8"));
  assert.equal(raw.accounts[0].cookie, undefined);
  assert.equal(raw.accounts[0].cookieHeader, undefined);
  assert.equal(raw.accounts[0].cookieJarRef, "secrets/acct_secret_ref.cookie");
});

test("secret hydrating protocol factory forwards verifySession with stored session", async () => {
  const calls = [];
  const secretStore = {
    async readSecret(ref) {
      calls.push(["readSecret", ref]);
      return "tabbit_session=hydrated";
    },
  };
  const factory = createSecretHydratingProtocolClientFactory((account) => ({
    async verifySession(input) {
      calls.push(["verifySession", input.account.id, input.account.cookieHeader, input.session]);
      return { ok: true, userId: "user_hydrated" };
    },
  }), secretStore);

  const client = factory({ id: "acct_a", cookieJarRef: "secrets/acct_a.cookie" });
  const result = await client.verifySession({ account: { id: "acct_a", cookieJarRef: "secrets/acct_a.cookie" } });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["readSecret", "secrets/acct_a.cookie"],
    ["verifySession", "acct_a", "tabbit_session=hydrated", "tabbit_session=hydrated"],
  ]);
});

test("gateway wires Anthropic Messages through the same pooled runner", async () => {
  const stateDir = await tempStateDir();
  await writeAccounts(stateDir, [{ id: "acct_anthropic", status: "active" }]);
  const calls = [];

  const gateway = await createProtocolPoolGateway({
    env: { TABBIT_POOL_STATE_DIR: stateDir },
    now: () => NOW,
    compatNow: () => 1782961200,
    idFactory: (kind) => `${kind}_gateway_anthropic`,
    protocolClientFactory: (account) => ({
      async sendMessage(input) {
        calls.push({ account, input });
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "anthropic gateway ok" }],
          selectedModel: input.model,
        };
      },
    }),
  });

  await withServer(gateway.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-tabbit-local", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "tabbit/priority",
        system: "system prompt",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.id, "message_gateway_anthropic");
    assert.equal(response.body.type, "message");
    assert.deepEqual(response.body.content, [{ type: "text", text: "anthropic gateway ok" }]);
    assert.equal(response.body.metadata.account_id, "acct_anthropic");
  });

  assert.deepEqual(calls[0].input.messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "hello" },
  ]);
});
