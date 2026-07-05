import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  ProtocolTabbitClient,
  buildSignaturePayload,
  canonicalJson,
  createSignedHeaders,
  normalizeModelCatalog,
  classifyProtocolError,
} from "../src/protocol-tabbit-client.js";

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
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      return text + decoder.decode();
    },
  };
}

function cancellableStreamingTextResponse({ firstChunk, releaseSecond, contentType = "text/event-stream" }) {
  const encoder = new TextEncoder();
  const cancellation = createDeferred();
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      await releaseSecond.promise;
      controller.enqueue(encoder.encode("data: {\"delta\":\"late\"}\n\n"));
      controller.close();
    },
    cancel(reason) {
      cancellation.resolve(reason);
    },
  });
  return {
    response: {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
      body,
      async text() { throw new Error("text() should not be used for async stream response"); },
    },
    cancellation,
  };
}

function expectedHmac(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

test("canonicalJson sorts object keys recursively", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), "{\"a\":{\"c\":3,\"d\":4},\"b\":2}");
});

test("createSignedHeaders signs deterministic method path query and body", () => {
  const payload = buildSignaturePayload({
    method: "post",
    path: "/chat/send",
    query: { b: "2", a: "1" },
    body: { z: 1, a: "x" },
    timestamp: 1700000000000,
    nonce: "nonce-1",
  });
  assert.equal(payload, "POST\n/chat/send?a=1&b=2\n1700000000000\nnonce-1\n{\"a\":\"x\",\"z\":1}");

  const headers = createSignedHeaders({
    method: "post",
    path: "/chat/send",
    query: { b: "2", a: "1" },
    body: { z: 1, a: "x" },
    signKey: "secret",
    timestamp: 1700000000000,
    nonce: "nonce-1",
  });

  assert.deepEqual(headers, {
    "x-timestamp": "1700000000000",
    "x-nonce": "nonce-1",
    "x-signature": expectedHmac("secret", payload),
  });
});

test("createSignedHeaders matches browser HMAC over timestamp signature and body hash", () => {
  const bodyText = JSON.stringify({ content: "hello", selected_model: "Default" });
  const headers = createSignedHeaders({
    bodyText,
    signKey: "f8d0e6a73f8d4b1a9c3d2e1f9a4b7c6d",
    timestamp: 1783034819752,
    signature: "00000000-0000-4000-8000-000000000000",
  });

  assert.deepEqual(headers, {
    "x-timestamp": "1783034819752",
    "x-nonce": "152d4b334c608ae46126b3017f2b36807949443c6044bccc0b6180cdc31bf824",
    "x-signature": "00000000-0000-4000-8000-000000000000",
  });
});

test("getSignKey fetches sign-key once and reuses cache until ttl expires", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse("sign-key-1");
    },
    now: () => 1000,
    signKeyTtlMs: 5000,
  });

  assert.equal(await client.getSignKey(), "sign-key-1");
  assert.equal(await client.getSignKey(), "sign-key-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/chat/sign-key");
  assert.equal(calls[0].options.method, "GET");
});

test("normalizeModelCatalog maps upstream models and injects tabbit priority alias", () => {
  const models = normalizeModelCatalog({
    models: [
      { id: "Claude-Sonnet-4.6", displayName: "Claude Sonnet", supportsTools: true, supportsImages: true, modelAccessType: "pro" },
      { name: "DeepSeek-V4", title: "DeepSeek V4", supportTool: false, supportImage: false, access: "free" },
    ],
  });

  assert.equal(models[0].id, "tabbit/priority");
  assert.equal(models[0].selectedModel, null);
  assert.equal(models[0].supports_tools, true);
  assert.deepEqual(models.slice(1), [
    {
      id: "tabbit/Claude-Sonnet-4.6",
      selectedModel: "Claude-Sonnet-4.6",
      displayName: "Claude Sonnet",
      tabbit_display_name: "Claude Sonnet",
      supports_tools: true,
      supports_images: true,
      model_access_type: "pro",
      requires_premium: true,
      available_in_tabbit_catalog: true,
    },
    {
      id: "tabbit/DeepSeek-V4",
      selectedModel: "DeepSeek-V4",
      displayName: "DeepSeek V4",
      tabbit_display_name: "DeepSeek V4",
      supports_tools: false,
      supports_images: false,
      model_access_type: "free",
      requires_premium: false,
      available_in_tabbit_catalog: true,
    },
  ]);
});

test("normalizeModelCatalog maps real Tabbit display_name model catalog entries", () => {
  const models = normalizeModelCatalog({
    status: "ok",
    models: [
      { display_name: "Default", supports_tools: true, supports_images: true, model_access_type: "free_unlimited" },
      { display_name: "Kimi-K2.7-Code", supports_tools: true, supports_images: true, model_access_type: "free_metered" },
      { display_name: "Claude-Opus-4.7", supports_tools: true, supports_images: true, model_access_type: "premium_only" },
      { display_name: "Claude-Opus-4.8", supports_tools: true, supports_images: true, model_access_type: "premium_only" },
      { display_name: "GPT-5.5", supports_tools: true, supports_images: true, model_access_type: "premium_only" },
    ],
  });

  assert.deepEqual(models.map((model) => [model.id, model.selectedModel, model.model_access_type]), [
    ["tabbit/priority", null, "priority"],
    ["tabbit/Default", "Default", "free_unlimited"],
    ["tabbit/Kimi-K2.7-Code", "Kimi-K2.7-Code", "free_metered"],
    ["tabbit/Claude-Opus-4.8", "Claude-Opus-4.8", "premium_only"],
    ["tabbit/GPT-5.5", "GPT-5.5", "premium_only"],
  ]);
  assert.deepEqual(models.map((model) => [model.id, model.requires_premium]), [
    ["tabbit/priority", false],
    ["tabbit/Default", false],
    ["tabbit/Kimi-K2.7-Code", false],
    ["tabbit/Claude-Opus-4.8", true],
    ["tabbit/GPT-5.5", true],
  ]);
});

test("listModels fetches Tabbit catalog with a=0 and reuses cache", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ data: [{ model: "Gemini-2.5-Pro", label: "Gemini 2.5 Pro" }] }, { headers: { "content-type": "application/json" } });
    },
    now: () => 2000,
    modelCatalogTtlMs: 10_000,
  });

  const first = await client.listModels();
  const second = await client.listModels();

  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/proxy/v1/model_config/models?a=0&scene=chat");
  assert.equal(first[1].id, "tabbit/Gemini-2.5-Pro");
});

test("sendMessage builds a signed POST to configured sendPath", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-send",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return jsonResponse("sign-key-send");
      return jsonResponse({ text: "hello from protocol" }, { headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contentBlocks, [{ type: "text", text: "hello from protocol" }]);
  assert.equal(result.selectedModel, "Claude-Sonnet-4.6");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://web.tabbit.ai/chat/send");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers.Cookie, "placeholder-cookie-valuebc");
  assert.equal(calls[1].options.headers["x-timestamp"], "1700000000000");
  assert.equal(calls[1].options.headers["x-nonce"], "nonce-send");
  assert.equal(typeof calls[1].options.headers["x-signature"], "string");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
});

test("sendMessage builds the restored Tabbit chat completion request body and headers", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    baseUrl: "https://web.tabbit.ai",
    sendPath: "/api/v1/chat/completion",
    reqCtx: "MS4zLjI2KDEwMTAzMDI2KQ==",
    uniqueUuid: () => "660001aa-2222-3333-4444-555555555555",
    signature: () => "00000000-0000-4000-8000-000000000000",
    now: () => 1783034819752,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return jsonResponse("f8d0e6a73f8d4b1a9c3d2e1f9a4b7c6d");
      return jsonResponse([
        "event: ready",
        "data: {\"chat_session_id\":\"session_live\"}",
        "",
        "event: message_chunk",
        "data: {\"content\":\"ok\"}",
        "",
        "event: finish",
        "data: {}",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    },
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    chatSessionId: "session_live",
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contentBlocks, [{ type: "text", text: "ok" }]);
  assert.equal(result.selectedModel, "Default");
  assert.equal(calls[1].url, "https://web.tabbit.ai/api/v1/chat/completion");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers.Cookie, "placeholder-cookie-valuebc");
  assert.equal(calls[1].options.headers.accept, "text/event-stream");
  assert.equal(calls[1].options.headers["cache-control"], "no-cache");
  assert.equal(calls[1].options.headers["x-req-ctx"], "MS4zLjI2KDEwMTAzMDI2KQ==");
  assert.equal(calls[1].options.headers["unique-uuid"], "660001aa-2222-3333-4444-555555555555");
  assert.equal(calls[1].options.headers["x-signature"], "00000000-0000-4000-8000-000000000000");
  assert.equal(calls[1].options.headers["x-nonce"], "0af599161688fe97359a52018d0fba9582f6b16aaeb384965a7fffadb3aea416");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    chat_session_id: "session_live",
    message_id: null,
    content: "hello",
    selected_model: "Default",
    parallel_group_id: null,
    task_name: "chat",
    agent_mode: false,
    metadatas: { html_content: "<p>hello</p>" },
    references: [],
    entity: {
      key: "d41d8cd98f00b204e9800998ecf8427e",
      extras: { type: "tab", url: "" },
    },
  });
});

