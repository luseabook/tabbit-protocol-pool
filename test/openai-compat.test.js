import test from "node:test";
import assert from "node:assert/strict";

import { OpenAICompat, normalizeChatCompletionsRequest, normalizeResponsesRequest } from "../src/openai-compat.js";

test("normalizeChatCompletionsRequest keeps model, messages, stream, and attachments", () => {
  const normalized = normalizeChatCompletionsRequest({
    model: "tabbit/priority",
    stream: true,
    messages: [
      { role: "system", content: "be concise" },
      { role: "user", content: "hello" },
    ],
    attachments: [{ filename: "a.txt" }],
  });

  assert.deepEqual(normalized, {
    model: "tabbit/priority",
    messages: [
      { role: "system", content: "be concise" },
      { role: "user", content: "hello" },
    ],
    stream: true,
    attachments: [{ filename: "a.txt" }],
    requiresPremium: false,
  });
});

test("handleChatCompletions calls runner and returns OpenAI chat shape", async () => {
  const calls = [];
  const compat = new OpenAICompat({
    now: () => 1700000000,
    idFactory: () => "chatcmpl_test",
    runner: {
      async run(input) {
        calls.push(input);
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "hello from pool" }],
          selectedModel: "tabbit/Claude-Sonnet-4.6",
          accountId: "acct_a",
          attemptedAccounts: ["acct_a"],
          fallbackHappened: false,
        };
      },
    },
  });

  const response = await compat.handleChatCompletions({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    attachments: [],
    stream: false,
    requiresPremium: false,
  }]);
  assert.deepEqual(response.body, {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 1700000000,
    model: "tabbit/priority",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "hello from pool" },
      finish_reason: "stop",
    }],
    metadata: {
      selected_model: "tabbit/Claude-Sonnet-4.6",
      account_id: "acct_a",
      attempted_accounts: "acct_a",
      fallback_happened: "false",
    },
  });
});

test("handleChatCompletions forwards uploaded attachments to the runner", async () => {
  const calls = [];
  const attachments = [{ type: "document", title: "guide.md", path: "file_doc_123" }];
  const compat = new OpenAICompat({
    now: () => 1700000000,
    idFactory: () => "chatcmpl_attachment",
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

  const response = await compat.handleChatCompletions({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "summarize" }],
    attachments,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].attachments, attachments);
});

test("handleChatCompletions forwards OpenAI tool definitions and tool choice to the runner", async () => {
  const calls = [];
  const tools = [{
    type: "function",
    function: {
      name: "read_file",
      description: "Read a repository file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  }];
  const compat = new OpenAICompat({
    now: () => 1700000004,
    idFactory: () => "chatcmpl_tools_test",
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "tool aware" }] };
      },
    },
  });

  const response = await compat.handleChatCompletions({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "inspect the repo" }],
    tools,
    tool_choice: { type: "function", function: { name: "read_file" } },
    parallel_tool_calls: false,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].tools, tools);
  assert.deepEqual(calls[0].toolChoice, { type: "function", function: { name: "read_file" } });
  assert.equal(calls[0].parallelToolCalls, false);
});

test("normalizeChatCompletionsRequest ignores empty tools without defaulting tool choice", () => {
  const normalized = normalizeChatCompletionsRequest({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    parallel_tool_calls: false,
  });

  assert.equal(Object.hasOwn(normalized, "tools"), false);
  assert.equal(Object.hasOwn(normalized, "toolChoice"), false);
  assert.equal(Object.hasOwn(normalized, "parallelToolCalls"), false);
});

test("normalizeChatCompletionsRequest ignores no-op tool options when no tools are provided", () => {
  const normalized = normalizeChatCompletionsRequest({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    tool_choice: "none",
    parallel_tool_calls: false,
  });

  assert.equal(Object.hasOwn(normalized, "tools"), false);
  assert.equal(Object.hasOwn(normalized, "toolChoice"), false);
  assert.equal(Object.hasOwn(normalized, "parallelToolCalls"), false);
});

test("handleResponses can strip known Codex client tools for text-only upstreams", async () => {
  const calls = [];
  const compat = new OpenAICompat({
    stripClientTools: true,
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    },
  });

  await compat.handleResponses({
    model: "tabbit/priority",
    input: "hello",
    tools: [
      { type: "function", name: "update_plan", parameters: { type: "object" } },
      { type: "function", name: "request_user_input", parameters: { type: "object" } },
      { type: "function", name: "view_image", parameters: { type: "object" } },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
  });

  assert.equal(Object.hasOwn(calls[0], "tools"), false);
  assert.equal(Object.hasOwn(calls[0], "toolChoice"), false);
  assert.equal(Object.hasOwn(calls[0], "parallelToolCalls"), false);
});

