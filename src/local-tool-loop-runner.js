import { PooledRequestError } from "./pooled-request-runner.js";

const DEFAULT_MODE = "client_executes_tools_first";
const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 16_000;

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PooledRequestError(`${label} must be a positive safe integer.`, {
      category: "invalid_request",
      code: "INVALID_LOCAL_TOOL_LOOP_LIMIT",
    });
  }
  return value;
}

function normalizedToolDefinition(tool = {}) {
  const name = cleanString(tool?.function?.name || tool?.name);
  if (!name) return null;
  return {
    name,
    description: cleanString(tool?.function?.description || tool?.description),
    inputSchema: cloneJson(tool?.function?.parameters || tool?.parameters || tool?.input_schema || {}),
    raw: cloneJson(tool),
  };
}

function normalizedTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map(normalizedToolDefinition)
    .filter(Boolean);
}

function stripToolFields(input = {}) {
  return {
    ...input,
    tools: null,
    toolChoice: null,
    parallelToolCalls: null,
  };
}

function hasAnyToolField(input = {}) {
  return (Array.isArray(input.tools) && input.tools.length > 0)
    || input.toolChoice !== null && input.toolChoice !== undefined
    || input.parallelToolCalls !== null && input.parallelToolCalls !== undefined;
}

function isNoneToolChoice(toolChoice) {
  return toolChoice === "none" || toolChoice?.type === "none";
}

function isAutoToolChoice(toolChoice) {
  return toolChoice === "auto" || toolChoice?.type === "auto";
}

function isNoopToolChoice(toolChoice) {
  return toolChoice === null || toolChoice === undefined || isAutoToolChoice(toolChoice) || isNoneToolChoice(toolChoice);
}

function errorResult(message, code, detail = null) {
  return {
    ok: false,
    error: new PooledRequestError(message, {
      category: "invalid_request",
      code,
      retryable: false,
      detail,
    }),
  };
}

function textFromContentBlocks(blocks = []) {
  return blocks
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("");
}

function parseJsonObjectFromText(text) {
  const value = cleanString(text);
  if (!value) return null;
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : value;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
      return JSON.parse(candidate.slice(first, last + 1));
    } catch {
      return null;
    }
  }
}

function parseToolInput(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? cloneJson(value) : {};
}

function normalizeToolUseBlock(block, index = 0) {
  const name = cleanString(block?.name || block?.function?.name);
  if (!name) return null;
  return {
    type: "tool_use",
    id: cleanString(block?.id || block?.call_id) || `call_${index}`,
    name,
    input: parseToolInput(block?.input ?? block?.arguments ?? block?.function?.arguments),
  };
}

function toolUsesFromJsonEnvelope(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  if (parsed.type === "tool_use") {
    const block = normalizeToolUseBlock(parsed);
    return block ? [block] : [];
  }
  if (parsed.tool_call && typeof parsed.tool_call === "object") {
    const block = normalizeToolUseBlock(parsed.tool_call);
    return block ? [block] : [];
  }
  if (Array.isArray(parsed.tool_calls)) {
    return parsed.tool_calls
      .map((block, index) => normalizeToolUseBlock(block, index))
      .filter(Boolean);
  }
  if (parsed.stop_reason === "tool_use" && Array.isArray(parsed.content)) {
    return parsed.content
      .map((block, index) => normalizeToolUseBlock(block, index))
      .filter(Boolean);
  }
  return [];
}

function toolUsesFromResult(result = {}) {
  const direct = (Array.isArray(result.contentBlocks) ? result.contentBlocks : [])
    .filter((block) => block?.type === "tool_use" && cleanString(block.name))
    .map((block, index) => normalizeToolUseBlock(block, index))
    .filter(Boolean);
  if (direct.length) return direct;
  return toolUsesFromJsonEnvelope(parseJsonObjectFromText(textFromContentBlocks(result.contentBlocks)));
}

function toolChoiceInstruction(toolChoice) {
  if (!toolChoice || toolChoice === "auto" || toolChoice?.type === "auto") {
    return "Tool use is optional. Use a tool only when it is needed to answer correctly.";
  }
  if (toolChoice === "none" || toolChoice?.type === "none") {
    return "Do not use tools. Answer directly.";
  }
  if (toolChoice === "required" || toolChoice?.type === "any") {
    return "Use exactly one listed tool before the final answer when a listed tool can satisfy the request.";
  }
  const forcedName = cleanString(toolChoice?.function?.name || toolChoice?.name);
  if (forcedName) return `Use the listed tool named "${forcedName}" if a tool call is needed.`;
  return "Tool use is optional. Use a tool only when it is needed to answer correctly.";
}