test("createChatSession posts the Tabbit Next server action and parses the action result", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    chatSessionCreatePath: "/newtab",
    chatSessionCreateActionId: "action-create-session",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([
        "0:{\"a\":\"$@1\",\"f\":[]}",
        "1:\"created-session-id\"",
        "",
      ].join("\n"), { headers: { "content-type": "text/x-component" } });
    },
  });

  const result = await client.createChatSession({
    account: { cookie: "placeholder-cookie-valuebc" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.chatSessionId, "created-session-id");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/newtab");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.body, "[]");
  assert.equal(calls[0].options.headers.Cookie, "placeholder-cookie-valuebc");
  assert.equal(calls[0].options.headers.Accept, "text/x-component");
  assert.equal(calls[0].options.headers["Content-Type"], "text/plain;charset=UTF-8");
  assert.equal(calls[0].options.headers["Next-Action"], "action-create-session");
  assert.equal(
    decodeURIComponent(calls[0].options.headers["Next-Router-State-Tree"]),
    JSON.stringify(["", { children: ["newtab", { children: ["__PAGE__", {}] }] }, null, null, true]),
  );
});

test("sendMessage auto creates a chat session before restored Tabbit chat completion", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    baseUrl: "https://web.tabbit.ai",
    sendPath: "/api/v1/chat/completion",
    chatSessionAutoCreate: true,
    chatSessionCreatePath: "/newtab",
    chatSessionCreateActionId: "action-create-session",
    signature: () => "00000000-0000-4000-8000-000000000000",
    uniqueUuid: () => "660001aa-2222-3333-4444-555555555555",
    now: () => 1783034819752,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/newtab")) {
        return jsonResponse("0:{\"a\":\"$@1\",\"f\":[]}\n1:\"created-session-id\"\n", { headers: { "content-type": "text/x-component" } });
      }
      if (url.endsWith("/chat/sign-key")) {
        return jsonResponse("f8d0e6a73f8d4b1a9c3d2e1f9a4b7c6d");
      }
      return jsonResponse("event: message_chunk\ndata: {\"content\":\"ok\"}\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.chatSessionId, "created-session-id");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/newtab",
    "/chat/sign-key",
    "/api/v1/chat/completion",
  ]);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    chat_session_id: "created-session-id",
    message_id: null,
    content: "hello",
    selected_model: "Default",
    parallel_group_id: null,
    task_name: "chat",
    agent_mode: false,
    metadatas: { html_content: "<p>hello</p>" },
    references: [],
    entity: {
      key: "d41d8cd98f00b204e9800998ecf8427e",
      extras: { type: "tab", url: "" },
    },
  });
});

test("sendMessage maps uploaded attachment references into the restored Tabbit request body", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    baseUrl: "https://web.tabbit.ai",
    sendPath: "/api/v1/chat/completion",
    signature: () => "00000000-0000-4000-8000-000000000000",
    now: () => 1783034819752,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return jsonResponse("f8d0e6a73f8d4b1a9c3d2e1f9a4b7c6d");
      return jsonResponse("event: message_chunk\ndata: {\"content\":\"ok\"}\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    chatSessionId: "session_live",
    model: "tabbit/priority",
    messages: [{ role: "user", content: "summarize the attachments" }],
    references: [{ type: "webpage", title: "Docs", content: "", metadata: { path: "https://example.test/docs" } }],
    attachments: [
      { type: "document", title: "guide.md", path: "file_doc_123" },
      { type: "image", title: "diagram.png", path: "file_img_456", content: "https://cdn.example.test/diagram.png", sourceUrl: "https://example.test/source.png" },
    ],
    metadatas: {
      selected_text: { id: "sel_1", title: "selection", content: "selected text", type: "chat-selected-text" },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    chat_session_id: "session_live",
    message_id: null,
    content: "summarize the attachments",
    selected_model: "Default",
    parallel_group_id: null,
    task_name: "chat",
    agent_mode: false,
    metadatas: {
      selected_text: { id: "sel_1", title: "selection", content: "selected text", type: "chat-selected-text" },
      html_content: "<p>summarize the attachments</p>",
    },
    references: [
      { type: "webpage", title: "Docs", content: "", metadata: { path: "https://example.test/docs" } },
      { type: "document", title: "guide.md", content: "", metadata: { file_id: "file_doc_123" } },
      { type: "image", title: "diagram.png", content: "https://cdn.example.test/diagram.png", metadata: { file_id: "file_img_456", source_url: "https://example.test/source.png" } },
    ],
    entity: {
      key: "d41d8cd98f00b204e9800998ecf8427e",
      extras: { type: "tab", url: "" },
    },
  });
});

test("sendMessage auto uploads raw base64 attachments before restored Tabbit chat completion", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    baseUrl: "https://web.tabbit.ai",
    sendPath: "/api/v1/chat/completion",
    attachmentUploadPath: "/proxy/v0/cos/presigned-upload-url",
    attachmentCompleteUploadPath: "/api/v0/cos/complete-upload",
    signature: () => "00000000-0000-4000-8000-000000000000",
    uniqueUuid: () => "660001aa-2222-3333-4444-555555555555",
    now: () => 1783034819752,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/proxy/v0/cos/presigned-upload-url")) {
        return jsonResponse({
          url: "https://cos.example.test/upload/file_doc_123",
          file_id: "file_doc_123",
          download_url: "https://cdn.example.test/file_doc_123",
        }, { headers: { "content-type": "application/json" } });
      }
      if (url === "https://cos.example.test/upload/file_doc_123") {
        return jsonResponse("", { headers: { "content-type": "text/plain" } });
      }
      if (url.endsWith("/api/v0/cos/complete-upload")) {
        return jsonResponse({ success: true }, { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/chat/sign-key")) return jsonResponse("f8d0e6a73f8d4b1a9c3d2e1f9a4b7c6d");
      return jsonResponse("event: message_chunk\ndata: {\"content\":\"ok\"}\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    chatSessionId: "session_live",
    model: "tabbit/priority",
    messages: [{ role: "user", content: "summarize attachment" }],
    attachments: [{
      filename: "notes.txt",
      mimeType: "text/plain",
      data: "SGVsbG8=",
      encoding: "base64",
    }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/proxy/v0/cos/presigned-upload-url",
    "/upload/file_doc_123",
    "/api/v0/cos/complete-upload",
    "/chat/sign-key",
    "/api/v1/chat/completion",
  ]);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    file_category: "document",
    original_filename: "notes.txt",
    content_type: "text/plain",
  });
  assert.equal(calls[0].options.headers.Cookie, "placeholder-cookie-valuebc");
  assert.equal(calls[0].options.headers["trace-id"], "660001aa-2222-3333-4444-555555555555");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.headers["Content-Type"], "text/plain");
  assert.equal(Buffer.from(calls[1].options.body).toString("utf8"), "Hello");
  assert.equal(Object.hasOwn(calls[1].options.headers, "Cookie"), false);
  assert.deepEqual(JSON.parse(calls[2].options.body), { file_id: "file_doc_123" });
  const sendBody = JSON.parse(calls[4].options.body);
  assert.deepEqual(sendBody.references, [{
    type: "document",
    title: "notes.txt",
    content: "",
    metadata: { file_id: "file_doc_123" },
  }]);
});

test("sendMessage rejects native tool fields for restored Tabbit chat completion until calibrated", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    sendPath: "/api/v1/chat/completion",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse("unexpected");
    },
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    chatSessionId: "session_live",
    model: "tabbit/priority",
    messages: [{ role: "user", content: "use a tool" }],
    tools: [{ type: "function", function: { name: "read_file" } }],
    toolChoice: "auto",
    parallelToolCalls: false,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "unsupported_feature");
  assert.equal(result.error.code, "TOOL_FIELDS_UNSUPPORTED");
  assert.equal(calls.length, 0);
});

