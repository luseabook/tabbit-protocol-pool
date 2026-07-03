function textFromContentBlocks(blocks = []) {
  return blocks.map((block) => (block?.type === "text" ? block.text : "")).filter(Boolean).join("");
}

function toolUseBlocks(blocks = []) {
  return blocks.filter((block) => block?.type === "tool_use" && block.name);
}

function toolArguments(input) {
  if (typeof input === "string") return input;
  return JSON.stringify(input ?? {});
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function openAiToolCalls(blocks = []) {
  return toolUseBlocks(blocks).map((block, index) => ({
    id: String(block.id || `call_${index}`),
    type: "function",
    function: {
      name: String(block.name),
      arguments: toolArguments(block.input),
    },
  }));
}

function openAiFinishReason(result = {}, toolCalls = []) {
  if (toolCalls.length || result.stopReason === "tool_use" || result.stopReason === "tool_calls") return "tool_calls";
  return result.stopReason || "stop";
}

function cleanMessage(message) {
  const clean = {
    role: message?.role || "user",
  };
  if (Object.hasOwn(message || {}, "content")) {
    clean.content = typeof message.content === "string" || message.content === null
      ? message.content
      : (typeof message.content === "object" ? cloneJson(message.content) : String(message.content ?? ""));
  } else {
    clean.content = "";
  }
  for (const key of ["name", "tool_call_id", "tool_calls", "function_call"]) {
    if (Object.hasOwn(message || {}, key)) clean[key] = cloneJson(message[key]);
  }
  return clean;
}

function normalizeInputItem(item) {
  if (typeof item === "string") return { role: "user", content: item };
  if (isPlainObject(item) && (item.type === "function_call" || item.type === "function_call_output")) return cloneJson(item);
  if (item?.type === "message" || item?.role) return cleanMessage(item);
  if (item?.type === "input_text" || item?.text) return { role: "user", content: String(item.text || item.content || "") };
  const content = item?.content;
  return {
    role: "user",
    content: typeof content === "string" ? content : (typeof content === "object" && content !== null ? cloneJson(content) : String(content ?? "")),
  };
}

const STRIPPABLE_CLIENT_TOOL_NAMES = new Set([
  "update_plan",
  "request_user_input",
  "view_image",
]);

function openAiToolName(tool = {}) {
  return tool?.name || tool?.function?.name || "";
}

function isStrippableClientTool(tool = {}) {
  return tool?.type === "function" && STRIPPABLE_CLIENT_TOOL_NAMES.has(openAiToolName(tool));
}

function isAutoToolChoice(value) {
  return value === "auto" || value?.type === "auto";
}

function isNoopToolChoice(value) {
  return isAutoToolChoice(value) || value === "none" || value?.type === "none";
}

function normalizeToolOptions(body = {}, { stripClientTools = false } = {}) {
  const options = {};
  if (Array.isArray(body.tools)) {
    const tools = stripClientTools
      ? body.tools.filter((tool) => !isStrippableClientTool(tool))
      : body.tools;
    if (tools.length > 0) {
      options.tools = tools;
      options.toolChoice = Object.hasOwn(body, "tool_choice") ? body.tool_choice : "auto";
      if (Object.hasOwn(body, "parallel_tool_calls")) {
        options.parallelToolCalls = Boolean(body.parallel_tool_calls);
      }
    } else if (Object.hasOwn(body, "tool_choice") && !isNoopToolChoice(body.tool_choice)) {
      options.toolChoice = body.tool_choice;
    }
  } else if (Object.hasOwn(body, "tool_choice") && !isNoopToolChoice(body.tool_choice)) {
    options.toolChoice = body.tool_choice;
  }
  return options;
}

export function normalizeChatCompletionsRequest(body = {}, options = {}) {
  return {
    model: body.model || "tabbit/priority",
    messages: Array.isArray(body.messages) ? body.messages.map(cleanMessage) : [],
    stream: Boolean(body.stream),
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    requiresPremium: Boolean(body.requiresPremium || body.requires_premium),
    ...normalizeToolOptions(body, options),
  };
}

export function normalizeResponsesRequest(body = {}, options = {}) {
  const input = body.input;
  const messages = Array.isArray(input) ? input.map(normalizeInputItem) : (typeof input === "string" ? [{ role: "user", content: input }] : []);
  return {
    model: body.model || "tabbit/priority",
    messages,
    stream: Boolean(body.stream),
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    requiresPremium: Boolean(body.requiresPremium || body.requires_premium),
    ...normalizeToolOptions(body, options),
  };
}

function routeMetadata(result) {
  return {
    selected_model: result.selectedModel || "",
    account_id: result.accountId || "",
    attempted_accounts: (result.attemptedAccounts || []).join(","),
    fallback_happened: String(Boolean(result.fallbackHappened)),
  };
}

function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === "function";
}

