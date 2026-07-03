import http from "node:http";

const DEFAULT_API_KEY = "sk-tabbit-local";

class InvalidJsonError extends Error {
  constructor(message = "Request body must be valid JSON.") {
    super(message);
    this.name = "InvalidJsonError";
    this.code = "INVALID_JSON";
  }
}

export function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function sseData(payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}\n\n`;
}

function sseEvent(event, payload) {
  return `event: ${event}\n${sseData(payload)}`;
}

export function writeSse(res, events) {
  const text = events.join("");
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function streamErrorShape(error = {}) {
  return {
    message: error.message || "Stream failed.",
    type: "api_error",
    code: error.code || error.category || "stream_error",
  };
}

function streamErrorEvents(error) {
  return [
    sseData({ error: streamErrorShape(error) }),
    sseData("[DONE]"),
  ];
}

function responsesStreamErrorEvents(body = {}, error = {}) {
  return [
    sseEvent("response.failed", {
      type: "response.failed",
      response: {
        ...body,
        status: "failed",
        error: streamErrorShape(error),
      },
    }),
    sseData("[DONE]"),
  ];
}

function anthropicStreamErrorEvents(error = {}) {
  const streamError = streamErrorShape(error);
  return [
    sseEvent("error", {
      type: "error",
      error: {
        type: streamError.type,
        message: streamError.message,
      },
      metadata: { code: streamError.code },
    }),
  ];
}

async function* abortableAsyncIterable(iterable, signal) {
  const iterator = iterable?.[Symbol.asyncIterator]?.();
  if (!iterator) return;
  let removeAbortListener = () => {};
  let returned = false;
  const requestIteratorReturn = () => {
    if (!returned) {
      returned = true;
      try {
        const result = iterator.return?.();
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // Ignore cancellation cleanup failures after the downstream client is gone.
      }
    }
  };
  const abortPromise = signal
    ? new Promise((resolve) => {
      const onAbort = () => resolve({ aborted: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    })
    : null;

  try {
    for (;;) {
      const nextPromise = Promise.resolve(iterator.next()).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const result = abortPromise ? await Promise.race([nextPromise, abortPromise]) : await nextPromise;
      if (result?.aborted) {
        requestIteratorReturn();
        return;
      }
      if (result.error) throw result.error;
      if (result.value?.done) return;
      yield result.value.value;
    }
  } finally {
    removeAbortListener();
    if (signal?.aborted) requestIteratorReturn();
  }
}

export async function writeSseStream(res, events, { errorEvents = streamErrorEvents } = {}) {
  const closeController = new AbortController();
  let completed = false;
  const onClose = () => {
    if (!completed) closeController.abort();
  };
  res.on("close", onClose);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const eventSource = typeof events === "function" ? events(closeController.signal) : events;
  const iterator = eventSource[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (closeController.signal.aborted) break;
      res.write(next.value);
    }
  } catch (error) {
    if (!closeController.signal.aborted && !res.destroyed) {
      for (const event of errorEvents(error)) {
        res.write(event);
      }
    }
  }
  completed = true;
  res.off("close", onClose);
  if (closeController.signal.aborted) await iterator.return?.();
  if (!res.writableEnded && !res.destroyed) res.end();
}

function isSuccessStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function isAsyncIterable(value) {
  return value && typeof value[Symbol.asyncIterator] === "function";
}

function streamTextDeltas(stream = {}) {
  return Array.isArray(stream?.deltas)
    ? stream.deltas.filter((delta) => typeof delta === "string" && delta.length > 0)
    : [];
}

function responseTextItem(body = {}, text = "", status = "completed") {
  const existing = Array.isArray(body.output) ? body.output.find((item) => item?.type === "message") : null;
  return {
    id: existing?.id || `msg_${body.id}`,
    type: "message",
    status,
    role: existing?.role || "assistant",
    content: text ? [{ type: "output_text", text }] : [],
  };
}

function responseTextStartEvents(body = {}) {
  const item = responseTextItem(body, "", "in_progress");
  return [
    sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      response_id: body.id,
      output_index: 0,
      item,
    }),
    sseEvent("response.content_part.added", {
      type: "response.content_part.added",
      response_id: body.id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "" },
    }),
  ];
}

function responseTextDoneEvents(body = {}, text = "") {
  const item = responseTextItem(body, text, "completed");
  return [
    sseEvent("response.output_text.done", {
      type: "response.output_text.done",
      response_id: body.id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    }),
    sseEvent("response.content_part.done", {
      type: "response.content_part.done",
      response_id: body.id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text },
    }),
    sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      response_id: body.id,
      output_index: 0,
      item,
    }),
  ];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function normalizeToolCallStreamDelta(value) {
  if (!value || typeof value !== "object" || value.type !== "tool_call_delta") return null;
  const index = Number.isInteger(value.index) ? value.index : 0;
  const argumentsDelta = firstDefined(
    value.argumentsDelta,
    value.arguments_delta,
    value.inputJsonDelta,
    value.input_json_delta,
    value.partialJson,
    value.partial_json,
    value.arguments,
  );
  const delta = { index };
  if (value.id) delta.id = String(value.id);
  if (value.name) delta.name = String(value.name);
  if (argumentsDelta !== undefined && argumentsDelta !== null) delta.argumentsDelta = String(argumentsDelta);
  return delta.id || delta.name || Object.hasOwn(delta, "argumentsDelta") ? delta : null;
}

function chatToolCallStreamDelta(value) {
  const delta = normalizeToolCallStreamDelta(value);
  if (!delta) return null;
  const functionDelta = {};
  if (delta.name) functionDelta.name = delta.name;
  if (Object.hasOwn(delta, "argumentsDelta")) functionDelta.arguments = delta.argumentsDelta;
  const toolCall = {
    index: delta.index,
    ...(delta.id ? { id: delta.id } : {}),
    type: "function",
    function: functionDelta,
  };
  return toolCall;
}

function chatToolCallDeltas(choice = {}) {
  const toolCalls = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [];
  return toolCalls.map((toolCall, index) => ({
    index,
    id: toolCall.id,
    type: toolCall.type || "function",
    function: {
      name: toolCall.function?.name || toolCall.name || "",
      arguments: toolCall.function?.arguments || toolCall.arguments || "",
    },
  }));
}

export function chatCompletionToSseEvents(body = {}, stream = {}) {
  const choice = body.choices?.[0] || {};
  const text = choice.message?.content || "";
  const textDeltas = streamTextDeltas(stream);
  const contentDeltas = textDeltas.length ? textDeltas : (text ? [text] : []);
  const toolCallDeltas = chatToolCallDeltas(choice);
  const base = {
    id: body.id,
    object: "chat.completion.chunk",
    created: body.created,
    model: body.model,
  };

  return [
    sseData({
      ...base,
      choices: [{ index: choice.index ?? 0, delta: { role: "assistant" }, finish_reason: null }],
    }),
    ...contentDeltas.map((delta) => sseData({
      ...base,
      choices: [{ index: choice.index ?? 0, delta: { content: delta }, finish_reason: null }],
    })),
    ...toolCallDeltas.map((toolCall) => sseData({
      ...base,
      choices: [{ index: choice.index ?? 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
    })),
    sseData({
      ...base,
      choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
    }),
    sseData("[DONE]"),
  ].filter(Boolean);
}

async function* chatCompletionToStreamingSseEvents(body = {}, stream = {}, { signal = null } = {}) {
  const choice = body.choices?.[0] || {};
  const base = {
    id: body.id,
    object: "chat.completion.chunk",
    created: body.created,
    model: body.model,
  };
  yield sseData({
    ...base,
    choices: [{ index: choice.index ?? 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  let sawToolCalls = false;
  for await (const delta of abortableAsyncIterable(stream.deltas, signal)) {
    if (typeof delta === "string" && delta.length > 0) {
      yield sseData({
        ...base,
        choices: [{ index: choice.index ?? 0, delta: { content: delta }, finish_reason: null }],
      });
      continue;
    }
    const toolCall = chatToolCallStreamDelta(delta);
    if (toolCall) {
      sawToolCalls = true;
      yield sseData({
        ...base,
        choices: [{ index: choice.index ?? 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
      });
    }
  }
  const finishReason = sawToolCalls ? "tool_calls" : choice.finish_reason || "stop";
  yield sseData({
    ...base,
    choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: finishReason }],
  });
  yield sseData("[DONE]");
}

export function responsesToSseEvents(body = {}, stream = {}) {
  const textDeltas = streamTextDeltas(stream);
  const contentDeltas = textDeltas.length ? textDeltas : (body.output_text ? [body.output_text] : []);
  const text = contentDeltas.join("");
  return [
    sseEvent("response.created", {
      type: "response.created",
      response: {
        id: body.id,
        object: body.object,
        created_at: body.created_at,
        model: body.model,
      },
    }),
    ...(contentDeltas.length ? responseTextStartEvents(body) : []),
    ...contentDeltas.map((delta) => sseEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: body.id,
      item_id: responseTextItem(body).id,
      output_index: 0,
      content_index: 0,
      delta,
    })),
    ...(contentDeltas.length ? responseTextDoneEvents(body, text) : []),
    ...responsesFunctionCallEvents(body),
    sseEvent("response.completed", {
      type: "response.completed",
      response: body,
    }),
    sseData("[DONE]"),
  ].filter(Boolean);
}

function responsesFunctionCallEvents(body = {}) {
  const output = Array.isArray(body.output) ? body.output : [];
  return output.flatMap((item, outputIndex) => {
    if (item?.type !== "function_call") return [];
    const argumentsText = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
    const startedItem = {
      ...item,
      arguments: "",
      status: item.status === "completed" ? "in_progress" : item.status,
    };
    const events = [
      sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        response_id: body.id,
        output_index: outputIndex,
        item: startedItem,
      }),
    ];
    if (argumentsText) {
      events.push(sseEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        response_id: body.id,
        item_id: item.id,
        output_index: outputIndex,
        delta: argumentsText,
      }));
    }
    events.push(sseEvent("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: body.id,
      item_id: item.id,
      output_index: outputIndex,
      arguments: argumentsText,
    }));
    events.push(sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      response_id: body.id,
      output_index: outputIndex,
      item,
    }));
    return events;
  });
}

async function* responsesToStreamingSseEvents(body = {}, stream = {}, { signal = null } = {}) {
  const toolCalls = new Map();
  let textStarted = false;
  let text = "";
  const ensureToolCall = (delta) => {
    const current = toolCalls.get(delta.index);
    if (current) {
      if (delta.id && current.call_id.startsWith("call_")) current.call_id = delta.id;
      if (delta.name && !current.name) current.name = delta.name;
      return current;
    }
    const callId = delta.id || `call_${delta.index}`;
    const state = {
      index: delta.index,
      output_index: toolCalls.size,
      id: `fc_${callId}`,
      call_id: callId,
      name: delta.name || "",
      arguments: "",
    };
    toolCalls.set(delta.index, state);
    return state;
  };

  yield sseEvent("response.created", {
    type: "response.created",
    response: {
      id: body.id,
      object: body.object,
      created_at: body.created_at,
      model: body.model,
    },
  });
  for await (const delta of abortableAsyncIterable(stream.deltas, signal)) {
    if (typeof delta === "string" && delta.length > 0) {
      if (!textStarted) {
        textStarted = true;
        for (const event of responseTextStartEvents(body)) yield event;
      }
      text += delta;
      yield sseEvent("response.output_text.delta", {
        type: "response.output_text.delta",
        response_id: body.id,
        item_id: responseTextItem(body).id,
        output_index: 0,
        content_index: 0,
        delta,
      });
    }
    const toolDelta = normalizeToolCallStreamDelta(delta);
    if (toolDelta) {
      const existing = toolCalls.get(toolDelta.index);
      const toolCall = ensureToolCall(toolDelta);
      if (!existing) {
        yield sseEvent("response.output_item.added", {
          type: "response.output_item.added",
          response_id: body.id,
          output_index: toolCall.output_index,
          item: {
            id: toolCall.id,
            type: "function_call",
            call_id: toolCall.call_id,
            name: toolCall.name,
            arguments: "",
            status: "in_progress",
          },
        });
      }
      if (Object.hasOwn(toolDelta, "argumentsDelta")) {
        toolCall.arguments += toolDelta.argumentsDelta;
        yield sseEvent("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          response_id: body.id,
          item_id: toolCall.id,
          output_index: toolCall.output_index,
          delta: toolDelta.argumentsDelta,
        });
      }
    }
  }
  if (textStarted) {
    for (const event of responseTextDoneEvents(body, text)) yield event;
  }
  for (const toolCall of [...toolCalls.values()].sort((left, right) => left.output_index - right.output_index)) {
    const item = {
      id: toolCall.id,
      type: "function_call",
      call_id: toolCall.call_id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      status: "completed",
    };
    yield sseEvent("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      response_id: body.id,
      item_id: toolCall.id,
      output_index: toolCall.output_index,
      arguments: toolCall.arguments,
    });
    yield sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      response_id: body.id,
      output_index: toolCall.output_index,
      item,
    });
  }
  for (const event of responsesFunctionCallEvents(body)) {
    yield event;
  }
  yield sseEvent("response.completed", {
    type: "response.completed",
    response: body,
  });
  yield sseData("[DONE]");
}

function anthropicContentBlockStartShape(block = {}) {
  if (block.type === "text") return { type: "text", text: "" };
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    return { type: block.type, id: block.id, name: block.name, input: {} };
  }
  return block;
}

function anthropicContentBlockDelta(block = {}) {
  if (block.type === "text" && block.text) {
    return { type: "text_delta", text: block.text };
  }
  if ((block.type === "tool_use" || block.type === "server_tool_use") && block.input) {
    return { type: "input_json_delta", partial_json: JSON.stringify(block.input) };
  }
  return null;
}

export function anthropicMessageToSseEvents(body = {}, stream = {}) {
  const streamDeltas = streamTextDeltas(stream);
  const content = Array.isArray(body.content) && body.content.length
    ? body.content
    : (streamDeltas.length ? [{ type: "text", text: streamDeltas.join("") }] : []);
  const streamTextBlockIndex = streamDeltas.length ? content.findIndex((block) => block?.type === "text") : -1;
  const events = [
    sseEvent("message_start", {
      type: "message_start",
      message: { ...body, content: [] },
    }),
  ];

  content.forEach((block, index) => {
    events.push(sseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: anthropicContentBlockStartShape(block),
    }));

    const deltas = index === streamTextBlockIndex
      ? streamDeltas.map((text) => ({ type: "text_delta", text }))
      : [anthropicContentBlockDelta(block)].filter(Boolean);
    for (const delta of deltas) {
      if (delta) {
        events.push(sseEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta,
        }));
      }
    }

    events.push(sseEvent("content_block_stop", {
      type: "content_block_stop",
      index,
    }));
  });

  events.push(sseEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: body.stop_reason || "end_turn",
      stop_sequence: body.stop_sequence ?? null,
    },
    usage: body.usage || { input_tokens: 0, output_tokens: 0 },
  }));

  events.push(sseEvent("message_stop", { type: "message_stop" }));
  return events;
}

async function* anthropicMessageToStreamingSseEvents(body = {}, stream = {}, { signal = null } = {}) {
  yield sseEvent("message_start", {
    type: "message_start",
    message: { ...body, content: [] },
  });

  let nextBlockIndex = 0;
  let textBlockIndex = null;
  let textBlockOpen = false;
  let sawToolUse = false;
  const toolBlocks = new Map();

  const stopTextBlock = function* stopTextBlock() {
    if (!textBlockOpen) return;
    yield sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: textBlockIndex,
    });
    textBlockOpen = false;
  };

  const startTextBlock = function* startTextBlock() {
    if (textBlockOpen) return;
    if (textBlockIndex === null) {
      textBlockIndex = nextBlockIndex;
      nextBlockIndex += 1;
    }
    yield sseEvent("content_block_start", {
      type: "content_block_start",
      index: textBlockIndex,
      content_block: { type: "text", text: "" },
    });
    textBlockOpen = true;
  };

  const ensureToolBlock = function* ensureToolBlock(delta) {
    const existing = toolBlocks.get(delta.index);
    if (existing) {
      if (delta.id && existing.id.startsWith("toolu_")) existing.id = delta.id;
      if (delta.name && !existing.name) existing.name = delta.name;
      return existing;
    }
    for (const event of stopTextBlock()) yield event;
    const toolBlock = {
      blockIndex: nextBlockIndex,
      id: delta.id || `toolu_${delta.index}`,
      name: delta.name || "",
      stopped: false,
    };
    nextBlockIndex += 1;
    toolBlocks.set(delta.index, toolBlock);
    sawToolUse = true;
    yield sseEvent("content_block_start", {
      type: "content_block_start",
      index: toolBlock.blockIndex,
      content_block: {
        type: "tool_use",
        id: toolBlock.id,
        name: toolBlock.name,
        input: {},
      },
    });
    return toolBlock;
  };

  for await (const delta of abortableAsyncIterable(stream.deltas, signal)) {
    if (typeof delta === "string" && delta.length > 0) {
      for (const event of startTextBlock()) yield event;
      yield sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: textBlockIndex,
        delta: { type: "text_delta", text: delta },
      });
      continue;
    }
    const toolDelta = normalizeToolCallStreamDelta(delta);
    if (toolDelta) {
      let toolBlock = toolBlocks.get(toolDelta.index);
      if (!toolBlock) {
        const ensureIterator = ensureToolBlock(toolDelta);
        for (;;) {
          const next = ensureIterator.next();
          if (next.done) {
            toolBlock = next.value;
            break;
          }
          yield next.value;
        }
      } else {
        if (toolDelta.id && toolBlock.id.startsWith("toolu_")) toolBlock.id = toolDelta.id;
        if (toolDelta.name && !toolBlock.name) toolBlock.name = toolDelta.name;
      }
      if (Object.hasOwn(toolDelta, "argumentsDelta")) {
        yield sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: toolBlock.blockIndex,
          delta: { type: "input_json_delta", partial_json: toolDelta.argumentsDelta },
        });
      }
    }
  }
  for (const event of stopTextBlock()) yield event;
  for (const toolBlock of [...toolBlocks.values()].sort((left, right) => left.blockIndex - right.blockIndex)) {
    if (!toolBlock.stopped) {
      yield sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: toolBlock.blockIndex,
      });
      toolBlock.stopped = true;
    }
  }
  yield sseEvent("message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: sawToolUse ? "tool_use" : body.stop_reason || "end_turn",
      stop_sequence: body.stop_sequence ?? null,
    },
    usage: body.usage || { input_tokens: 0, output_tokens: 0 },
  });
  yield sseEvent("message_stop", { type: "message_stop" });
}

async function readRequestText(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}

export async function readJson(req) {
  const text = await readRequestText(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
}

export function openAiHttpError(status, message, type = "invalid_request_error", code = "invalid_request") {
  return { status, body: { error: { message, type, code } } };
}

export function isAuthorized(req, apiKey = DEFAULT_API_KEY) {
  const expected = String(apiKey || DEFAULT_API_KEY);
  const authorization = req.headers.authorization || "";
  if (authorization === `Bearer ${expected}`) return true;
  if (req.headers["x-api-key"] === expected) return true;
  return false;
}

function writeError(res, error) {
  writeJson(res, error.status, error.body);
}

function toOpenAiModel(model = {}) {
  return {
    id: model.id || "tabbit/priority",
    object: "model",
    owned_by: "tabbit",
    tabbit_selected_model: model.selectedModel ?? model.tabbit_selected_model ?? null,
    supports_tools: Boolean(model.supports_tools),
    supports_images: Boolean(model.supports_images),
    model_access_type: String(model.model_access_type || "unknown"),
  };
}

async function listModels(modelsProvider) {
  if (!modelsProvider) return [toOpenAiModel({ id: "tabbit/priority", model_access_type: "priority" })];
  if (typeof modelsProvider === "function") return await modelsProvider();
  if (typeof modelsProvider.listModels === "function") return await modelsProvider.listModels();
  return [];
}

function requireCompatHandler(compat, handlerName) {
  const handler = compat?.[handlerName];
  if (typeof handler !== "function") {
    throw new Error(`compat.${handlerName} is required`);
  }
  return handler.bind(compat);
}

async function resolveHealth(health) {
  if (typeof health === "function") return await health();
  return health || {};
}

async function handleCompatJsonRoute(req, res, compat, handlerName, { streamKind = null } = {}) {
  const body = await readJson(req);
  const result = await requireCompatHandler(compat, handlerName)(body);
  if (body?.stream === true && isSuccessStatus(result.status)) {
    if (streamKind === "chat" && isAsyncIterable(result.stream?.deltas)) {
      await writeSseStream(res, (signal) => chatCompletionToStreamingSseEvents(result.body, result.stream, { signal }));
      return;
    }
    if (streamKind === "responses" && isAsyncIterable(result.stream?.deltas)) {
      await writeSseStream(res, (signal) => responsesToStreamingSseEvents(result.body, result.stream, { signal }), {
        errorEvents: (error) => responsesStreamErrorEvents(result.body, error),
      });
      return;
    }
    if (streamKind === "anthropic" && isAsyncIterable(result.stream?.deltas)) {
      await writeSseStream(res, (signal) => anthropicMessageToStreamingSseEvents(result.body, result.stream, { signal }), {
        errorEvents: anthropicStreamErrorEvents,
      });
      return;
    }
    if (streamKind === "chat") {
      writeSse(res, chatCompletionToSseEvents(result.body, result.stream));
      return;
    }
    if (streamKind === "responses") {
      writeSse(res, responsesToSseEvents(result.body, result.stream));
      return;
    }
    if (streamKind === "anthropic") {
      writeSse(res, anthropicMessageToSseEvents(result.body, result.stream));
      return;
    }
  }
  writeJson(res, result.status, result.body);
}

export function createProtocolPoolServer({ apiKey = DEFAULT_API_KEY, compat, modelsProvider = null, health = null } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, { status: "ok", mode: "protocol-pool", ...(await resolveHealth(health)) });
        return;
      }

      if (url.pathname.startsWith("/v1/") && !isAuthorized(req, apiKey)) {
        writeError(res, openAiHttpError(401, "Missing or invalid API key.", "authentication_error", "invalid_api_key"));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const models = await listModels(modelsProvider);
        writeJson(res, 200, { object: "list", data: models.map((model) => toOpenAiModel(model)) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleCompatJsonRoute(req, res, compat, "handleChatCompletions", { streamKind: "chat" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses") {
        await handleCompatJsonRoute(req, res, compat, "handleResponses", { streamKind: "responses" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleCompatJsonRoute(req, res, compat, "handleMessages", { streamKind: "anthropic" });
        return;
      }

      writeError(res, openAiHttpError(404, "Route not found.", "invalid_request_error", "not_found"));
    } catch (error) {
      if (res.writableEnded) return;
      if (error?.code === "INVALID_JSON") {
        writeError(res, openAiHttpError(400, "Request body must be valid JSON.", "invalid_request_error", "invalid_json"));
        return;
      }
      writeError(res, openAiHttpError(500, "Internal server error.", "api_error", "internal_error"));
    }
  });
}