test("sendMessage includes official tool options in the signed send body", async () => {
  const calls = [];
  const tools = [{ type: "function", function: { name: "run_tests", parameters: { type: "object" } } }];
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-tools",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return jsonResponse("sign-key-tools");
      return jsonResponse({ text: "tool request accepted" }, { headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "run tests" }],
    tools,
    toolChoice: "auto",
    parallelToolCalls: false,
  });

  assert.equal(result.ok, true);
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "run tests" }],
    stream: false,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
  });
  assert.equal(
    calls[1].options.headers["x-signature"],
    expectedHmac("sign-key-tools", buildSignaturePayload({
      method: "POST",
      path: "/chat/send",
      body,
      timestamp: 1700000000000,
      nonce: "nonce-tools",
    })),
  );
});

test("sendMessage preserves official tool round-trip messages in the signed send body", async () => {
  const calls = [];
  const messages = [
    {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_read_file",
        type: "function",
        function: {
          name: "read_file",
          arguments: "{\"path\":\"package.json\"}",
        },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_read_file",
      content: "{\"name\":\"tabbit2api\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_read_file",
      output: "{\"name\":\"tabbit2api\"}",
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_run_tests",
        content: "tests passed",
      }],
    },
  ];
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-tool-round-trip",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return jsonResponse("sign-key-tool-round-trip");
      return jsonResponse({ text: "round trip accepted" }, { headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages,
  });

  assert.equal(result.ok, true);
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    model: "Claude-Sonnet-4.6",
    messages,
    stream: false,
  });
  assert.equal(
    calls[1].options.headers["x-signature"],
    expectedHmac("sign-key-tool-round-trip", buildSignaturePayload({
      method: "POST",
      path: "/chat/send",
      body,
      timestamp: 1700000000000,
      nonce: "nonce-tool-round-trip",
    })),
  );
});

test("sendMessage normalizes upstream tool calls into internal tool_use blocks", async () => {
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-tool-call-output",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse({ key: "sign-key-tool-call-output" })
      : jsonResponse({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "call_read_file",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"path\":\"package.json\"}",
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }, { headers: { "content-type": "application/json" } }),
  });

  const result = await client.sendMessage({
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "read package metadata" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.contentBlocks, [{
    type: "tool_use",
    id: "call_read_file",
    name: "read_file",
    input: { path: "package.json" },
  }]);
});

test("sendMessage preserves Anthropic tool_use response blocks", async () => {
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-anthropic-tool-use",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse({ key: "sign-key-anthropic-tool-use" })
      : jsonResponse({
        content: [{
          type: "tool_use",
          id: "toolu_run_tests",
          name: "run_tests",
          input: { command: "node --test" },
        }],
        stop_reason: "tool_use",
      }, { headers: { "content-type": "application/json" } }),
  });

  const result = await client.sendMessage({
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "run tests" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.contentBlocks, [{
    type: "tool_use",
    id: "toolu_run_tests",
    name: "run_tests",
    input: { command: "node --test" },
  }]);
});

test("sendMessage aggregates buffered OpenAI stream tool_calls into internal tool_use blocks", async () => {
  const streamBody = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read_file","type":"function","function":{"name":"read_file","arguments":"{\\"path\\""}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"package.json\\"}"}}]},"finish_reason":"tool_calls"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-stream-tool-calls",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-stream-tool-calls")
      : jsonResponse(streamBody, { headers: { "content-type": "text/event-stream" } }),
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "read package metadata" }],
    stream: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.contentBlocks, [{
    type: "tool_use",
    id: "call_read_file",
    name: "read_file",
    input: { path: "package.json" },
  }]);
  assert.equal(result.raw.events.length, 2);
});

test("sendMessage aggregates buffered Anthropic stream tool_use input_json_delta blocks", async () => {
  const streamBody = [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"msg_stream_tool_use","type":"message","role":"assistant","content":[]}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_run_tests","name":"run_tests","input":{}}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"node --test\\"}"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-anthropic-stream-tool-use",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-anthropic-stream-tool-use")
      : jsonResponse(streamBody, { headers: { "content-type": "text/event-stream" } }),
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "run tests" }],
    stream: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stopReason, "tool_use");
  assert.deepEqual(result.contentBlocks, [{
    type: "tool_use",
    id: "toolu_run_tests",
    name: "run_tests",
    input: { command: "node --test" },
  }]);
  assert.equal(result.raw.events.length, 7);
});

test("sendMessage parses text/event-stream deltas from configured sendPath", async () => {
  const streamBody = [
    'data: {"type":"message_delta","delta":"Hel"}',
    "",
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-stream",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-stream")
      : jsonResponse(streamBody, { headers: { "content-type": "text/event-stream" } }),
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contentBlocks, [{ type: "text", text: "Hello" }]);
  assert.equal(result.raw.kind, "stream");
  assert.deepEqual(result.raw.events.map((event) => event.data), [
    { type: "message_delta", delta: "Hel" },
    { choices: [{ delta: { content: "lo" } }] },
  ]);
});

test("sendMessage classifies buffered stream error frames", async () => {
  const streamBody = [
    'event: error',
    'data: {"error":{"code":"QUOTA_EXHAUSTED","message":"Current account quota exhausted"}}',
    "",
  ].join("\n");
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-stream-error")
      : jsonResponse(streamBody, { headers: { "content-type": "text/event-stream" } }),
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "quota_exhausted");
  assert.equal(result.error.code, "QUOTA_EXHAUSTED");
  assert.match(result.error.message, /quota exhausted/i);
  assert.equal(result.error.retryable, true);
});

test("sendMessage classifies premium-only stream errors as model entitlement failures", async () => {
  const streamBody = [
    "event: error",
    'data: {"code":492,"message":"Model Claude-Opus-4.8 is available to premium users only. Please upgrade and try again."}',
    "",
  ].join("\n");
  const client = new ProtocolTabbitClient({
    sendPath: "/api/v1/chat/completion",
    defaultChatSessionId: "session_test",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-premium-only")
      : jsonResponse(streamBody, { headers: { "content-type": "text/event-stream" } }),
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Opus-4.8",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "model_entitlement");
  assert.equal(result.error.code, "MODEL_ENTITLEMENT_REQUIRED");
  assert.equal(result.error.retryable, true);
  assert.match(result.error.message, /premium users only/i);
});

test("sendMessage returns async streamDeltas before the upstream stream completes", async () => {
  const releaseSecond = createDeferred();
  const client = new ProtocolTabbitClient({
    sendPath: "/api/v1/chat/completion",
    now: () => 1700000000000,
    nonce: () => "nonce-async-stream",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-async-stream")
      : streamingTextResponse({
        firstChunk: 'data: {"delta":"Hel"}\n\n',
        secondChunk: 'data: {"delta":"lo"}\n\ndata: [DONE]\n\n',
        releaseSecond,
      }),
  });

  const pendingResult = client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    chatSessionId: "session_live",
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  let result;
  try {
    result = await Promise.race([
      pendingResult,
      new Promise((_, reject) => setTimeout(() => reject(new Error("sendMessage waited for the full upstream stream")), 50)),
    ]);
  } catch (error) {
    releaseSecond.resolve();
    await pendingResult.catch(() => {});
    throw error;
  }

  assert.equal(result.ok, true);
  assert.equal(typeof result.streamDeltas?.[Symbol.asyncIterator], "function");
  assert.deepEqual(result.contentBlocks, [{ type: "text", text: "" }]);
  assert.equal(result.raw.kind, "stream");
  assert.equal(result.raw.format, "sse");
  assert.equal(result.raw.async, true);
  assert.deepEqual(result.upstreamEvidence, {
    source: "tabbit-live",
    real: true,
    stream: true,
    format: "sse",
  });
  assert.doesNotMatch(JSON.stringify(result.upstreamEvidence), /placeholder-cookie|hello/i);

  const iterator = result.streamDeltas[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: "Hel", done: false });
  let secondSettled = false;
  const secondPromise = iterator.next().then((value) => {
    secondSettled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondSettled, false);
  releaseSecond.resolve();
  const second = await secondPromise;
  assert.deepEqual(second, { value: "lo", done: false });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.deepEqual(result.raw.events.map((event) => event.data), [
    { delta: "Hel" },
    { delta: "lo" },
  ]);

  await pendingResult;
});

test("async streamDeltas emits OpenAI tool_call delta objects", async () => {
  const releaseSecond = createDeferred();
  const firstData = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_read_file",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\"" },
        }],
      },
    }],
  });
  const secondData = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: ":\"package.json\"}" },
        }],
      },
    }],
  });
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-async-tool-call",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-async-tool-call")
      : streamingTextResponse({
        firstChunk: `data: ${firstData}\n\n`,
        secondChunk: `data: ${secondData}\n\ndata: [DONE]\n\n`,
        releaseSecond,
      }),
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.upstreamEvidence, undefined);
  const iterator = result.streamDeltas[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    value: {
      type: "tool_call_delta",
      index: 0,
      id: "call_read_file",
      name: "read_file",
      argumentsDelta: "{\"path\"",
    },
    done: false,
  });
  releaseSecond.resolve();
  assert.deepEqual(await iterator.next(), {
    value: {
      type: "tool_call_delta",
      index: 0,
      argumentsDelta: ":\"package.json\"}",
    },
    done: false,
  });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.equal(result.raw.events.length, 2);
});