test("handleResponses keeps non-client tools when client tool stripping is enabled", async () => {
  const calls = [];
  const userTool = { type: "function", name: "read_file", parameters: { type: "object" } };
  const compat = new OpenAICompat({
    stripClientTools: true,
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    },
  });

  await compat.handleResponses({
    model: "tabbit/priority",
    input: "hello",
    tools: [
      { type: "function", name: "update_plan", parameters: { type: "object" } },
      userTool,
    ],
  });

  assert.deepEqual(calls[0].tools, [userTool]);
  assert.equal(calls[0].toolChoice, "auto");
});

test("normalizeChatCompletionsRequest preserves OpenAI tool-call round-trip messages", () => {
  const toolCalls = [{
    id: "call_read_file",
    type: "function",
    function: {
      name: "read_file",
      arguments: "{\"path\":\"package.json\"}",
    },
  }];

  const normalized = normalizeChatCompletionsRequest({
    model: "tabbit/priority",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: toolCalls,
      },
      {
        role: "tool",
        tool_call_id: "call_read_file",
        content: "{\"name\":\"tabbit2api\"}",
      },
    ],
  });

  assert.deepEqual(normalized.messages, [
    {
      role: "assistant",
      content: null,
      tool_calls: toolCalls,
    },
    {
      role: "tool",
      tool_call_id: "call_read_file",
      content: "{\"name\":\"tabbit2api\"}",
    },
  ]);
});

test("handleChatCompletions maps tool_use blocks to OpenAI tool_calls", async () => {
  const compat = new OpenAICompat({
    now: () => 1700000006,
    idFactory: () => "chatcmpl_tool_call_test",
    runner: {
      async run() {
        return {
          ok: true,
          stopReason: "tool_use",
          contentBlocks: [
            { type: "text", text: "I need to inspect the file." },
            { type: "tool_use", id: "call_read_file", name: "read_file", input: { path: "package.json" } },
          ],
        };
      },
    },
  });

  const response = await compat.handleChatCompletions({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "read package metadata" }],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.choices[0].message, {
    role: "assistant",
    content: "I need to inspect the file.",
    tool_calls: [{
      id: "call_read_file",
      type: "function",
      function: {
        name: "read_file",
        arguments: "{\"path\":\"package.json\"}",
      },
    }],
  });
  assert.equal(response.body.choices[0].finish_reason, "tool_calls");
});

test("handleChatCompletions passes async stream deltas as non-public metadata", async () => {
  async function* streamDeltas() {
    yield "Hel";
    yield "lo";
  }

  const deltas = streamDeltas();
  const compat = new OpenAICompat({
    now: () => 1700000002,
    idFactory: () => "chatcmpl_stream_test",
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

  const response = await compat.handleChatCompletions({
    model: "tabbit/priority",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(response.status, 200);
  assert.equal(response.stream.deltas, deltas);
  assert.equal(Object.hasOwn(response.body, "stream"), false);
  assert.equal(Object.hasOwn(response.body, "streamDeltas"), false);
});

test("normalizeResponsesRequest converts string and array input to messages", () => {
  assert.deepEqual(normalizeResponsesRequest({ model: "tabbit/priority", input: "hello" }), {
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
    attachments: [],
    requiresPremium: false,
  });
  assert.deepEqual(normalizeResponsesRequest({ input: [{ role: "user", content: "one" }, { type: "message", role: "assistant", content: "two" }] }).messages, [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
  ]);
});

test("handleResponses calls runner and returns OpenAI responses shape", async () => {
  const calls = [];
  const compat = new OpenAICompat({
    now: () => 1700000001,
    idFactory: () => "resp_test",
    runner: {
      async run(input) {
        calls.push(input);
        return {
          ok: true,
          contentBlocks: [{ type: "text", text: "response text" }],
          selectedModel: "tabbit/Claude-Sonnet-4.6",
          accountId: "acct_b",
          attemptedAccounts: ["acct_a", "acct_b"],
          fallbackHappened: true,
        };
      },
    },
  });

  const response = await compat.handleResponses({ model: "tabbit/priority", input: "hello" });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    attachments: [],
    stream: false,
    requiresPremium: false,
  }]);
  assert.deepEqual(response.body, {
    id: "resp_test",
    object: "response",
    created_at: 1700000001,
    model: "tabbit/priority",
    output_text: "response text",
    output: [{
      id: "msg_resp_test",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "response text" }],
    }],
    metadata: {
      selected_model: "tabbit/Claude-Sonnet-4.6",
      account_id: "acct_b",
      attempted_accounts: "acct_a,acct_b",
      fallback_happened: "true",
    },
  });
});

test("handleResponses forwards uploaded attachments to the runner", async () => {
  const calls = [];
  const attachments = [{ type: "image", title: "diagram.png", path: "file_img_456", content: "https://cdn.example.test/diagram.png" }];
  const compat = new OpenAICompat({
    now: () => 1700000000,
    idFactory: () => "resp_attachment",
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

  const response = await compat.handleResponses({
    model: "tabbit/priority",
    input: "describe",
    attachments,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].attachments, attachments);
});

test("handleResponses forwards OpenAI Responses tools and defaults tool choice to auto", async () => {
  const calls = [];
  const tools = [{ type: "function", name: "apply_patch", parameters: { type: "object" } }];
  const compat = new OpenAICompat({
    now: () => 1700000005,
    idFactory: () => "resp_tools_test",
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "responses tool aware" }] };
      },
    },
  });

  const response = await compat.handleResponses({
    model: "tabbit/priority",
    input: "edit the code",
    tools,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].tools, tools);
  assert.equal(calls[0].toolChoice, "auto");
});

