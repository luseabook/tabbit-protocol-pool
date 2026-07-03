import test from "node:test";
import assert from "node:assert/strict";

import { LocalToolLoopRunner } from "../src/local-tool-loop-runner.js";
import { LocalToolLoopRunner as ExportedLocalToolLoopRunner } from "../src/index.js";

const tools = [{
  type: "function",
  function: {
    name: "lookup_weather",
    description: "Lookup weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
}];

test("src/index exports LocalToolLoopRunner", () => {
  assert.equal(ExportedLocalToolLoopRunner, LocalToolLoopRunner);
});

test("local_executes_tools strips native tool fields, executes injected tool, and returns final text", async () => {
  const runnerCalls = [];
  const toolCalls = [];
  const baseRunner = {
    async run(input) {
      runnerCalls.push(input);
      const sawToolResult = input.messages.some((message) => message.role === "tool");
      if (!sawToolResult) {
        return {
          ok: true,
          contentBlocks: [{
            type: "text",
            text: JSON.stringify({
              type: "tool_use",
              id: "call_weather",
              name: "lookup_weather",
              input: { city: "Shanghai" },
            }),
          }],
          attemptedAccounts: ["acct_a"],
          selectedModel: input.model,
        };
      }

      return {
        ok: true,
        contentBlocks: [{ type: "text", text: "Shanghai is 29 C." }],
        attemptedAccounts: ["acct_a"],
        selectedModel: input.model,
      };
    },
  };
  const runner = new LocalToolLoopRunner({
    runner: baseRunner,
    mode: "local_executes_tools",
    executeToolUse: async (call) => {
      toolCalls.push(call);
      return { temperature: "29 C" };
    },
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "weather?" }],
    tools,
    toolChoice: "auto",
    parallelToolCalls: false,
    stream: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.contentBlocks, [{ type: "text", text: "Shanghai is 29 C." }]);
  assert.equal(runnerCalls.length, 2);
  assert.equal(runnerCalls[0].tools, null);
  assert.equal(runnerCalls[0].toolChoice, null);
  assert.equal(runnerCalls[0].parallelToolCalls, null);
  assert.equal(runnerCalls[0].stream, false);
  assert.match(runnerCalls[0].messages[0].content, /Available local tools/);
  assert.deepEqual(toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    input: call.input,
    toolName: call.tool.name,
  })), [{
    id: "call_weather",
    name: "lookup_weather",
    input: { city: "Shanghai" },
    toolName: "lookup_weather",
  }]);
  assert.deepEqual(runnerCalls[1].messages.at(-1), {
    role: "tool",
    tool_call_id: "call_weather",
    content: "{\"temperature\":\"29 C\"}",
  });
  assert.deepEqual(result.attemptedAccounts, ["acct_a", "acct_a"]);
});

test("local_executes_tools returns invalid_request when no local executor is configured", async () => {
  let called = false;
  const runner = new LocalToolLoopRunner({
    runner: {
      async run() {
        called = true;
        return { ok: true, contentBlocks: [{ type: "text", text: "unexpected" }] };
      },
    },
    mode: "local_executes_tools",
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "weather?" }],
    tools,
    toolChoice: "auto",
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.error.category, "invalid_request");
  assert.equal(result.error.code, "LOCAL_TOOL_EXECUTOR_MISSING");
});

test("client_executes_tools_first keeps existing native tool pass-through behavior", async () => {
  const calls = [];
  const runner = new LocalToolLoopRunner({
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    },
    mode: "client_executes_tools_first",
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "weather?" }],
    tools,
    toolChoice: "auto",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].tools, tools);
  assert.equal(calls[0].toolChoice, "auto");
});

test("disabled mode strips tool fields before calling the base runner", async () => {
  const calls = [];
  const runner = new LocalToolLoopRunner({
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    },
    mode: "disabled",
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "weather?" }],
    tools,
    toolChoice: "auto",
    parallelToolCalls: true,
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].tools, null);
  assert.equal(calls[0].toolChoice, null);
  assert.equal(calls[0].parallelToolCalls, null);
});

test("disabled mode strips isolated tool choice before calling the base runner", async () => {
  const calls = [];
  const runner = new LocalToolLoopRunner({
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    },
    mode: "disabled",
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    toolChoice: "required",
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].toolChoice, null);
});

test("local_executes_tools honors tool_choice none without requiring an executor", async () => {
  const calls = [];
  const runner = new LocalToolLoopRunner({
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    },
    mode: "local_executes_tools",
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    tools,
    toolChoice: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].tools, null);
  assert.equal(calls[0].toolChoice, null);
});

test("local_executes_tools rejects required tool choice when no executable tools are defined", async () => {
  const runner = new LocalToolLoopRunner({
    runner: {
      async run() {
        throw new Error("native tool choice should not reach protocol runner");
      },
    },
    mode: "local_executes_tools",
    executeToolUse: async () => "unused",
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    toolChoice: "required",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "invalid_request");
  assert.equal(result.error.code, "LOCAL_TOOL_DEFINITIONS_REQUIRED");
});

test("local_executes_tools treats isolated tool_choice none as a no-op", async () => {
  const calls = [];
  const runner = new LocalToolLoopRunner({
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    },
    mode: "local_executes_tools",
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    toolChoice: "none",
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].toolChoice, null);
});

test("local_executes_tools treats isolated tool_choice auto as a no-op", async () => {
  const calls = [];
  const runner = new LocalToolLoopRunner({
    runner: {
      async run(input) {
        calls.push(input);
        return { ok: true, contentBlocks: [{ type: "text", text: "ok" }] };
      },
    },
    mode: "local_executes_tools",
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "hello" }],
    toolChoice: "auto",
  });

  assert.equal(result.ok, true);
  assert.equal(calls[0].toolChoice, null);
});

test("local_executes_tools stops at the configured tool loop round limit", async () => {
  const runner = new LocalToolLoopRunner({
    runner: {
      async run(input) {
        return {
          ok: true,
          contentBlocks: [{
            type: "text",
            text: JSON.stringify({
              type: "tool_use",
              id: `call_${input.messages.length}`,
              name: "lookup_weather",
              input: { city: "Shanghai" },
            }),
          }],
        };
      },
    },
    mode: "local_executes_tools",
    maxRounds: 1,
    executeToolUse: async () => "still needs another round",
  });

  const result = await runner.run({
    model: "tabbit/priority",
    messages: [{ role: "user", content: "weather?" }],
    tools,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.category, "invalid_request");
  assert.equal(result.error.code, "LOCAL_TOOL_LOOP_LIMIT_EXCEEDED");
});