test("async streamDeltas emits Anthropic tool_use delta objects", async () => {
  const releaseSecond = createDeferred();
  const firstData = JSON.stringify({
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "tool_use",
      id: "toolu_read_file",
      name: "read_file",
      input: {},
    },
  });
  const secondData = JSON.stringify({
    type: "content_block_delta",
    index: 1,
    delta: {
      type: "input_json_delta",
      partial_json: "{\"path\":\"package.json\"}",
    },
  });
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-async-anthropic-tool-use",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-async-anthropic-tool-use")
      : streamingTextResponse({
        firstChunk: `event: content_block_start\ndata: ${firstData}\n\n`,
        secondChunk: `event: content_block_delta\ndata: ${secondData}\n\ndata: [DONE]\n\n`,
        releaseSecond,
      }),
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  assert.equal(result.ok, true);
  const iterator = result.streamDeltas[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    value: {
      type: "tool_call_delta",
      index: 1,
      id: "toolu_read_file",
      name: "read_file",
    },
    done: false,
  });
  releaseSecond.resolve();
  assert.deepEqual(await iterator.next(), {
    value: {
      type: "tool_call_delta",
      index: 1,
      argumentsDelta: "{\"path\":\"package.json\"}",
    },
    done: false,
  });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.equal(result.raw.events.length, 2);
});

test("async streamDeltas cancellation cancels the upstream readable body", async () => {
  const releaseSecond = createDeferred();
  const { response, cancellation } = cancellableStreamingTextResponse({
    firstChunk: 'data: {"delta":"Hel"}\n\n',
    releaseSecond,
  });
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-async-stream-cancel",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-async-stream-cancel")
      : response,
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  assert.equal(result.ok, true);
  const iterator = result.streamDeltas[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: "Hel", done: false });
  assert.deepEqual(await iterator.return(), { value: undefined, done: true });
  const reason = await Promise.race([
    cancellation.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("upstream body was not cancelled")), 50)),
  ]);
  assert.equal(reason, "stream_deltas_cancelled");
});

test("async streamDeltas rejects when an upstream stream error frame arrives", async () => {
  const releaseSecond = createDeferred();
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-async-stream-error",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-async-stream-error")
      : streamingTextResponse({
        firstChunk: 'data: {"delta":"Hel"}\n\n',
        secondChunk: 'event: error\ndata: {"error":{"code":"QUOTA_EXHAUSTED","message":"Current account quota exhausted"}}\n\n',
        releaseSecond,
      }),
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  assert.equal(result.ok, true);
  const iterator = result.streamDeltas[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: "Hel", done: false });
  releaseSecond.resolve();
  await assert.rejects(
    iterator.next(),
    (error) => {
      assert.equal(error.name, "ProtocolTabbitError");
      assert.equal(error.category, "quota_exhausted");
      assert.equal(error.code, "QUOTA_EXHAUSTED");
      assert.equal(error.retryable, true);
      assert.match(error.message, /quota exhausted/i);
      return true;
    },
  );
  assert.deepEqual(result.raw.events.map((event) => event.data), [
    { delta: "Hel" },
    { error: { code: "QUOTA_EXHAUSTED", message: "Current account quota exhausted" } },
  ]);
});

test("sendMessage parses newline-delimited JSON deltas from configured sendPath", async () => {
  const streamBody = [
    '{"delta":"Hel"}',
    '{"data":{"content":"lo"}}',
    '{"done":true}',
    "",
  ].join("\n");
  const client = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    now: () => 1700000000000,
    nonce: () => "nonce-ndjson",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-ndjson")
      : jsonResponse(streamBody, { headers: { "content-type": "application/x-ndjson" } }),
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contentBlocks, [{ type: "text", text: "Hello" }]);
  assert.equal(result.raw.kind, "stream");
  assert.equal(result.raw.format, "ndjson");
  assert.deepEqual(result.raw.events.map((event) => event.data), [
    { delta: "Hel" },
    { data: { content: "lo" } },
    { done: true },
  ]);
});

test("verifySession builds a signed GET to the configured endpoint", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    sessionVerifyPath: "/chat/session/check",
    now: () => 1700000000000,
    nonce: () => "nonce-verify",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return jsonResponse("sign-key-verify");
      return jsonResponse({ data: { userId: "user_123", accessTier: "pro" } });
    },
  });

  const result = await client.verifySession({
    account: { id: "acct_a", cookieHeader: "tabbit_session=secret" },
    session: "tabbit_session=secret",
  });

  assert.equal(result.ok, true);
  assert.equal(result.userId, "user_123");
  assert.equal(result.accessTier, "pro");
  assert.equal(calls[0].url, "https://web.tabbit.ai/chat/sign-key");
  assert.equal(calls[1].url, "https://web.tabbit.ai/chat/session/check");
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[1].options.headers.Cookie, "tabbit_session=secret");
  assert.equal(calls[1].options.headers["x-timestamp"], "1700000000000");
  assert.equal(calls[1].options.headers["x-nonce"], "nonce-verify");
  assert.equal(typeof calls[1].options.headers["x-signature"], "string");
});

test("verifySession normalizes calibrated Tabbit base-info response", async () => {
  const client = new ProtocolTabbitClient({
    sessionVerifyPath: "/api/v0/user/base-info",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-verify")
      : jsonResponse({
        success: true,
        user_info: {
          id: "aa9e0e81-0000-41c3-872a-70fd4c9ef930",
          display_name: "local-user",
        },
      }),
  });

  const result = await client.verifySession({ session: "tabbit_session=secret" });

  assert.equal(result.ok, true);
  assert.equal(result.userId, "aa9e0e81-0000-41c3-872a-70fd4c9ef930");
  assert.equal(result.raw.success, true);
});

test("verifySession maps unauthorized responses to login_expired without throwing", async () => {
  const client = new ProtocolTabbitClient({
    sessionVerifyPath: "/chat/session/check",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-verify")
      : jsonResponse({ message: "login required" }, { status: 401 }),
  });

  const result = await client.verifySession({ account: {}, session: "tabbit_session=expired" });

  assert.equal(result.ok, false);
  assert.equal(result.category, "login_required");
  assert.equal(result.accountStatus, "login_expired");
  assert.equal(result.httpStatus, 401);
  assert.match(result.message, /login required/i);
});

test("verifySession skips network when no endpoint is configured", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });

  const result = await client.verifySession({ account: {}, session: "tabbit_session=secret" });

  assert.equal(result.ok, false);
  assert.equal(result.category, "protocol_missing");
  assert.equal(result.code, "MISSING_SESSION_VERIFY_PATH");
  assert.equal(calls.length, 0);
});

test("verifySession rejects missing session material before fetching sign-key", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    sessionVerifyPath: "/chat/session/check",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });

  const result = await client.verifySession({ account: {} });

  assert.equal(result.ok, false);
  assert.equal(result.category, "session_missing");
  assert.equal(result.code, "SESSION_MISSING");
  assert.equal(result.accountStatus, "login_expired");
  assert.equal(calls.length, 0);
});

test("auth verification-code operations report missing configuration before network", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });

  const send = await client.sendVerificationCode({ email: "new-user@example.test" });
  const submit = await client.submitRegistrationOrLogin({ email: "new-user@example.test", code: "CODE-PLACEHOLDER" });

  assert.equal(send.ok, false);
  assert.equal(send.error.category, "protocol_missing");
  assert.equal(send.error.code, "MISSING_AUTH_SEND_CODE_PATH");
  assert.equal(submit.ok, false);
  assert.equal(submit.error.category, "protocol_missing");
  assert.equal(submit.error.code, "MISSING_AUTH_SUBMIT_CODE_PATH");
  assert.equal(calls.length, 0);
});

test("auth verification-code operations validate required input before network", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    authSendCodePath: "/api/auth/send-code",
    authSubmitCodePath: "/api/auth/submit-code",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });

  const missingEmail = await client.sendVerificationCode({ email: "" });
  const missingCode = await client.submitRegistrationOrLogin({ email: "new-user@example.test" });

  assert.equal(missingEmail.ok, false);
  assert.equal(missingEmail.error.category, "invalid_request");
  assert.equal(missingEmail.error.code, "MISSING_EMAIL");
  assert.equal(missingCode.ok, false);
  assert.equal(missingCode.error.category, "invalid_request");
  assert.equal(missingCode.error.code, "MISSING_VERIFICATION_CODE");
  assert.equal(calls.length, 0);
});