test("normalizeResponsesRequest preserves function_call and function_call_output input items", () => {
  const normalized = normalizeResponsesRequest({
    model: "tabbit/priority",
    input: [
      {
        type: "function_call",
        call_id: "call_read_file",
        name: "read_file",
        arguments: "{\"path\":\"package.json\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_read_file",
        output: "{\"name\":\"tabbit2api\"}",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue after reading package.json" }],
      },
    ],
  });

  assert.deepEqual(normalized.messages, [
    {
      type: "function_call",
      call_id: "call_read_file",
      name: "read_file",
      arguments: "{\"path\":\"package.json\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_read_file",
      output: "{\"name\":\"tabbit2api\"}",
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "continue after reading package.json" }],
    },
  ]);
});

test("handleResponses maps tool_use blocks to OpenAI function_call output items", async () => {
  const compat = new OpenAICompat({
    now: () => 1700000007,
    idFactory: () => "resp_tool_call_test",
    runner: {
      async run() {
        return {
          ok: true,
          stopReason: "tool_use",
          contentBlocks: [
            { type: "text", text: "I will run the tests." },
            { type: "tool_use", id: "call_run_tests", name: "run_tests", input: { command: "node --test" } },
          ],
        };
      },
    },
  });

  const response = await compat.handleResponses({
    model: "tabbit/priority",
    input: "verify the project",
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.output_text, "I will run the tests.");
  assert.deepEqual(response.body.output, [
    {
      id: "msg_resp_tool_call_test",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "I will run the tests." }],
    },
    {
      id: "fc_call_run_tests",
      type: "function_call",
      call_id: "call_run_tests",
      name: "run_tests",
      arguments: "{\"command\":\"node --test\"}",
      status: "completed",
    },
  ]);
});

test("handleResponses passes async stream deltas as non-public metadata", async () => {
  async function* streamDeltas() {
    yield "one";
    yield "two";
  }

  const deltas = streamDeltas();
  const compat = new OpenAICompat({
    now: () => 1700000003,
    idFactory: () => "resp_stream_test",
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

  const response = await compat.handleResponses({
    model: "tabbit/priority",
    stream: true,
    input: "hello",
  });

  assert.equal(response.status, 200);
  assert.equal(response.stream.deltas, deltas);
  assert.equal(Object.hasOwn(response.body, "stream"), false);
  assert.equal(Object.hasOwn(response.body, "streamDeltas"), false);
});

test("handlers map empty prompts and pooled errors to OpenAI error shapes", async () => {
  const compat = new OpenAICompat({
    runner: {
      async run() {
        return { ok: false, error: { category: "no_available_account", code: "NO_AVAILABLE_ACCOUNT", message: "No accounts" } };
      },
    },
  });

  assert.deepEqual(await compat.handleChatCompletions({ model: "tabbit/priority", messages: [] }), {
    status: 400,
    body: { error: { message: "No conversation messages or attachments were provided.", type: "invalid_request_error", code: "invalid_request" } },
  });
  assert.deepEqual(await compat.handleResponses({ model: "tabbit/priority", input: "hello" }), {
    status: 503,
    body: { error: { message: "No accounts", type: "api_error", code: "NO_AVAILABLE_ACCOUNT" } },
  });
});

test("invalid request and timeout categories map to expected statuses", async () => {
  const invalid = new OpenAICompat({ runner: { async run() { return { ok: false, error: { category: "invalid_request", code: "BAD_REQUEST", message: "bad" } }; } } });
  const timeout = new OpenAICompat({ runner: { async run() { return { ok: false, error: { category: "timeout", code: "TIMEOUT", message: "slow" } }; } } });
  const upstream = new OpenAICompat({ runner: { async run() { return { ok: false, error: { category: "upstream_error", code: "UPSTREAM_UNAVAILABLE", message: "temporarily unavailable" } }; } } });

  assert.deepEqual(await invalid.handleChatCompletions({ messages: [{ role: "user", content: "x" }] }), {
    status: 400,
    body: { error: { message: "bad", type: "invalid_request_error", code: "BAD_REQUEST" } },
  });
  assert.deepEqual(await timeout.handleChatCompletions({ messages: [{ role: "user", content: "x" }] }), {
    status: 504,
    body: { error: { message: "slow", type: "api_error", code: "TIMEOUT" } },
  });
  assert.deepEqual(await upstream.handleChatCompletions({ messages: [{ role: "user", content: "x" }] }), {
    status: 503,
    body: { error: { message: "temporarily unavailable", type: "api_error", code: "UPSTREAM_UNAVAILABLE" } },
  });
});
