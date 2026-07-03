function textFromContentBlocks(blocks = []) {
  return blocks.map((block) => (block?.type === "text" ? block.text : "")).filter(Boolean).join("");
}

function anthropicContentBlocks(blocks = []) {
  const content = [];
  const text = textFromContentBlocks(blocks);
  if (text) content.push({ type: "text", text });
  let index = 0;
  for (const block of blocks) {
    if (block?.type !== "tool_use" || !block.name) continue;
    content.push({
      type: "tool_use",
      id: String(block.id || `toolu_${index}`),
      name: String(block.name),
      input: block.input && typeof block.input === "object" && !Array.isArray(block.input) ? block.input : {},
    });
    index += 1;
  }
  return content.length ? content : [{ type: "text", text: "" }];
}

function anthropicStopReason(result = {}) {
  if (result.stopReason === "tool_use") return "tool_use";
  return result.stopReason || "end_turn";
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isAnthropicToolRoundTripBlock(block) {
  return block?.type === "tool_use"
    || block?.type === "tool_result"
    || block?.type === "server_tool_use"
    || block?.type === "server_tool_result";
}

function hasAnthropicToolRoundTripContent(content) {
  return Array.isArray(content) && content.some(isAnthropicToolRoundTripBlock);
}

function textFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => (item?.type === "text" ? item.text : "")).filter(Boolean).join("");
  }
  return String(content ?? "");
}

function cleanAnthropicMessage(message) {
  return {
    role: message?.role || "user",
    content: hasAnthropicToolRoundTripContent(message?.content)
      ? cloneJson(message.content)
      : textFromAnthropicContent(message?.content),
  };
}

function normalizeSystemMessages(system) {
  const text = textFromAnthropicContent(system).trim();
  return text ? [{ role: "system", content: text }] : [];
}

function isAutoToolChoice(value) {
  return value?.type === "auto";
}

function isNoopToolChoice(value) {
  return isAutoToolChoice(value) || value === "none" || value?.type === "none";
}

function normalizeToolOptions(body = {}, { stripClientTools = false } = {}) {
  const options = {};
  if (Array.isArray(body.tools)) {
    const tools = stripClientTools
      ? body.tools.filter((tool) => !["update_plan", "request_user_input", "view_image"].includes(tool?.name))
      : body.tools;
    if (tools.length > 0) {
      options.tools = tools;
      options.toolChoice = Object.hasOwn(body, "tool_choice") ? body.tool_choice : { type: "auto" };
    } else if (Object.hasOwn(body, "tool_choice") && !isNoopToolChoice(body.tool_choice)) {
      options.toolChoice = body.tool_choice;
    }
  } else if (Object.hasOwn(body, "tool_choice") && !isNoopToolChoice(body.tool_choice)) {
    options.toolChoice = body.tool_choice;
  }
  return options;
}

export function normalizeAnthropicMessagesRequest(body = {}, options = {}) {
  return {
    model: body.model || "tabbit/priority",
    messages: [
      ...normalizeSystemMessages(body.system),
      ...(Array.isArray(body.messages) ? body.messages.map(cleanAnthropicMessage).filter((message) => message.content) : []),
    ],
    stream: Boolean(body.stream),
    maxTokens: Number.isFinite(body.max_tokens) ? body.max_tokens : null,
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    requiresPremium: Boolean(body.requiresPremium || body.requires_premium),
    ...normalizeToolOptions(body, options),
  };
}

function routeMetadata(result = {}, created) {
  return {
    selected_model: result.selectedModel || "",
    account_id: result.accountId || "",
    attempted_accounts: (result.attemptedAccounts || []).join(","),
    fallback_happened: String(Boolean(result.fallbackHappened)),
    created_at: String(created),
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

export function buildAnthropicMessageResponse(normalized, result, { id, created }) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: normalized.model,
    content: anthropicContentBlocks(result.contentBlocks),
    stop_reason: anthropicStopReason(result),
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    metadata: routeMetadata(result, created),
  };
}

function anthropicError(message, type = "invalid_request_error", code = "invalid_request") {
  return { type: "error", error: { type, message }, metadata: { code } };
}

export function anthropicErrorForCategory(error = {}) {
  const category = error.category || "unknown";
  const code = error.code || category;
  const message = error.message || "Pooled request failed.";
  if (category === "invalid_request") return { status: 400, body: anthropicError(message, "invalid_request_error", code) };
  if (category === "login_required") return { status: 401, body: anthropicError(message, "authentication_error", code) };
  if (category === "timeout") return { status: 504, body: anthropicError(message, "api_error", code) };
  if (category === "no_available_account") return { status: 503, body: anthropicError(message, "api_error", code) };
  return { status: 502, body: anthropicError(message, "api_error", code) };
}

export class AnthropicCompat {
  constructor({ runner, now = () => Math.floor(Date.now() / 1000), idFactory = () => `msg_${Date.now()}`, stripClientTools = false } = {}) {
    if (!runner || typeof runner.run !== "function") throw new Error("runner with run() is required");
    this.runner = runner;
    this.now = now;
    this.idFactory = idFactory;
    this.stripClientTools = Boolean(stripClientTools);
  }

  async handleMessages(body = {}) {
    const normalized = normalizeAnthropicMessagesRequest(body, { stripClientTools: this.stripClientTools });
    if (!normalized.messages.length && !normalized.attachments.length) {
      return { status: 400, body: anthropicError("No conversation messages or attachments were provided.") };
    }
    const result = await this.runner.run(normalized);
    if (!result.ok) return anthropicErrorForCategory(result.error);
    const response = { status: 200, body: buildAnthropicMessageResponse(normalized, result, { id: this.idFactory("message"), created: this.now() }) };
    const stream = streamMetadata(result, normalized);
    if (stream) response.stream = stream;
    return response;
  }
}