test("sendVerificationCode posts signed JSON body to configured auth endpoint", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    authSendCodePath: "/api/auth/send-code",
    now: () => 1700000000000,
    signature: () => "signature-send-code",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000010",
    reqCtx: "fixture-req-ctx",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return jsonResponse("sign-key-auth");
      return jsonResponse({ success: true }, { headers: { "content-type": "application/json" } });
    },
  });

  const result = await client.sendVerificationCode({ email: "new-user@example.test" });

  assert.equal(result.ok, true);
  assert.equal(result.raw.success, true);
  assert.equal(calls[0].url, "https://web.tabbit.ai/chat/sign-key");
  assert.equal(calls[1].url, "https://web.tabbit.ai/api/auth/send-code");
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.body), { email: "new-user@example.test" });
  assert.equal(calls[1].options.headers.Cookie, undefined);
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  assert.equal(calls[1].options.headers["x-req-ctx"], "fixture-req-ctx");
  assert.equal(calls[1].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000010");
  assert.equal(calls[1].options.headers["x-timestamp"], "1700000000000");
  assert.equal(calls[1].options.headers["x-signature"], "signature-send-code");
  assert.equal(typeof calls[1].options.headers["x-nonce"], "string");
});

test("proxy oauth auth endpoints post browser JSON without sign-key headers", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    authSendCodePath: "/proxy/v0/oauth/send-verification-code",
    authSubmitCodePath: "/proxy/v0/oauth/login",
    reqCtx: "fixture-req-ctx",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000012",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ ok: true });
    },
  });

  await client.sendVerificationCode({
    email: "new-user@example.test",
    body: { mobile: "10000000000", type: "login", uuid: "00000000-0000-4000-8000-000000000000" },
  });
  await client.submitRegistrationOrLogin({
    email: "new-user@example.test",
    code: "CODE-PLACEHOLDER",
    body: { mobile: "10000000000", smsCode: "CODE-PLACEHOLDER", type: "login", uuid: "00000000-0000-4000-8000-000000000000" },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://web.tabbit.ai/proxy/v0/oauth/send-verification-code");
  assert.equal(calls[1].url, "https://web.tabbit.ai/proxy/v0/oauth/login");
  for (const call of calls) {
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers["Content-Type"], "application/json");
    assert.equal(call.options.headers.accept, "application/json");
    assert.equal(call.options.headers["x-req-ctx"], "fixture-req-ctx");
    assert.equal(call.options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000012");
    assert.equal(call.options.headers["x-signature"], undefined);
    assert.equal(call.options.headers["x-nonce"], undefined);
    assert.equal(call.options.headers["x-timestamp"], undefined);
  }
});

test("proxy oauth auth endpoints build calibrated mobile JSON body with shared auth uuid", async () => {
  const calls = [];
  let authUuidCalls = 0;
  const authUuid = "Aa0".repeat(21) + "Z";
  const client = new ProtocolTabbitClient({
    authSendCodePath: "/proxy/v0/oauth/send-verification-code",
    authSubmitCodePath: "/proxy/v0/oauth/login",
    authClientUuid: () => {
      authUuidCalls += 1;
      return authUuid;
    },
    uniqueUuid: () => "00000000-0000-4000-8000-000000000013",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ success: true });
    },
  });

  const send = await client.sendVerificationCode({ mobile: "10000000000" });
  const submit = await client.submitRegistrationOrLogin({
    mobile: "10000000000",
    code: "123456",
    input: { channel: "desktop" },
  });

  assert.equal(send.ok, true);
  assert.equal(submit.ok, true);
  assert.equal(authUuidCalls, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    uuid: authUuid,
    platform: "1",
    version: "",
    app: "1000",
    mobile: "10000000000",
  });
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    uuid: authUuid,
    platform: "1",
    version: "",
    app: "1000",
    mobile: "10000000000",
    smsCode: "123456",
    channel: "desktop",
  });
  assert.equal(calls[0].options.headers["x-signature"], undefined);
  assert.equal(calls[1].options.headers["x-signature"], undefined);
});

test("proxy oauth auth validation errors expose top-level probe classification", async () => {
  const client = new ProtocolTabbitClient({
    authSendCodePath: "/proxy/v0/oauth/send-verification-code",
    fetch: async () => jsonResponse({
      detail: [{ loc: ["body", "uuid"], type: "missing" }],
    }, { status: 422 }),
  });

  const result = await client.sendVerificationCode({
    email: "new-user@example.test",
    body: { mobile: "10000000000", type: "login" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.category, "invalid_request");
  assert.equal(result.httpStatus, 422);
  assert.equal(result.retryable, false);
  assert.equal(result.error.category, "invalid_request");
  assert.equal(result.error.status, 422);
});

test("auth operations allow explicit captured request bodies", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    authSendCodePath: "/api/auth/send-code",
    authSubmitCodePath: "/api/auth/submit-code",
    now: () => 1700000000000,
    signature: () => "signature-auth-body",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000011",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-auth");
      return jsonResponse({ data: { cookie: "tabbit_session=pa", user_id: "user_auth", access_tier: "free" } });
    },
  });

  await client.sendVerificationCode({
    email: "new-user@example.test",
    body: { email_address: "new-user@example.test", scene: "login" },
  });
  const submit = await client.submitRegistrationOrLogin({
    email: "new-user@example.test",
    code: "CODE-PLACEHOLDER",
    body: { email_address: "new-user@example.test", verify_code: "CODE-PLACEHOLDER", scene: "login" },
  });

  assert.equal(submit.ok, true);
  assert.equal(submit.cookie, "tabbit_session=pa");
  assert.equal(submit.userId, "user_auth");
  assert.equal(submit.accessTier, "free");
  const postCalls = calls.filter((call) => !call.url.endsWith("/chat/sign-key"));
  assert.deepEqual(JSON.parse(postCalls[0].options.body), { email_address: "new-user@example.test", scene: "login" });
  assert.deepEqual(JSON.parse(postCalls[1].options.body), { email_address: "new-user@example.test", verify_code: "CODE-PLACEHOLDER", scene: "login" });
});

test("submitRegistrationOrLogin normalizes safe session material variants", async () => {
  const variants = [
    [{ cookieHeader: "tabbit_session=pc", userId: "user_a", accessTier: "pro" }, "cookieHeader", "user_a", "pro"],
    [{ data: { cookie: "tabbit_session=pc", user_id: "user_b", access_tier: "free" } }, "cookie", "user_b", "free"],
    [{ data: { sessionToken: "pst" } }, "sessionToken", undefined, undefined],
  ];

  for (const [body, sessionField, userId, accessTier] of variants) {
    const client = new ProtocolTabbitClient({
      authSubmitCodePath: "/api/auth/submit-code",
      fetch: async (url) => url.endsWith("/chat/sign-key")
        ? jsonResponse("sign-key-auth")
        : jsonResponse(body),
    });

    const result = await client.submitRegistrationOrLogin({
      email: "new-user@example.test",
      code: "CODE-PLACEHOLDER",
    });

    assert.equal(result.ok, true);
    assert.equal(typeof result[sessionField], "string");
    assert.equal(result.userId, userId);
    assert.equal(result.accessTier, accessTier);
  }
});

test("refreshQuota calls the real quota usage endpoint with user_id and browser uuid header", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    quotaUsagePath: "/api/commerce/quota/v1/usage",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000001",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        user_id: "user_quota",
        member_level: "free",
        usage_percentage: "31.37%",
        remaining_reset_hours: "161.49",
        current_cycle_start: "2026.07.03",
        current_cycle_end: "2026.07.10",
        unused_reset_coupon_count: 0,
      });
    },
  });

  const result = await client.refreshQuota({
    account: {
      userId: "user_quota",
      cookie: "tabbit_session=quota",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "tabbit-quota-usage");
  assert.equal(result.accessTier, "free");
  assert.equal(result.resetCouponCount, 0);
  assert.deepEqual(result.quotaState, [{
    model: "tabbit/priority",
    remaining: null,
    limit: null,
    unit: "usage_percentage",
    resetAt: "2026.07.10",
    exhausted: false,
    source: "tabbit-quota-usage",
    usagePercentage: 31.37,
  }]);
  assert.equal(result.raw.member_level, "free");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/quota/v1/usage?user_id=user_quota");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=quota");
  assert.equal(calls[0].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000001");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-nonce"), false);
});

test("refreshQuota marks usage percentage at or above 100 as exhausted", async () => {
  const client = new ProtocolTabbitClient({
    quotaUsagePath: "/api/commerce/quota/v1/usage",
    fetch: async () => jsonResponse({
      data: {
        member_level: "pro",
        usage_percentage: "100%",
        current_cycle_end: "2026.07.10",
        unused_reset_coupon_count: 2,
      },
    }),
  });

  const result = await client.refreshQuota({
    account: {
      user_id: "user_quota",
      cookieHeader: "tabbit_session=quota",
    },
  });

  assert.equal(result.accessTier, "pro");
  assert.equal(result.resetCouponCount, 2);
  assert.equal(result.quotaState[0].usagePercentage, 100);
  assert.equal(result.quotaState[0].exhausted, true);
});