function streamMetadata(result = {}, normalized = {}) {
  if (!normalized.stream) return null;
  if (isAsyncIterable(result.streamDeltas)) return { deltas: result.streamDeltas };
  const deltas = Array.isArray(result.streamDeltas)
    ? result.streamDeltas.filter((delta) => typeof delta === "string" && delta.length > 0)
    : [];
  return deltas.length ? { deltas } : null;
}

export function buildChatCompletionResponse(normalized, result, { id, created }) {
  const toolCalls = openAiToolCalls(result.contentBlocks);
  const message = { role: "assistant", content: textFromContentBlocks(result.contentBlocks) };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id,
    object: "chat.completion",
    created,
    model: normalized.model,
    choices: [{
      index: 0,
      message,
      finish_reason: openAiFinishReason(result, toolCalls),
    }],
    metadata: routeMetadata(result),
  };
}

export function buildResponsesResponse(normalized, result, { id, created }) {
  const text = textFromContentBlocks(result.contentBlocks);
  const toolCalls = openAiToolCalls(result.contentBlocks);
  const output = [];
  if (text || !toolCalls.length) {
    output.push({
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
  output.push(...toolCalls.map((toolCall) => ({
    id: `fc_${toolCall.id}`,
    type: "function_call",
    call_id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
    status: "completed",
  })));
  return {
    id,
    object: "response",
    created_at: created,
    model: normalized.model,
    output_text: text,
    output,
    metadata: routeMetadata(result),
  };
}

function openAiError(message, type = "invalid_request_error", code = "invalid_request") {
  return { error: { message, type, code } };
}

export function openAiErrorForCategory(error = {}) {
  const category = error.category || "unknown";
  const code = error.code || category;
  const message = error.message || "Pooled request failed.";
  if (category === "invalid_request") {
    return { status: 400, body: openAiError(message, "invalid_request_error", code) };
  }
  if (category === "login_required") {
    return { status: 401, body: openAiError(message, "authentication_error", code) };
  }
  if (category === "timeout") {
    return { status: 504, body: openAiError(message, "api_error", code) };
  }
  if (category === "no_available_account") {
    return { status: 503, body: openAiError(message, "api_error", code) };
  }
  return { status: 502, body: openAiError(message, "api_error", code) };
}

export class OpenAICompat {
  constructor({ runner, now = () => Math.floor(Date.now() / 1000), idFactory = () => `chatcmpl_${Date.now()}`, stripClientTools = false } = {}) {
    if (!runner || typeof runner.run !== "function") throw new Error("runner with run() is required");
    this.runner = runner;
    this.now = now;
    this.idFactory = idFactory;
    this.stripClientTools = Boolean(stripClientTools);
  }

  async handleChatCompletions(body = {}) {
    const normalized = normalizeChatCompletionsRequest(body, { stripClientTools: this.stripClientTools });
    if (!normalized.messages.length && !normalized.attachments.length) return { status: 400, body: openAiError("No conversation messages or attachments were provided.") };
    const result = await this.runner.run(normalized);
    if (!result.ok) return openAiErrorForCategory(result.error);
    const response = { status: 200, body: buildChatCompletionResponse(normalized, result, { id: this.idFactory("chat"), created: this.now() }) };
    const stream = streamMetadata(result, normalized);
    if (stream) response.stream = stream;
    return response;
  }

  async handleResponses(body = {}) {
    const normalized = normalizeResponsesRequest(body, { stripClientTools: this.stripClientTools });
    if (!normalized.messages.length && !normalized.attachments.length) return { status: 400, body: openAiError("No prompt text or attachments were found in the request body.") };
    const result = await this.runner.run(normalized);
    if (!result.ok) return openAiErrorForCategory(result.error);
    const response = { status: 200, body: buildResponsesResponse(normalized, result, { id: this.idFactory("response"), created: this.now() }) };
    const stream = streamMetadata(result, normalized);
    if (stream) response.stream = stream;
    return response;
  }
}
