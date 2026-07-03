import test from "node:test";
import assert from "node:assert/strict";

import { AnthropicCompat, buildAnthropicMessageResponse, normalizeAnthropicMessagesRequest } from "../src/anthropic-compat.js";

test("normalizeAnthropicMessagesRequest converts system and messages for the runner", () => {
  const normalized = normalizeAnthropicMessagesRequest({
    model: "tabbit/priority",
    system: "You are helpful.",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "again" }, { type: "image", source: { type: "base64" } }] },
    ],
    stream: true,
    max_tokens: 64,
    requires_premium: true,
    attachments: [{ id: "att_1" }],
  });

  assert.deepEqual(normalized, {
    model: "tabbit/priority",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ],
    stream: true,
    maxTokens: 64,
    attachments: [{ id: "att_1" }],
    requiresPremium: true,
  });
});

test("handleMessages calls runner and returns Anthropic message JSON", async () => {
  const calls = [];
  const compat = new AnthropicCompat({
    now: () => 1782961200,
    idFactory: () => "msg_gateway_test",
    runner: {
      async run(input) {
        calls.push(input);
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "anthropic ok" }],
          selectedModel: input.model,
          accountId: "acct_a",
          attemptedAccounts: ["acct_a"],
          fallbackHappened: false,
        };
      },
    },
  });

  const result = await compat.handleMessages({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 32,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    maxTokens: 32,
    attachments: [],
    requiresPremium: false,
  }]);
  assert.deepEqual(result.body, {
    id: "msg_gateway_test",
    type: "message",
    role: "assistant",
    model: "tabbit/priority",
    content: [{ type: "text", text: "anthropic ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    metadata: {
      selected_model: "tabbit/priority",
      account_id: "acct_a",
      attempted_accounts: "acct_a",
      fallback_happened: "false",
      created_at: "1782961200",
    },
  });
});

test("handleMessages forwards uploaded attachments to the runner", async () => {
  const calls = [];
  const attachments = [{ type: "document", title: "guide.md", path: "file_doc_123" }];
  const compat = new AnthropicCompat({
    now: () => 1782961200,
    idFactory: () => "msg_attachment",
    runner: {
      async run(input) {
        calls.push(input);
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "attachment ok" }],
          selectedModel: input.model,
          accountId: "acct_a",
          attemptedAccounts: ["acct_a"],
          fallbackHappened: false,
        };
      },
    },
  });

  const result = await compat.handleMessages({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "summarize" }],
    max_tokens: 32,
    attachments,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(calls[0].attachments, attachments);
});

test("handleMessages forwards Anthropic tools and tool choice to the runner", async () => {
  const calls = [];
  const tools = [{
    name: "run_tests",
    description: "Run a test command",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  }];
  const compat = new AnthropicCompat({
    now: () => 1782961202,
    idFactory: () => "msg_tools_test",
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "anthropic tool aware" }] };
      },
    },
  });

  const response = await compat.handleMessages({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "verify the change" }],
    tools,
    tool_choice: { type: "tool", name: "run_tests" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].tools, tools);
  assert.deepEqual(calls[0].toolChoice, { type: "tool", name: "run_tests" });
});

test("normalizeAnthropicMessagesRequest ignores empty tools without defaulting tool choice", () => {
  const normalized = normalizeAnthropicMessagesRequest({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  });

  assert.equal(Object.hasOwn(normalized, "tools"), false);
  assert.equal(Object.hasOwn(normalized, "toolChoice"), false);
});

test("normalizeAnthropicMessagesRequest ignores auto tool choice when no tools are provided", () => {
  const normalized = normalizeAnthropicMessagesRequest({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    tool_choice: { type: "auto" },
  });

  assert.equal(Object.hasOwn(normalized, "tools"), false);
  assert.equal(Object.hasOwn(normalized, "toolChoice"), false);
});