test("refreshQuota rejects missing endpoint, user id, or session before network", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({});
  };

  const missingEndpoint = new ProtocolTabbitClient({ fetch });
  await assert.rejects(
    () => missingEndpoint.refreshQuota({ account: { userId: "user_quota", cookie: "tabbit_session=quota" } }),
    (error) => {
      assert.equal(error.category, "protocol_missing");
      assert.equal(error.code, "MISSING_QUOTA_USAGE_PATH");
      return true;
    },
  );

  const missingUserId = new ProtocolTabbitClient({ quotaUsagePath: "/api/commerce/quota/v1/usage", fetch });
  await assert.rejects(
    () => missingUserId.refreshQuota({ account: { cookie: "tabbit_session=quota" } }),
    (error) => {
      assert.equal(error.category, "invalid_request");
      assert.equal(error.code, "MISSING_USER_ID");
      return true;
    },
  );

  const missingSession = new ProtocolTabbitClient({ quotaUsagePath: "/api/commerce/quota/v1/usage", fetch });
  await assert.rejects(
    () => missingSession.refreshQuota({ account: { userId: "user_quota" } }),
    (error) => {
      assert.equal(error.category, "session_missing");
      assert.equal(error.code, "SESSION_MISSING");
      return true;
    },
  );

  assert.equal(calls.length, 0);
});

test("refreshQuota classifies unauthorized quota usage responses as login_required", async () => {
  const client = new ProtocolTabbitClient({
    quotaUsagePath: "/api/commerce/quota/v1/usage",
    fetch: async () => jsonResponse({ message: "login required" }, { status: 401 }),
  });

  await assert.rejects(
    () => client.refreshQuota({
      account: {
        userId: "user_quota",
        cookie: "tabbit_session=expired",
      },
    }),
    (error) => {
      assert.equal(error.category, "login_required");
      assert.equal(error.status, 401);
      assert.match(error.message, /login required/i);
      return true;
    },
  );
});

test("getLotteryExplorationMe calls the read-only activity endpoint without signing", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    activityLotteryPath: "/api/commerce/activity/v1/lottery/me",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000003",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        newbie_exploration: {
          view_mode: "activity_page",
          visible: false,
          status: "not_available",
        },
        participation: {
          activity_enabled: false,
          participation_result: "activity_not_found",
        },
      });
    },
  });

  const result = await client.getLotteryExplorationMe({
    account: { cookie: "tabbit_session=activity" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "tabbit-activity-lottery");
  assert.equal(result.newbieExploration.status, "not_available");
  assert.equal(result.participation.activity_enabled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/activity/v1/lottery/me");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=activity");
  assert.equal(calls[0].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000003");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-nonce"), false);
});

test("getPlacementResources calls the read-only placement endpoint without signing", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    placementResourcesPath: "/api/commerce/placement/v1/resources",
    reqCtx: "fixture-req-ctx",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000009",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        placement_code: "home.input_below",
        version: "placement-version",
        changed: true,
        resources: [
          {
            resource_code: "home_input_beta_user_card_v1",
            resource_type: "banner",
            payload: { action: { target: "/beta-user-card" } },
          },
        ],
      });
    },
  });

  const result = await client.getPlacementResources({
    account: { cookieHeader: "tabbit_session=placement" },
    placementCode: "home.input_below",
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "tabbit-placement-resources");
  assert.equal(result.placementCode, "home.input_below");
  assert.equal(result.version, "placement-version");
  assert.equal(result.changed, true);
  assert.equal(result.resources[0].resource_code, "home_input_beta_user_card_v1");
  assert.equal(result.raw.placement_code, "home.input_below");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/placement/v1/resources?placement_code=home.input_below");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=placement");
  assert.equal(calls[0].options.headers.accept, "application/json");
  assert.equal(calls[0].options.headers["x-req-ctx"], "fixture-req-ctx");
  assert.equal(calls[0].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000009");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-nonce"), false);
});

test("getPlacementResources accepts data-wrapped responses and optional client version", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    placementResourcesPath: "/api/commerce/placement/v1/resources",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        data: {
          placement_code: "home.input_below",
          resources: [],
        },
      });
    },
  });

  const result = await client.getPlacementResources({
    account: { cookie: "tabbit_session=placement" },
    clientVersion: "1.3.26",
  });

  assert.equal(result.ok, true);
  assert.equal(result.placementCode, "home.input_below");
  assert.deepEqual(result.resources, []);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/placement/v1/resources?placement_code=home.input_below&client_version=1.3.26");
});

test("getNewbieExplorationMe validates view modes and sends calibrated query flags", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    newbieExplorationPath: "/api/commerce/activity/v1/newbie-exploration/me",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        view_mode: "float_expanded",
        visible: false,
        is_newbie_eligible: false,
        status: "not_available",
        completed_count: 0,
        total_task_count: 0,
        tasks: [],
        milestones: [],
        rewards: [],
      });
    },
  });

  const result = await client.getNewbieExplorationMe({
    account: { cookieHeader: "tabbit_session=newbie" },
    viewMode: "float_expanded",
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "tabbit-newbie-exploration");
  assert.equal(result.viewMode, "float_expanded");
  assert.equal(result.status, "not_available");
  assert.equal(result.completedCount, 0);
  assert.equal(result.totalTaskCount, 0);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/activity/v1/newbie-exploration/me?view_mode=float_expanded&include_completions=true&include_rewards=true");

  await assert.rejects(
    () => client.getNewbieExplorationMe({
      account: { cookieHeader: "tabbit_session=newbie" },
      viewMode: "sidebar",
    }),
    (error) => {
      assert.equal(error.category, "invalid_request");
      assert.equal(error.code, "INVALID_NEWBIE_EXPLORATION_VIEW_MODE");
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("read-only reward and lottery record queries require user id and keep query shape stable", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    rewardCardRecordsPath: "/api/commerce/reward/v1/card-records",
    lotteryHitRecordsPath: "/api/commerce/lottery/v1/hit-records",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000004",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ total: 0, records: [] });
    },
  });

  const reward = await client.listRewardCardRecords({
    account: { userId: "user_reward", cookie: "tabbit_session=records" },
    limit: 10,
  });
  const lottery = await client.listLotteryHitRecords({
    account: { userId: "user_reward", cookie: "tabbit_session=records" },
    offset: 20,
    limit: 10,
    mainPoolId: "pool_1",
  });

  assert.equal(reward.ok, true);
  assert.equal(reward.source, "tabbit-reward-card-records");
  assert.equal(reward.total, 0);
  assert.deepEqual(reward.records, []);
  assert.equal(lottery.ok, true);
  assert.equal(lottery.source, "tabbit-lottery-hit-records");
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/reward/v1/card-records?user_id=user_reward&offset=0&limit=10&order.field=award_time&order.order=desc");
  assert.equal(calls[1].url, "https://web.tabbit.ai/api/commerce/lottery/v1/hit-records?user_id=user_reward&offset=20&limit=10&main_pool_id=pool_1");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=records");
  assert.equal(calls[0].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000004");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);
});

test("daily sign-in status uses repeated scene_codes and does not sign", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    signInStatusPath: "/api/commerce/activity/v1/sign-in/status",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000005",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        sign_in_date: "2026-07-03",
        results: [{ scene_code: "desktop_pet", signed_today: false }],
      });
    },
  });

  const result = await client.getDailySignInStatus({
    account: { cookie: "tabbit_session=signin" },
    sceneCodes: ["desktop_pet", "other_scene"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "tabbit-daily-sign-in-status");
  assert.equal(result.signedToday, false);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/activity/v1/sign-in/status?scene_codes=desktop_pet&scene_codes=other_scene");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Cookie, "tabbit_session=signin");
  assert.equal(calls[0].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000005");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-nonce"), false);
});