function buildToolInstructions({ tools, toolChoice, parallelToolCalls }) {
  return [
    "You are behind a local compatibility gateway that can execute selected local tools.",
    "Native Tabbit tool fields are unavailable, so tool calls must be represented as JSON text.",
    "If a tool is required, reply with exactly one JSON object and no markdown:",
    JSON.stringify({
      type: "tool_use",
      id: "call_unique_id",
      name: "tool_name",
      input: { any: "json arguments matching the tool schema" },
    }, null, 2),
    "After a tool result appears in the conversation, answer the user normally in plain text unless another tool is required.",
    toolChoiceInstruction(toolChoice),
    parallelToolCalls === false ? "Use at most one tool call per turn." : "Use no more tool calls than necessary.",
    "",
    "Available local tools:",
    JSON.stringify(tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })), null, 2),
  ].join("\n");
}

function buildLoopMessages(input, tools, workingMessages) {
  return [
    {
      role: "system",
      content: buildToolInstructions({
        tools,
        toolChoice: input.toolChoice,
        parallelToolCalls: input.parallelToolCalls,
      }),
    },
    ...workingMessages,
  ];
}

function truncate(value, limit) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text;
}

function normalizeToolResultContent(value, limit) {
  if (typeof value === "string") return truncate(value, limit);
  if (value && typeof value === "object" && typeof value.content === "string") {
    return truncate(value.content, limit);
  }
  return truncate(value ?? "", limit);
}

function appendUnique(target, values = []) {
  for (const value of values) {
    target.push(value);
  }
}

export class LocalToolLoopRunner {
  constructor({
    runner,
    mode = DEFAULT_MODE,
    executeToolUse = null,
    maxRounds = DEFAULT_MAX_ROUNDS,
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
  } = {}) {
    if (!runner || typeof runner.run !== "function") {
      throw new PooledRequestError("runner with run() is required", {
        category: "invalid_request",
        code: "MISSING_BASE_RUNNER",
      });
    }
    this.runner = runner;
    this.mode = cleanString(mode) || DEFAULT_MODE;
    this.executeToolUse = typeof executeToolUse === "function" ? executeToolUse : null;
    this.maxRounds = normalizePositiveInteger(maxRounds, DEFAULT_MAX_ROUNDS, "maxRounds");
    this.maxToolResultChars = normalizePositiveInteger(maxToolResultChars, DEFAULT_MAX_TOOL_RESULT_CHARS, "maxToolResultChars");
  }

  async run(input = {}) {
    const tools = normalizedTools(input.tools);
    if (this.mode === "disabled" && hasAnyToolField(input)) {
      return await this.runner.run(stripToolFields(input));
    }

    if (this.mode !== "local_executes_tools" || !tools.length) {
      if (this.mode === "local_executes_tools" && !tools.length && hasAnyToolField(input)) {
        if (!isNoopToolChoice(input.toolChoice)) {
          return errorResult(
            "Local tool execution mode requires non-empty tool definitions when tool_choice requires a tool.",
            "LOCAL_TOOL_DEFINITIONS_REQUIRED",
          );
        }
        return await this.runner.run(stripToolFields(input));
      }
      return await this.runner.run(input);
    }

    if (isNoneToolChoice(input.toolChoice)) {
      return await this.runner.run(stripToolFields(input));
    }

    if (!this.executeToolUse) {
      return errorResult(
        "Local tool execution mode requires an injected local tool executor.",
        "LOCAL_TOOL_EXECUTOR_MISSING",
      );
    }

    return await this.runLocalToolLoop(input, tools);
  }

  async runLocalToolLoop(input, tools) {
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    const workingMessages = Array.isArray(input.messages) ? cloneJson(input.messages) : [];
    const attemptedAccounts = [];
    let fallbackHappened = false;

    for (let round = 0; round < this.maxRounds; round += 1) {
      const result = await this.runner.run({
        ...stripToolFields(input),
        stream: false,
        messages: buildLoopMessages(input, tools, workingMessages),
      });
      appendUnique(attemptedAccounts, result.attemptedAccounts || []);
      fallbackHappened = fallbackHappened || Boolean(result.fallbackHappened);

      if (!result.ok) {
        return {
          ...result,
          attemptedAccounts,
          fallbackHappened,
        };
      }

      const toolUses = toolUsesFromResult(result);
      if (!toolUses.length) {
        return {
          ...result,
          attemptedAccounts,
          fallbackHappened,
        };
      }

      workingMessages.push({
        role: "assistant",
        content: textFromContentBlocks(result.contentBlocks),
      });

      for (const toolUse of toolUses) {
        const tool = toolsByName.get(toolUse.name);
        if (!tool) {
          return errorResult(`Unknown local tool '${toolUse.name}'.`, "LOCAL_TOOL_NOT_ALLOWED", {
            name: toolUse.name,
          });
        }

        const toolResult = await this.executeToolUse({
          id: toolUse.id,
          name: toolUse.name,
          input: cloneJson(toolUse.input),
          tool,
          round,
          request: cloneJson(input),
        });

        workingMessages.push({
          role: "tool",
          tool_call_id: toolUse.id,
          content: normalizeToolResultContent(toolResult, this.maxToolResultChars),
        });
      }
    }

    return errorResult(
      `Exceeded the local tool loop limit of ${this.maxRounds} round(s).`,
      "LOCAL_TOOL_LOOP_LIMIT_EXCEEDED",
    );
  }
}