test("normalizeAnthropicMessagesRequest preserves tool_use and tool_result content blocks", () => {
  const assistantContent = [{
    type: "tool_use",
    id: "toolu_read_file",
    name: "read_file",
    input: { path: "package.json" },
  }];
  const toolResultContent = [{
    type: "tool_result",
    tool_use_id: "toolu_read_file",
    content: "{\"name\":\"tabbit2api\"}",
  }];

  const normalized = normalizeAnthropicMessagesRequest({
    model: "tabbit/priority",
    messages: [
      { role: "assistant", content: assistantContent },
      { role: "user", content: toolResultContent },
    ],
  });

  assert.deepEqual(normalized.messages, [
    { role: "assistant", content: assistantContent },
    { role: "user", content: toolResultContent },
  ]);
});

test("handleMessages preserves tool_use blocks for Anthropic clients", async () => {
  const compat = new AnthropicCompat({
    now: () => 1782961203,
    idFactory: () => "msg_tool_use_test",
    runner: {
      async run() {
        return {
          ok: true,
          stopReason: "tool_use",
          contentBlocks: [
            { type: "text", text: "I will inspect the file." },
            { type: "tool_use", id: "toolu_read_file", name: "read_file", input: { path: "package.json" } },
          ],
        };
      },
    },
  });

  const response = await compat.handleMessages({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "read package metadata" }],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.stop_reason, "tool_use");
  assert.deepEqual(response.body.content, [
    { type: "text", text: "I will inspect the file." },
    { type: "tool_use", id: "toolu_read_file", name: "read_file", input: { path: "package.json" } },
  ]);
});

test("handleMessages passes async stream deltas as non-public metadata", async () => {
  async function* streamDeltas() {
    yield "Hel";
    yield "lo";
  }

  const deltas = streamDeltas();
  const compat = new AnthropicCompat({
    now: () => 1782961201,
    idFactory: () => "msg_stream_test",
    runner: {
      async run() {
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "" }],
          selectedModel: "tabbit/Claude-Sonnet-4.6",
          streamDeltas: deltas,
        };
      },
    },
  });

  const response = await compat.handleMessages({
    model: "tabbit/priority",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(response.status, 200);
  assert.equal(response.stream.deltas, deltas);
  assert.equal(Object.hasOwn(response.body, "stream"), false);
  assert.equal(Object.hasOwn(response.body, "streamDeltas"), false);
});

test("buildAnthropicMessageResponse joins text content blocks and preserves tool_use blocks", () => {
  const body = buildAnthropicMessageResponse(
    { model: "tabbit/priority" },
    { contentBlocks: [{ type: "text", text: "a" }, { type: "tool_use", name: "ignored" }, { type: "text", text: "b" }] },
    { id: "msg_test", created: 1 },
  );

  assert.deepEqual(body.content, [
    { type: "text", text: "ab" },
    { type: "tool_use", id: "toolu_0", name: "ignored", input: {} },
  ]);
});

test("handleMessages returns Anthropic invalid_request for empty input", async () => {
  const compat = new AnthropicCompat({
    runner: { async run() { throw new Error("must not call runner"); } },
  });

  const result = await compat.handleMessages({ messages: [] });

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "No conversation messages or attachments were provided.",
    },
    metadata: { code: "invalid_request" },
  });
});

test("handleMessages maps pooled errors to Anthropic error envelope", async () => {
  const cases = [
    { category: "no_available_account", code: "NO_AVAILABLE_ACCOUNT", status: 503, type: "api_error" },
    { category: "login_required", code: "LOGIN_REQUIRED", status: 401, type: "authentication_error" },
  ];

  for (const item of cases) {
    const compat = new AnthropicCompat({
      runner: {
        async run() {
          return { ok: false, error: { category: item.category, code: item.code, message: `${item.category} message` } };
        },
      },
    });

    const result = await compat.handleMessages({ messages: [{ role: "user", content: "hello" }] });

    assert.equal(result.status, item.status);
    assert.deepEqual(result.body, {
      type: "error",
      error: { type: item.type, message: `${item.category} message` },
      metadata: { code: item.code },
    });
  }
});