test("dailySignIn requires explicit side-effect confirmation before posting", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    signInPath: "/api/commerce/activity/v1/sign-in",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000006",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        sign_in_date: "2026-07-03",
        results: [{
          scene_code: "desktop_pet",
          signed_today: true,
          sign_in_result: "success",
          signed_days: 1,
          total_signed_days: 1,
        }],
      });
    },
  });

  await assert.rejects(
    () => client.dailySignIn({
      account: { cookie: "tabbit_session=signin" },
      requestNo: "desktop-pet-sign-in-probe",
    }),
    (error) => {
      assert.equal(error.category, "invalid_request");
      assert.equal(error.code, "SIDE_EFFECT_CONFIRMATION_REQUIRED");
      return true;
    },
  );
  assert.equal(calls.length, 0);

  const result = await client.dailySignIn({
    account: { cookie: "tabbit_session=signin" },
    requestNo: "desktop-pet-sign-in-probe",
    sceneCodes: ["desktop_pet"],
    confirmSideEffect: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "tabbit-daily-sign-in");
  assert.equal(result.signInDate, "2026-07-03");
  assert.equal(result.signedToday, true);
  assert.equal(result.signInResult, "success");
  assert.equal(result.signedDays, 1);
  assert.equal(result.totalSignedDays, 1);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/activity/v1/sign-in");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["trace-id"], "00000000-0000-4000-8000-000000000006");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    request_no: "desktop-pet-sign-in-probe",
    scene_codes: ["desktop_pet"],
  });

  await assert.rejects(
    () => client.dailySignIn({
      account: { cookie: "tabbit_session=signin" },
      requestNo: "x".repeat(65),
      confirmSideEffect: true,
    }),
    (error) => {
      assert.equal(error.category, "invalid_request");
      assert.equal(error.code, "INVALID_REQUEST_NO");
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("reset coupon list and participate use calibrated commerce headers", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    benefitCouponListPath: "/api/commerce/benefit/v1/coupon/list",
    activityParticipatePath: "/api/commerce/activity/v1/participate",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000007",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST") {
        return jsonResponse({
          activity_id: 10001,
          participation_result: "already_participated",
        });
      }
      return jsonResponse({ total: 0, records: [] });
    },
  });

  const coupons = await client.listBenefitCoupons({
    account: { userId: "user_coupon", cookie: "tabbit_session=coupon" },
    limit: 50,
  });

  assert.equal(coupons.ok, true);
  assert.equal(coupons.source, "tabbit-benefit-coupon-list");
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/benefit/v1/coupon/list?user_id=user_coupon&coupon_type=weekly_reset_coupon&offset=0&limit=50");
  assert.equal(calls[0].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000007");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);

  await assert.rejects(
    () => client.participateResetCouponActivity({
      account: { userId: "user_coupon", cookie: "tabbit_session=coupon" },
      requestNo: "reset-coupon-probe",
    }),
    (error) => {
      assert.equal(error.code, "SIDE_EFFECT_CONFIRMATION_REQUIRED");
      return true;
    },
  );
  assert.equal(calls.length, 1);

  const participate = await client.participateResetCouponActivity({
    account: { userId: "user_coupon", cookie: "tabbit_session=coupon" },
    requestNo: "reset-coupon-probe",
    confirmSideEffect: true,
  });

  assert.equal(participate.ok, true);
  assert.equal(participate.source, "tabbit-reset-coupon-activity-participate");
  assert.equal(participate.activityId, "10001");
  assert.equal(participate.participationResult, "already_participated");
  assert.equal(calls[1].url, "https://web.tabbit.ai/api/commerce/activity/v1/participate");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  assert.equal(calls[1].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000007");
  assert.equal(Object.hasOwn(calls[1].options.headers, "trace-id"), false);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    user_id: "user_coupon",
    request_no: "reset-coupon-probe",
  });

  await assert.rejects(
    () => client.participateResetCouponActivity({
      account: { userId: "user_coupon", cookie: "tabbit_session=coupon" },
      requestNo: "x".repeat(65),
      confirmSideEffect: true,
    }),
    (error) => {
      assert.equal(error.category, "invalid_request");
      assert.equal(error.code, "INVALID_REQUEST_NO");
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("useResetCoupon posts calibrated coupon-use body with explicit confirmation", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    benefitCouponUsePath: "/api/commerce/benefit/v1/coupon/use",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000017",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        request_no: "coupon-use-probe",
        use_result: "success",
      });
    },
  });

  await assert.rejects(
    () => client.useResetCoupon({
      account: { userId: "user_coupon", cookie: "tabbit_session=coupon" },
      couponCode: "coupon-code",
      requestNo: "coupon-use-probe",
    }),
    (error) => {
      assert.equal(error.code, "SIDE_EFFECT_CONFIRMATION_REQUIRED");
      return true;
    },
  );
  assert.equal(calls.length, 0);

  const result = await client.useResetCoupon({
    account: { userId: "user_coupon", cookie: "tabbit_session=coupon" },
    couponCode: "coupon-code",
    requestNo: "coupon-use-probe",
    confirmSideEffect: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, "tabbit-reset-coupon-use");
  assert.equal(result.usageResult, "success");
  assert.deepEqual(Object.keys(result.evidence).sort(), ["bodyHash", "endpointHash", "rawPayload", "resultHash", "safe", "sanitized"]);
  assert.equal(result.evidence.safe, true);
  assert.equal(result.evidence.sanitized, true);
  assert.equal(result.evidence.rawPayload, false);
  assert.match(result.evidence.endpointHash, /^sha256:/);
  assert.match(result.evidence.bodyHash, /^sha256:/);
  assert.match(result.evidence.resultHash, /^sha256:/);
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/benefit/v1/coupon/use");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(calls[0].options.headers["unique-uuid"], "00000000-0000-4000-8000-000000000017");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    user_id: "user_coupon",
    coupon_code: "coupon-code",
    coupon_type: "weekly_reset_coupon",
    request_no: "coupon-use-probe",
  });
});

test("lottery chance probes keep activity query shape and guard draw side effects", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    lotteryAvailableChancesPath: "/api/commerce/lottery/v1/available-chances",
    lotteryActiveMainPoolsPath: "/api/commerce/lottery/v1/active-main-pools",
    lotteryChanceRecordsPath: "/api/commerce/activity/v1/lottery/chance-records",
    lotteryDrawPath: "/api/commerce/lottery/v1/draw",
    uniqueUuid: () => "00000000-0000-4000-8000-000000000008",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ total: 0, records: [], status: "ok" });
    },
  });

  await client.getAvailableLotteryChanceCount({
    account: { userId: "user_lottery", cookie: "tabbit_session=lottery" },
    activityId: "activity_1",
  });
  await client.getActiveMainPools({
    account: { cookie: "tabbit_session=lottery" },
    activityId: "activity_1",
  });
  const records = await client.listLotteryChanceRecords({
    account: { cookie: "tabbit_session=lottery" },
    activityId: "activity_1",
    offset: 0,
    limit: 20,
  });

  assert.equal(records.source, "tabbit-lottery-chance-records");
  assert.equal(calls[0].url, "https://web.tabbit.ai/api/commerce/lottery/v1/available-chances?user_id=user_lottery&activity_id=activity_1");
  assert.equal(calls[1].url, "https://web.tabbit.ai/api/commerce/lottery/v1/active-main-pools?activity_id=activity_1");
  assert.equal(calls[2].url, "https://web.tabbit.ai/api/commerce/activity/v1/lottery/chance-records?activity_id=activity_1&offset=0&limit=20");

  await assert.rejects(
    () => client.drawLottery({
      account: { cookie: "tabbit_session=lottery" },
      body: { activity_id: "activity_1" },
    }),
    (error) => {
      assert.equal(error.code, "SIDE_EFFECT_CONFIRMATION_REQUIRED");
      return true;
    },
  );
  assert.equal(calls.length, 3);

  const draw = await client.drawLottery({
    account: { cookie: "tabbit_session=lottery" },
    body: { activity_id: "activity_1", main_pool_id: "pool_1" },
    confirmSideEffect: true,
  });

  assert.equal(draw.ok, true);
  assert.equal(draw.source, "tabbit-lottery-draw");
  assert.equal(calls[3].url, "https://web.tabbit.ai/api/commerce/lottery/v1/draw");
  assert.equal(calls[3].options.headers["trace-id"], "00000000-0000-4000-8000-000000000008");
  assert.deepEqual(JSON.parse(calls[3].options.body), { activity_id: "activity_1", main_pool_id: "pool_1" });
});

test("read-only benefits queries reject missing paths, user id, or session before network", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({});
  };

  await assert.rejects(
    () => new ProtocolTabbitClient({ fetch }).getLotteryExplorationMe({ account: { cookie: "tabbit_session=activity" } }),
    (error) => {
      assert.equal(error.category, "protocol_missing");
      assert.equal(error.code, "MISSING_ACTIVITY_LOTTERY_PATH");
      return true;
    },
  );

  await assert.rejects(
    () => new ProtocolTabbitClient({ activityLotteryPath: "/api/commerce/activity/v1/lottery/me", fetch })
      .getLotteryExplorationMe({ account: {} }),
    (error) => {
      assert.equal(error.category, "session_missing");
      assert.equal(error.code, "SESSION_MISSING");
      return true;
    },
  );

  await assert.rejects(
    () => new ProtocolTabbitClient({ rewardCardRecordsPath: "/api/commerce/reward/v1/card-records", fetch })
      .listRewardCardRecords({ account: { cookie: "tabbit_session=records" } }),
    (error) => {
      assert.equal(error.category, "invalid_request");
      assert.equal(error.code, "MISSING_USER_ID");
      return true;
    },
  );

  await assert.rejects(
    () => new ProtocolTabbitClient({ fetch }).getPlacementResources({ account: { cookie: "tabbit_session=placement" } }),
    (error) => {
      assert.equal(error.category, "protocol_missing");
      assert.equal(error.code, "MISSING_PLACEMENT_RESOURCES_PATH");
      return true;
    },
  );

  await assert.rejects(
    () => new ProtocolTabbitClient({ placementResourcesPath: "/api/commerce/placement/v1/resources", fetch })
      .getPlacementResources({ account: {} }),
    (error) => {
      assert.equal(error.category, "session_missing");
      assert.equal(error.code, "SESSION_MISSING");
      return true;
    },
  );

  await assert.rejects(
    () => new ProtocolTabbitClient({ placementResourcesPath: "/api/commerce/placement/v1/resources", fetch })
      .getPlacementResources({ account: { cookie: "tabbit_session=placement" }, placementCode: "" }),
    (error) => {
      assert.equal(error.category, "invalid_request");
      assert.equal(error.code, "MISSING_PLACEMENT_CODE");
      return true;
    },
  );

  assert.equal(calls.length, 0);
});

test("uploadAttachment posts a signed request to the configured attachment upload path", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    attachmentUploadPath: "/chat/attachments/upload",
    now: () => 1700000000000,
    nonce: () => "nonce-upload",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/chat/sign-key")) return jsonResponse("sign-key-upload");
      return jsonResponse({ data: { id: "att_123", name: "a.png", mimeType: "image/png", size: 12 } });
    },
  });

  const result = await client.uploadAttachment({
    account: { cookie: "placeholder-cookie-valuebc" },
    attachment: { filename: "a.png", mimeType: "image/png", data: "base64-payload" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.attachment, {
    id: "att_123",
    name: "a.png",
    mimeType: "image/png",
    size: 12,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://web.tabbit.ai/chat/attachments/upload");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers.Cookie, "placeholder-cookie-valuebc");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, {
    attachment: { filename: "a.png", mimeType: "image/png", data: "base64-payload" },
  });
  assert.equal(
    calls[1].options.headers["x-signature"],
    expectedHmac("sign-key-upload", buildSignaturePayload({
      method: "POST",
      path: "/chat/attachments/upload",
      body,
      timestamp: 1700000000000,
      nonce: "nonce-upload",
    })),
  );
});

test("uploadAttachment uses the real COS presign, PUT, and complete-upload chain when configured", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    attachmentUploadPath: "/proxy/v0/cos/presigned-upload-url",
    attachmentCompleteUploadPath: "/api/v0/cos/complete-upload",
    uniqueUuid: () => "660001aa-2222-3333-4444-555555555555",
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/proxy/v0/cos/presigned-upload-url")) {
        return jsonResponse({
          url: "https://cos.example.test/upload/notes.txt",
          file_id: "file_cos_123",
          download_url: "https://cdn.example.test/file_cos_123",
        }, { headers: { "content-type": "application/json" } });
      }
      if (url === "https://cos.example.test/upload/notes.txt") {
        return jsonResponse("", { headers: { "content-type": "text/plain" } });
      }
      if (url.endsWith("/api/v0/cos/complete-upload")) {
        return jsonResponse({ status: "ok" }, { headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const result = await client.uploadAttachment({
    account: { cookieHeader: "placeholder-cookie-valuebc" },
    attachment: {
      filename: "notes.txt",
      mimeType: "text/plain",
      data: "SGVsbG8=",
      encoding: "base64",
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.attachment, {
    id: "file_cos_123",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    url: "https://cdn.example.test/file_cos_123",
  });
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/proxy/v0/cos/presigned-upload-url",
    "/upload/notes.txt",
    "/api/v0/cos/complete-upload",
  ]);
  assert.equal(calls[0].options.headers.Cookie, "placeholder-cookie-valuebc");
  assert.equal(calls[0].options.headers["trace-id"], "660001aa-2222-3333-4444-555555555555");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-signature"), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    file_category: "document",
    original_filename: "notes.txt",
    content_type: "text/plain",
  });
  assert.equal(calls[1].options.headers["Content-Type"], "text/plain");
  assert.equal(Buffer.from(calls[1].options.body).toString("utf8"), "Hello");
  assert.deepEqual(JSON.parse(calls[2].options.body), { file_id: "file_cos_123" });
  assert.equal(Object.hasOwn(calls[2].options.headers, "x-nonce"), false);
});

test("sendMessage rejects attachment payloads without uploaded file references", async () => {
  const calls = [];
  const client = new ProtocolTabbitClient({
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse("unused");
    },
    sendPath: "/chat/send",
  });

  const result = await client.sendMessage({
    account: { cookie: "placeholder-cookie-valuebc" },
    model: "Claude-Sonnet-4.6",
    messages: [{ role: "user", content: "hello" }],
    attachments: [{ filename: "a.png", data: "base64-payload" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "unsupported_feature");
  assert.equal(result.error.code, "ATTACHMENT_REFERENCE_REQUIRED");
  assert.equal(result.error.retryable, false);
  assert.equal(calls.length, 0);
});

test("classifyProtocolError maps core HTTP and network failures", () => {
  assert.equal(classifyProtocolError({ status: 401 }).category, "login_required");
  assert.equal(classifyProtocolError({ status: 403 }).category, "forbidden");
  assert.deepEqual(classifyProtocolError({ status: 429, headers: { get: () => "3" } }), {
    category: "rate_limited",
    status: 429,
    code: null,
    message: "Tabbit protocol request failed with status 429.",
    retryable: true,
    cooldownMs: 3000,
  });
  assert.equal(classifyProtocolError({ status: 503 }).category, "upstream_error");
  assert.equal(classifyProtocolError(new TypeError("fetch failed")).category, "network_error");
});

test("classifyProtocolError preserves Tabbit commerce error codes and messages", () => {
  assert.deepEqual(classifyProtocolError({
    status: 404,
    body: {
      error_code: "PRODUCT_NOT_PURCHASABLE",
      error_message: "usage reset coupon product is not purchasable",
    },
  }), {
    category: "invalid_request",
    status: 404,
    code: "PRODUCT_NOT_PURCHASABLE",
    message: "usage reset coupon product is not purchasable",
    retryable: false,
    cooldownMs: 0,
  });
});

test("classifyProtocolError maps quota exhaustion signals to account-local fallback", () => {
  assert.deepEqual(classifyProtocolError({
    status: 429,
    body: { code: "QUOTA_EXHAUSTED", message: "Current account quota exhausted" },
  }), {
    category: "quota_exhausted",
    status: 429,
    code: "QUOTA_EXHAUSTED",
    message: "Current account quota exhausted",
    retryable: true,
    cooldownMs: 0,
  });
});

test("classifyProtocolError treats temporary AI unavailability as retryable upstream failure", () => {
  assert.deepEqual(classifyProtocolError({
    status: 200,
    body: { message: "AI service temporarily unavailable, please try again later" },
  }), {
    category: "upstream_error",
    status: 200,
    code: null,
    message: "AI service temporarily unavailable, please try again later",
    retryable: true,
    cooldownMs: 10000,
  });
});

test("classifyProtocolError treats Chinese temporary AI unavailability as retryable upstream failure", () => {
  assert.deepEqual(classifyProtocolError({
    status: 200,
    body: { message: "AI 服务暂时不可用，请稍后重试" },
  }), {
    category: "upstream_error",
    status: 200,
    code: null,
    message: "AI 服务暂时不可用，请稍后重试",
    retryable: true,
    cooldownMs: 10000,
  });
});

test("sendMessage classifies upstream and protocol parse failures", async () => {
  const failing = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-send")
      : jsonResponse({ error: "temporary upstream outage" }, { status: 503, headers: { "content-type": "application/json" } }),
  });
  const failed = await failing.sendMessage({ account: {}, model: "m", messages: [{ role: "user", content: "x" }] });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.category, "upstream_error");
  assert.equal(failed.error.retryable, true);

  const malformed = new ProtocolTabbitClient({
    sendPath: "/chat/send",
    fetch: async (url) => url.endsWith("/chat/sign-key")
      ? jsonResponse("sign-key-send")
      : jsonResponse({ unexpected: true }, { headers: { "content-type": "application/json" } }),
  });
  const parsed = await malformed.sendMessage({ account: {}, model: "m", messages: [{ role: "user", content: "x" }] });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.category, "protocol_changed");
});
