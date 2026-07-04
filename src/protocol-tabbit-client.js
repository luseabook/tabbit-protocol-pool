import { Buffer } from "node:buffer";
import { createHash, createHmac, randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://web.tabbit.ai";
const DEFAULT_SIGN_KEY_PATH = "/chat/sign-key";
const DEFAULT_MODEL_CATALOG_PATH = "/proxy/v1/model_config/models";
const DEFAULT_MODEL_CATALOG_SCENE = "chat";
const DEFAULT_REQ_CTX = "MS4zLjI2KDEwMTAzMDI2KQ==";
const EMPTY_TAB_ENTITY_KEY = "d41d8cd98f00b204e9800998ecf8427e";
const NEWBIE_EXPLORATION_VIEW_MODES = new Set(["event_gate", "float_collapsed", "float_expanded", "activity_page"]);
const DEFAULT_DAILY_SIGN_IN_SCENE = "desktop_pet";
const WEEKLY_RESET_COUPON_TYPE = "weekly_reset_coupon";
const AUTH_CLIENT_UUID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export class ProtocolTabbitError extends Error {
  constructor(message, { category = "unknown", status = null, code = null, retryable = false, cooldownMs = 0, detail = null } = {}) {
    super(message);
    this.name = "ProtocolTabbitError";
    this.category = category;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.cooldownMs = cooldownMs;
    this.detail = detail;
  }
}

function trimTrailingSlash(value) { return String(value || "").replace(/\/+$/, ""); }
function normalizePath(path) { const clean = String(path || "/"); return clean.startsWith("/") ? clean : `/${clean}`; }
function isPlainObject(value) { return value && typeof value === "object" && !Array.isArray(value); }

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeQuery(query) {
  const params = new URLSearchParams();
  if (query instanceof URLSearchParams) {
    for (const [key, value] of query.entries()) params.append(key, value);
  } else if (query && typeof query === "object") {
    for (const key of Object.keys(query).sort()) {
      const value = query[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
      else params.append(key, String(value));
    }
  }
  return [...params.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

export function buildSignaturePayload({ method, path, query, body, timestamp, nonce }) {
  const queryString = normalizeQuery(query);
  const pathWithQuery = `${normalizePath(path)}${queryString ? `?${queryString}` : ""}`;
  const bodyText = body === undefined || body === null ? "" : canonicalJson(body);
  return [String(method || "GET").toUpperCase(), pathWithQuery, String(timestamp), String(nonce), bodyText].join("\n");
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function sha256Evidence(value) {
  return `sha256:${sha256Hex(typeof value === "string" ? value : canonicalJson(value))}`;
}

function buildBrowserSignaturePayload({ bodyText = "", timestamp, signature }) {
  return `${String(timestamp)}.${String(signature)}.${sha256Hex(bodyText)}`;
}

export function createSignedHeaders({ method, path, query, body, bodyText = null, signKey, timestamp = Date.now(), nonce = randomUUID(), signature = null }) {
  if (bodyText !== null || signature !== null) {
    const requestSignature = String(signature || nonce || randomUUID());
    const finalBodyText = bodyText !== null && bodyText !== undefined
      ? String(bodyText)
      : (body === undefined || body === null ? "" : JSON.stringify(body));
    const payload = buildBrowserSignaturePayload({ bodyText: finalBodyText, timestamp, signature: requestSignature });
    return {
      "x-timestamp": String(timestamp),
      "x-nonce": createHmac("sha256", String(signKey)).update(payload).digest("hex"),
      "x-signature": requestSignature,
    };
  }
  const payload = buildSignaturePayload({ method, path, query, body, timestamp, nonce });
  return {
    "x-timestamp": String(timestamp),
    "x-nonce": String(nonce),
    "x-signature": createHmac("sha256", String(signKey)).update(payload).digest("hex"),
  };
}

function parseRetryAfter(headers) {
  const value = headers?.get?.("Retry-After") || headers?.get?.("retry-after") || null;
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : 0;
}

async function parseBody(response) {
  const contentType = response.headers?.get?.("content-type") || "";
  if (contentType.includes("text/event-stream")) return parseStreamBody(await response.text(), "sse");
  if (contentType.includes("x-ndjson") || contentType.includes("jsonl") || contentType.includes("stream+json")) return parseStreamBody(await response.text(), "ndjson");
  if (contentType.includes("json")) { try { return await response.json(); } catch { return {}; } }
  const text = await response.text();
  if (!text) return "";
  try { return JSON.parse(text); } catch { return text; }
}

function extractSignKey(body) {
  if (typeof body === "string") return body.trim();
  return String(body?.key || body?.signKey || body?.data?.key || body?.data?.signKey || "").trim();
}

function extractModelArray(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.models)) return body.models;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.items)) return body.items;
  return [];
}
function firstDefined(...values) { return values.find((value) => value !== undefined && value !== null && value !== ""); }
function normalizeBoolean(value) { if (typeof value === "boolean") return value; if (typeof value === "string") return /^(true|yes|1)$/i.test(value); return Boolean(value); }
function normalizeModelId(value) { return String(value || "").replace(/^tabbit\//, "").trim(); }
function selectedModelForRequest(model) {
  const normalized = normalizeModelId(model);
  return !normalized || normalized === "priority" ? "Default" : normalized;
}

export function createUniqueUuid({ now = () => Date.now(), random = Math.random, isDefaultBrowser = false } = {}) {
  const timestampPositions = [2, 7, 11, 14, 18, 21, 25, 28];
  const markerPos = 5;
  const defaultBrowserMarker = "1";
  const hex = "0123456789abcdef";
  const nonDefaultHex = hex.replace(defaultBrowserMarker, "");
  const nowMs = typeof now === "function" ? now() : now;
  const timestamp = Math.floor(Number(nowMs || Date.now()) / 1000).toString(16).padStart(timestampPositions.length, "0").slice(-timestampPositions.length);
  const timestampMap = new Map(timestampPositions.map((position, index) => [position, timestamp[index]]));
  let raw = "";
  for (let index = 0; index < 32; index += 1) {
    if (index === markerPos) {
      raw += isDefaultBrowser ? defaultBrowserMarker : nonDefaultHex[Math.floor(random() * nonDefaultHex.length)];
    } else if (timestampMap.has(index)) {
      raw += timestampMap.get(index);
    } else {
      raw += hex[Math.floor(random() * hex.length)];
    }
  }
  return [raw.slice(0, 8), raw.slice(8, 12), raw.slice(12, 16), raw.slice(16, 20), raw.slice(20, 32)].join("-");
}

function createAuthClientUuid({ random = Math.random } = {}) {
  let value = "";
  for (let index = 0; index < 64; index += 1) {
    value += AUTH_CLIENT_UUID_ALPHABET[Math.floor(random() * AUTH_CLIENT_UUID_ALPHABET.length)];
  }
  return value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlContentFromText(value) {
  return `<p>${escapeHtml(value).replace(/\r?\n/g, "<br>")}</p>`;
}

function stringifyUnknownContent(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (!isPlainObject(item)) return JSON.stringify(item);
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      if (typeof item.input_text === "string") return item.input_text;
      if (Array.isArray(item.content)) return stringifyUnknownContent(item.content);
      return JSON.stringify(item);
    }).filter(Boolean).join("\n");
  }
  if (isPlainObject(value)) {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (typeof value.output === "string") return value.output;
  }
  return JSON.stringify(value);
}

function promptFromMessages(messages = []) {
  const normalized = Array.isArray(messages) ? messages : [];
  if (normalized.length === 1) return stringifyUnknownContent(normalized[0]?.content ?? normalized[0]?.output ?? normalized[0]);
  return normalized.map((message) => {
    if (!message || typeof message !== "object") return stringifyUnknownContent(message);
    const role = message.role || message.type || "message";
    const content = stringifyUnknownContent(firstDefined(message.content, message.output, message.tool_calls, message.function_call, message));
    return content ? `${role}: ${content}` : "";
  }).filter(Boolean).join("\n\n");
}

function chatSessionIdFromInput({ chatSessionId, account = {}, defaultChatSessionId = null }) {
  return firstDefined(
    chatSessionId,
    account.chatSessionId,
    account.chat_session_id,
    account.defaultChatSessionId,
    defaultChatSessionId,
  );
}

function buildRealChatCompletionBody({ account, defaultChatSessionId, chatSessionId, model, messages, content = null, references = [], metadatas = null, entity = null, messageId = null, parallelGroupId = null, taskName = "chat", agentMode = false } = {}) {
  const finalChatSessionId = chatSessionIdFromInput({ chatSessionId, account, defaultChatSessionId });
  if (!finalChatSessionId) {
    throw new ProtocolTabbitError("Tabbit chat_session_id is required for the restored chat completion protocol.", {
      category: "invalid_request",
      code: "MISSING_CHAT_SESSION_ID",
      retryable: false,
    });
  }
  const prompt = String(firstDefined(content, promptFromMessages(messages), "") || "");
  const finalMetadatas = isPlainObject(metadatas) ? { ...metadatas } : {};
  if (!Object.hasOwn(finalMetadatas, "html_content")) finalMetadatas.html_content = htmlContentFromText(prompt);
  return {
    chat_session_id: String(finalChatSessionId),
    message_id: messageId,
    content: prompt,
    selected_model: selectedModelForRequest(model),
    parallel_group_id: parallelGroupId,
    task_name: String(taskName || "chat"),
    agent_mode: Boolean(agentMode),
    metadatas: finalMetadatas,
    references: Array.isArray(references) ? references : [],
    entity: entity || {
      key: EMPTY_TAB_ENTITY_KEY,
      extras: { type: "tab", url: "" },
    },
  };
}

function usesRestoredChatCompletionProtocol(path) {
  return normalizePath(path) === "/api/v1/chat/completion";
}

function usesProxyOauthProtocol(path) {
  return normalizePath(path).startsWith("/proxy/v0/oauth/");
}

function hasNativeToolFields({ tools = null, toolChoice = null, parallelToolCalls = null } = {}) {
  return (Array.isArray(tools) && tools.length > 0)
    || toolChoice !== null && toolChoice !== undefined
    || parallelToolCalls !== null && parallelToolCalls !== undefined;
}

function cleanString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function attachmentMetadata(attachment = {}) {
  return isPlainObject(attachment.metadata) ? attachment.metadata : {};
}

function attachmentFileId(attachment = {}) {
  const metadata = attachmentMetadata(attachment);
  return cleanString(firstDefined(
    attachment.path,
    attachment.file_id,
    attachment.fileId,
    metadata.file_id,
    metadata.fileId,
    attachment.id,
  ));
}

function isImageAttachment(attachment = {}) {
  const type = cleanString(attachment.type);
  if (type === "image" || type === "image-description") return true;
  const mimeType = cleanString(attachment.mimeType || attachment.content_type || attachment.contentType);
  if (mimeType?.toLowerCase().startsWith("image/")) return true;
  const name = cleanString(attachment.title || attachment.filename || attachment.name || attachment.path);
  return /\.(png|jpe?g|webp|gif)$/i.test(name || "");
}

function attachmentTitle(attachment = {}, fileId = "") {
  return String(firstDefined(attachment.title, attachment.filename, attachment.name, fileId, "attachment"));
}

function normalizeSingleAttachmentReference(attachment = {}) {
  const value = isPlainObject(attachment?.reference) ? attachment.reference : attachment;
  if (!isPlainObject(value)) return null;
  const fileId = attachmentFileId(value);
  if (!fileId) return null;
  const metadata = attachmentMetadata(value);
  if (isImageAttachment(value)) {
    const sourceUrl = cleanString(firstDefined(value.sourceUrl, value.source_url, metadata.source_url, metadata.sourceUrl));
    return {
      type: "image",
      title: attachmentTitle(value, fileId),
      content: String(firstDefined(value.content, metadata.signed_url, "")),
      metadata: {
        file_id: fileId,
        ...(sourceUrl ? { source_url: sourceUrl } : {}),
      },
    };
  }
  return {
    type: "document",
    title: attachmentTitle(value, fileId),
    content: "",
    metadata: { file_id: fileId },
  };
}

function normalizeAttachmentReferences(attachments = []) {
  const normalized = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const reference = normalizeSingleAttachmentReference(attachment);
    if (!reference) {
      return {
        ok: false,
        error: new ProtocolTabbitError("Attachments must be uploaded before sendMessage; provide path, file_id, fileId, id, or metadata.file_id.", {
          category: "unsupported_feature",
          code: "ATTACHMENT_REFERENCE_REQUIRED",
          retryable: false,
        }),
      };
    }
    normalized.push(reference);
  }
  return { ok: true, references: normalized };
}

function hasAttachmentPayload(attachment = {}) {
  if (!isPlainObject(attachment)) return false;
  return Object.hasOwn(attachment, "data")
    || Object.hasOwn(attachment, "base64")
    || Object.hasOwn(attachment, "raw")
    || Object.hasOwn(attachment, "body");
}

function attachmentUploadFilename(attachment = {}) {
  return String(firstDefined(
    attachment.filename,
    attachment.fileName,
    attachment.originalFilename,
    attachment.original_filename,
    attachment.name,
    attachment.title,
    "attachment",
  ));
}

function attachmentUploadMimeType(attachment = {}, fallback = null) {
  return String(firstDefined(
    attachment.mimeType,
    attachment.mime_type,
    attachment.contentType,
    attachment.content_type,
    fallback,
    "application/octet-stream",
  ));
}

function base64Decode(value) {
  const clean = String(value ?? "").replace(/\s+/g, "");
  if (!clean || clean.length % 4 === 1 || /[^A-Za-z0-9+/=_-]/.test(clean)) {
    throw new ProtocolTabbitError("Attachment data must be valid base64.", {
      category: "invalid_request",
      code: "INVALID_ATTACHMENT_DATA",
      retryable: false,
    });
  }
  return Buffer.from(clean.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+)?((?:;[^,]*)?),(.*)$/is.exec(String(value || ""));
  if (!match) return null;
  const mimeType = match[1] || null;
  const modifiers = match[2] || "";
  const payload = match[3] || "";
  return {
    mimeType,
    buffer: /;base64/i.test(modifiers)
      ? base64Decode(payload)
      : Buffer.from(decodeURIComponent(payload), "utf8"),
  };
}

function attachmentPayloadBuffer(attachment = {}) {
  if (Object.hasOwn(attachment, "base64")) return base64Decode(attachment.base64);
  const field = Object.hasOwn(attachment, "data")
    ? "data"
    : (Object.hasOwn(attachment, "raw") ? "raw" : (Object.hasOwn(attachment, "body") ? "body" : null));
  if (!field) {
    throw new ProtocolTabbitError("Attachment data is required for upload.", {
      category: "invalid_request",
      code: "MISSING_ATTACHMENT_DATA",
      retryable: false,
    });
  }
  const value = attachment[field];
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolTabbitError("Attachment data must be a non-empty string or byte array.", {
      category: "invalid_request",
      code: "INVALID_ATTACHMENT_DATA",
      retryable: false,
    });
  }
  const dataUrl = parseDataUrl(value);
  if (dataUrl) return dataUrl.buffer;
  const encoding = String(firstDefined(attachment.encoding, attachment.dataEncoding, attachment.contentEncoding, "")).toLowerCase();
  return encoding === "base64" || encoding === "base64url" ? base64Decode(value) : Buffer.from(value, "utf8");
}

function dataUrlMimeType(attachment = {}) {
  const value = Object.hasOwn(attachment, "data") && typeof attachment.data === "string" ? attachment.data : null;
  return parseDataUrl(value)?.mimeType || null;
}

function buildCosAttachmentUploadParts(attachment = {}) {
  if (!hasAttachmentPayload(attachment)) {
    throw new ProtocolTabbitError("Attachment data is required for upload.", {
      category: "invalid_request",
      code: "MISSING_ATTACHMENT_DATA",
      retryable: false,
    });
  }
  const payload = attachmentPayloadBuffer(attachment);
  const mimeType = attachmentUploadMimeType(attachment, dataUrlMimeType(attachment));
  const filename = attachmentUploadFilename(attachment);
  return {
    filename,
    mimeType,
    payload,
    presignBody: {
      file_category: isImageAttachment({ ...attachment, filename, mimeType }) ? "image" : "document",
      original_filename: filename,
      content_type: mimeType,
    },
  };
}

function normalizeCosPresignedUploadResponse(body) {
  const data = isPlainObject(body?.data) ? body.data : body;
  const uploadUrl = firstDefined(data?.url, data?.upload_url, data?.uploadUrl, data?.presignedUrl, data?.presigned_url);
  const fileId = firstDefined(data?.file_id, data?.fileId, data?.id);
  if (!uploadUrl || !fileId) {
    throw new ProtocolTabbitError("Tabbit presigned upload response did not contain upload url and file id.", {
      category: "protocol_changed",
      detail: body,
    });
  }
  return {
    uploadUrl: String(uploadUrl),
    fileId: String(fileId),
    downloadUrl: firstDefined(data?.download_url, data?.downloadUrl, data?.signed_url, data?.signedUrl) || null,
    raw: body,
  };
}

function normalizeCosAttachmentUploadResult({ presigned, completeBody, filename, mimeType, payload }) {
  return {
    ok: true,
    attachment: {
      id: presigned.fileId,
      name: filename,
      mimeType,
      size: payload.byteLength,
      ...(presigned.downloadUrl ? { url: String(presigned.downloadUrl) } : {}),
    },
    raw: {
      file_id: presigned.fileId,
      complete: completeBody,
    },
  };
}

function attachmentFromUploadResult(attachment = {}, uploadResult = {}) {
  const uploaded = uploadResult.attachment || {};
  const metadata = {
    ...attachmentMetadata(attachment),
    ...(uploaded.url ? { signed_url: uploaded.url } : {}),
  };
  return {
    ...attachment,
    id: uploaded.id,
    path: uploaded.id,
    file_id: uploaded.id,
    filename: uploaded.name || attachment.filename || attachment.name || attachment.title,
    mimeType: uploaded.mimeType || attachment.mimeType || attachment.contentType || attachment.content_type,
    ...(uploaded.url ? { content: uploaded.url } : {}),
    metadata,
  };
}

function streamFormatFromContentType(contentType = "") {
  if (contentType.includes("text/event-stream")) return "sse";
  if (contentType.includes("x-ndjson") || contentType.includes("jsonl") || contentType.includes("stream+json")) return "ndjson";
  return null;
}

function isReadableBody(value) {
  return value && (typeof value.getReader === "function" || typeof value[Symbol.asyncIterator] === "function");
}

async function* decodeBodyTextChunks(body) {
  const decoder = new TextDecoder();
  if (typeof body?.getReader === "function") {
    const reader = body.getReader();
    let completed = false;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          completed = true;
          break;
        }
        const text = decoder.decode(next.value, { stream: true });
        if (text) yield text;
      }
    } finally {
      if (!completed && typeof reader.cancel === "function") {
        await reader.cancel("stream_deltas_cancelled").catch(() => {});
      }
      reader.releaseLock?.();
    }
    const tail = decoder.decode();
    if (tail) yield tail;
    return;
  }

  for await (const chunk of body) {
    if (typeof chunk === "string") {
      yield chunk;
    } else {
      const text = decoder.decode(chunk, { stream: true });
      if (text) yield text;
    }
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

function parseDataLineValue(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed === "[DONE]") return { skip: true };
  try {
    return { data: JSON.parse(trimmed) };
  } catch {
    return { data: trimmed };
  }
}

function extractStreamText(value) {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return "";
  const candidate = firstDefined(
    value.delta?.text,
    value.delta,
    value.text,
    value.content,
    value.message?.content,
    value.data?.delta?.text,
    value.data?.delta,
    value.data?.text,
    value.data?.content,
    value.data?.message?.content,
    value.choices?.[0]?.delta?.content,
    value.choices?.[0]?.message?.content,
    "",
  );
  return typeof candidate === "string" ? candidate : "";
}

function normalizeStreamErrorBody(value) {
  if (typeof value === "string") return { message: value };
  if (!isPlainObject(value)) return null;
  const nested = isPlainObject(value.error) ? value.error : null;
  const message = firstDefined(
    nested?.message,
    nested?.error,
    value.message,
    typeof value.error === "string" ? value.error : null,
    value.data?.message,
    value.data?.error,
  );
  const code = firstDefined(
    nested?.code,
    nested?.errorCode,
    value.code,
    value.errorCode,
    value.data?.code,
    value.data?.errorCode,
  );
  if (!message && !code) return null;
  return { message: message || code, code, error: message || code, raw: value };
}

function streamErrorFromEvent(event) {
  const data = event?.data;
  const explicitErrorEvent = String(event?.event || "").toLowerCase() === "error";
  const objectSignalsError = isPlainObject(data) && (
    data.type === "error" ||
    data.event === "error" ||
    data.error !== undefined ||
    data.errorCode !== undefined ||
    (data.code !== undefined && data.message !== undefined)
  );
  if (!explicitErrorEvent && !objectSignalsError) return null;
  const body = normalizeStreamErrorBody(data) || { message: "Tabbit stream returned an error frame.", raw: data };
  const classified = classifyProtocolError({ status: null, body });
  return new ProtocolTabbitError(classified.message, classified);
}

function findStreamError(events = []) {
  for (const event of events) {
    const error = streamErrorFromEvent(event);
    if (error) return error;
  }
  return null;
}

function parseSseEvents(text) {
  return String(text || "")
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const lines = frame.split(/\r?\n/);
      const dataLines = [];
      let event = "message";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice("event:".length).trim() || event;
        if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
      }
      const parsed = parseDataLineValue(dataLines.join("\n"));
      if (parsed.skip) return null;
      return { event, data: parsed.data };
    })
    .filter(Boolean);
}

function parseNdjsonEvents(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => parseDataLineValue(line))
    .filter((parsed) => !parsed.skip)
    .map((parsed) => ({ event: "message", data: parsed.data }));
}

function parseStreamBody(text, format) {
  const events = format === "sse" ? parseSseEvents(text) : parseNdjsonEvents(text);
  return {
    kind: "stream",
    format,
    events,
    text: events.map((event) => extractStreamText(event.data)).filter(Boolean).join(""),
  };
}

function toolCallDeltaObjectsFromEventData(data) {
  const toolCalls = toolCallDeltasFromEventData(data);
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((toolCall, fallbackIndex) => {
    if (!isPlainObject(toolCall)) return null;
    const index = Number.isInteger(toolCall.index) ? toolCall.index : fallbackIndex;
    const functionCall = isPlainObject(toolCall.function) ? toolCall.function : toolCall;
    const id = firstDefined(toolCall.id, functionCall.id);
    const name = firstDefined(functionCall.name, toolCall.name);
    const args = firstDefined(functionCall.arguments, toolCall.arguments);
    const delta = { type: "tool_call_delta", index };
    if (id) delta.id = String(id);
    if (name) delta.name = String(name);
    if (args !== undefined && args !== null) delta.argumentsDelta = String(args);
    return delta.id || delta.name || Object.hasOwn(delta, "argumentsDelta") ? delta : null;
  }).filter(Boolean);
}

function anthropicToolCallDeltaObjectsFromEventData(data) {
  const { contentBlock, delta, index } = anthropicStreamToolUseDeltasFromEventData(data);
  const deltas = [];
  if (contentBlock?.type === "tool_use" && Number.isInteger(index)) {
    const toolDelta = { type: "tool_call_delta", index };
    if (contentBlock.id) toolDelta.id = String(contentBlock.id);
    if (contentBlock.name) toolDelta.name = String(contentBlock.name);
    deltas.push(toolDelta);
  }
  if (delta?.type === "input_json_delta" && Number.isInteger(index)) {
    deltas.push({
      type: "tool_call_delta",
      index,
      argumentsDelta: String(delta.partial_json || ""),
    });
  }
  return deltas;
}

function streamDeltasFromEvent(event) {
  const deltas = [];
  const text = extractStreamText(event.data);
  if (text) deltas.push(text);
  deltas.push(...toolCallDeltaObjectsFromEventData(event.data));
  deltas.push(...anthropicToolCallDeltaObjectsFromEventData(event.data));
  return deltas;
}

function appendStreamEvent(raw, event) {
  raw.events.push(event);
  const streamError = streamErrorFromEvent(event);
  if (streamError) throw streamError;
  return streamDeltasFromEvent(event);
}

async function* parseSseDeltaStream(body, raw) {
  let buffer = "";
  for await (const chunk of decodeBodyTextChunks(body)) {
    buffer += chunk;
    for (;;) {
      const separator = buffer.match(/\r?\n\r?\n/);
      if (!separator) break;
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      for (const event of parseSseEvents(frame)) {
        for (const delta of appendStreamEvent(raw, event)) {
          if (delta) yield delta;
        }
      }
    }
  }
  if (buffer.trim()) {
    for (const event of parseSseEvents(buffer)) {
      for (const delta of appendStreamEvent(raw, event)) {
        if (delta) yield delta;
      }
    }
  }
}

async function* parseNdjsonDeltaStream(body, raw) {
  let buffer = "";
  for await (const chunk of decodeBodyTextChunks(body)) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      for (const event of parseNdjsonEvents(line)) {
        for (const delta of appendStreamEvent(raw, event)) {
          if (delta) yield delta;
        }
      }
    }
  }
  if (buffer.trim()) {
    for (const event of parseNdjsonEvents(buffer)) {
      for (const delta of appendStreamEvent(raw, event)) {
        if (delta) yield delta;
      }
    }
  }
}

function normalizeAsyncMessageResponse(body, format, selectedModel, { upstreamEvidence = null } = {}) {
  const raw = { kind: "stream", format, async: true, events: [] };
  return {
    ok: true,
    contentBlocks: [{ type: "text", text: "" }],
    selectedModel,
    ...(upstreamEvidence ? { upstreamEvidence } : {}),
    raw,
    streamDeltas: format === "sse" ? parseSseDeltaStream(body, raw) : parseNdjsonDeltaStream(body, raw),
  };
}

export function normalizeModelCatalog(body) {
  const normalized = extractModelArray(body).map((item) => {
    const selectedModel = normalizeModelId(firstDefined(item.selectedModel, item.display_name, item.model, item.name, item.id, item.value));
    if (!selectedModel || selectedModel === "priority") return null;
    const displayName = String(firstDefined(item.displayName, item.display_name, item.title, item.label, item.name, item.model, selectedModel));
    return {
      id: `tabbit/${selectedModel}`, selectedModel, displayName, tabbit_display_name: displayName,
      supports_tools: normalizeBoolean(firstDefined(item.supports_tools, item.supportsTools, item.supportTool, false)),
      supports_images: normalizeBoolean(firstDefined(item.supports_images, item.supportsImages, item.supportImage, false)),
      model_access_type: String(firstDefined(item.model_access_type, item.modelAccessType, item.access, item.accessType, "unknown")),
      available_in_tabbit_catalog: true,
    };
  }).filter(Boolean);
  return [{
    id: "tabbit/priority", selectedModel: null, displayName: "priority", tabbit_display_name: "priority",
    supports_tools: normalized.some((model) => model.supports_tools),
    supports_images: normalized.some((model) => model.supports_images),
    model_access_type: "priority", available_in_tabbit_catalog: true,
  }, ...normalized];
}

function messageFromBody(body) {
  if (body?.kind === "stream") return body.text;
  if (typeof body === "string" && body.trim()) return body.trim();
  return firstDefined(
    body?.text,
    body?.content,
    body?.message?.content,
    body?.message?.text,
    body?.data?.text,
    body?.data?.content,
    body?.choices?.[0]?.message?.content,
  );
}

function parseToolInput(value) {
  if (isPlainObject(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeToolUseBlock(block, fallbackId) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "tool_use" && block.name) {
    return {
      type: "tool_use",
      id: String(block.id || fallbackId),
      name: String(block.name),
      input: parseToolInput(block.input),
    };
  }
  const functionCall = block.function || block;
  const name = functionCall?.name;
  if (!name) return null;
  return {
    type: "tool_use",
    id: String(block.id || functionCall.id || fallbackId),
    name: String(name),
    input: parseToolInput(firstDefined(functionCall.arguments, functionCall.input, block.arguments, block.input)),
  };
}

function contentBlocksFromAnthropicContent(content) {
  if (!Array.isArray(content)) return [];
  return content.map((block, index) => {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return { type: "text", text: block.text.trim() };
    }
    return normalizeToolUseBlock(block, `toolu_${index}`);
  }).filter(Boolean);
}

function contentBlocksFromToolCalls(body) {
  const toolCalls = firstDefined(
    body?.tool_calls,
    body?.message?.tool_calls,
    body?.data?.tool_calls,
    body?.choices?.[0]?.message?.tool_calls,
    body?.choices?.[0]?.delta?.tool_calls,
  );
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((toolCall, index) => normalizeToolUseBlock(toolCall, `call_${index}`)).filter(Boolean);
}

function toolCallDeltasFromEventData(data) {
  return firstDefined(
    data?.tool_calls,
    data?.delta?.tool_calls,
    data?.message?.tool_calls,
    data?.data?.tool_calls,
    data?.data?.delta?.tool_calls,
    data?.choices?.[0]?.delta?.tool_calls,
    data?.choices?.[0]?.message?.tool_calls,
  );
}

function contentBlocksFromStreamToolCalls(events = []) {
  const byIndex = new Map();
  for (const event of events) {
    const toolCalls = toolCallDeltasFromEventData(event?.data);
    if (!Array.isArray(toolCalls)) continue;
    toolCalls.forEach((toolCall, fallbackIndex) => {
      if (!isPlainObject(toolCall)) return;
      const index = Number.isInteger(toolCall.index) ? toolCall.index : fallbackIndex;
      const functionCall = isPlainObject(toolCall.function) ? toolCall.function : toolCall;
      const current = byIndex.get(index) || { arguments: "" };
      const id = firstDefined(toolCall.id, functionCall.id);
      const name = firstDefined(functionCall.name, toolCall.name);
      const type = firstDefined(toolCall.type, current.type, "function");
      const args = firstDefined(functionCall.arguments, toolCall.arguments);
      byIndex.set(index, {
        ...current,
        ...(id ? { id: String(id) } : {}),
        ...(name && !current.name ? { name: String(name) } : {}),
        type,
        arguments: current.arguments + (args === undefined || args === null ? "" : String(args)),
      });
    });
  }
  return [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, toolCall]) => normalizeToolUseBlock({
      id: toolCall.id,
      type: toolCall.type,
      function: {
        name: toolCall.name,
        arguments: toolCall.arguments,
      },
    }, `call_${index}`))
    .filter(Boolean);
}

function anthropicStreamToolUseDeltasFromEventData(data) {
  const contentBlock = data?.content_block || data?.data?.content_block;
  const delta = data?.delta || data?.data?.delta;
  const index = Number.isInteger(data?.index)
    ? data.index
    : (Number.isInteger(data?.data?.index) ? data.data.index : null);
  return { contentBlock, delta, index };
}

function contentBlocksFromAnthropicStreamToolUses(events = []) {
  const byIndex = new Map();
  for (const event of events) {
    const { contentBlock, delta, index } = anthropicStreamToolUseDeltasFromEventData(event?.data);
    if (contentBlock?.type === "tool_use" && Number.isInteger(index)) {
      const current = byIndex.get(index) || { inputJson: "" };
      byIndex.set(index, {
        ...current,
        id: String(contentBlock.id || current.id || `toolu_${index}`),
        name: String(contentBlock.name || current.name || ""),
        inputJson: current.inputJson,
      });
    }
    if (delta?.type === "input_json_delta" && Number.isInteger(index)) {
      const current = byIndex.get(index) || { id: `toolu_${index}`, name: "", inputJson: "" };
      byIndex.set(index, {
        ...current,
        inputJson: current.inputJson + String(delta.partial_json || ""),
      });
    }
  }
  return [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, toolUse]) => normalizeToolUseBlock({
      type: "tool_use",
      id: toolUse.id || `toolu_${index}`,
      name: toolUse.name,
      input: toolUse.inputJson,
    }, `toolu_${index}`))
    .filter(Boolean);
}

function contentBlocksFromBody(body, text) {
  const blocks = [];
  if (typeof text === "string" && text.trim()) blocks.push({ type: "text", text: text.trim() });
  blocks.push(...contentBlocksFromAnthropicContent(firstDefined(body?.content, body?.message?.content, body?.data?.content)));
  blocks.push(...contentBlocksFromToolCalls(body));
  if (body?.kind === "stream" && Array.isArray(body.events)) {
    blocks.push(...contentBlocksFromStreamToolCalls(body.events));
    blocks.push(...contentBlocksFromAnthropicStreamToolUses(body.events));
  }
  return blocks;
}

function stopReasonFromBody(body, blocks = []) {
  const upstream = firstDefined(body?.stop_reason, body?.stopReason, body?.choices?.[0]?.finish_reason);
  if (upstream === "tool_calls" || upstream === "function_call") return "tool_use";
  if (upstream) return upstream;
  return blocks.some((block) => block.type === "tool_use") ? "tool_use" : undefined;
}

export function normalizeMessageResponse(body, selectedModel) {
  if (body?.kind === "stream" && Array.isArray(body.events)) {
    const streamError = findStreamError(body.events);
    if (streamError) throw streamError;
  }
  const text = messageFromBody(body);
  const contentBlocks = contentBlocksFromBody(body, text);
  if (!contentBlocks.length) {
    throw new ProtocolTabbitError("Tabbit message response did not contain assistant text", { category: "protocol_changed", detail: body });
  }
  const result = { ok: true, contentBlocks, selectedModel, raw: body };
  const stopReason = stopReasonFromBody(body, contentBlocks);
  if (stopReason) result.stopReason = stopReason;
  if (body?.kind === "stream" && Array.isArray(body.events)) {
    const streamDeltas = body.events
      .map((event) => extractStreamText(event.data))
      .filter((delta) => typeof delta === "string" && delta.length > 0);
    if (streamDeltas.length) result.streamDeltas = streamDeltas;
  }
  return result;
}

function normalizeAttachmentUploadResponse(body) {
  const data = isPlainObject(body?.data) ? body.data : body;
  const id = firstDefined(data?.id, data?.attachmentId, data?.attachment_id, data?.fileId, data?.file_id);
  if (!id) {
    throw new ProtocolTabbitError("Tabbit attachment upload response did not contain an attachment id", { category: "protocol_changed", detail: body });
  }
  return {
    ok: true,
    attachment: {
      id: String(id),
      name: firstDefined(data?.name, data?.filename, data?.fileName) ?? null,
      mimeType: firstDefined(data?.mimeType, data?.mime_type, data?.contentType, data?.content_type, data?.type) ?? null,
      size: firstDefined(data?.size, data?.bytes, data?.byteSize, data?.byte_size) ?? null,
    },
    raw: body,
  };
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseUsagePercentage(value) {
  if (value === null || value === undefined || value === "") return null;
  const clean = String(value).trim().replace(/%$/, "");
  return toFiniteNumber(clean);
}

function normalizeQuotaUsageResponse(body) {
  const data = isPlainObject(body?.data) ? body.data : body;
  if (!isPlainObject(data)) {
    throw new ProtocolTabbitError("Tabbit quota usage response did not contain an object body", { category: "protocol_changed", detail: body });
  }

  const accessTier = firstDefined(data.member_level, data.memberLevel, data.accessTier, data.access_tier, data.tier);
  const usagePercentage = parseUsagePercentage(firstDefined(data.usage_percentage, data.usagePercentage, data.usage_percent, data.usagePercent));
  const resetAt = firstDefined(data.current_cycle_end, data.currentCycleEnd, data.resetAt, data.reset_at);
  const resetCouponCount = toFiniteNumber(firstDefined(
    data.unused_reset_coupon_count,
    data.unusedResetCouponCount,
    data.resetCouponCount,
    data.reset_coupon_count,
  ));
  if (!accessTier && usagePercentage === null && !resetAt && resetCouponCount === null) {
    throw new ProtocolTabbitError("Tabbit quota usage response did not contain recognized quota fields", { category: "protocol_changed", detail: body });
  }

  const quota = {
    model: "tabbit/priority",
    remaining: null,
    limit: null,
    unit: "usage_percentage",
    resetAt: resetAt ? String(resetAt) : null,
    exhausted: Number.isFinite(usagePercentage) ? usagePercentage >= 100 : false,
    source: "tabbit-quota-usage",
  };
  if (Number.isFinite(usagePercentage)) quota.usagePercentage = usagePercentage;

  return {
    ok: true,
    source: "tabbit-quota-usage",
    ...(accessTier ? { accessTier: String(accessTier) } : {}),
    ...(Number.isFinite(resetCouponCount) ? { resetCouponCount } : {}),
    quotaState: [quota],
    raw: body,
  };
}

function responseDataObject(body, label) {
  const data = isPlainObject(body?.data) ? body.data : body;
  if (!isPlainObject(data)) {
    throw new ProtocolTabbitError(`Tabbit ${label} response did not contain an object body`, { category: "protocol_changed", detail: body });
  }
  return data;
}

function normalizeActivityLotteryResponse(body) {
  const data = responseDataObject(body, "activity lottery");
  return {
    ok: true,
    source: "tabbit-activity-lottery",
    newbieExploration: isPlainObject(data.newbie_exploration) ? data.newbie_exploration : null,
    participation: isPlainObject(data.participation) ? data.participation : null,
    raw: body,
  };
}

function normalizePlacementResourcesResponse(body) {
  const data = responseDataObject(body, "placement resources");
  return {
    ok: true,
    source: "tabbit-placement-resources",
    ...(data.placement_code ? { placementCode: String(data.placement_code) } : {}),
    ...(data.version ? { version: String(data.version) } : {}),
    ...(typeof data.changed === "boolean" ? { changed: data.changed } : {}),
    resources: Array.isArray(data.resources) ? data.resources : [],
    raw: body,
  };
}

function normalizeNewbieExplorationResponse(body) {
  const data = responseDataObject(body, "newbie exploration");
  return {
    ok: true,
    source: "tabbit-newbie-exploration",
    ...(data.view_mode ? { viewMode: String(data.view_mode) } : {}),
    ...(typeof data.visible === "boolean" ? { visible: data.visible } : {}),
    ...(typeof data.is_newbie_eligible === "boolean" ? { isNewbieEligible: data.is_newbie_eligible } : {}),
    ...(data.status ? { status: String(data.status) } : {}),
    ...(Number.isFinite(data.completed_count) ? { completedCount: data.completed_count } : {}),
    ...(Number.isFinite(data.total_task_count) ? { totalTaskCount: data.total_task_count } : {}),
    ...(Array.isArray(data.tasks) ? { tasks: data.tasks } : {}),
    ...(Array.isArray(data.milestones) ? { milestones: data.milestones } : {}),
    ...(Array.isArray(data.rewards) ? { rewards: data.rewards } : {}),
    raw: body,
  };
}

function normalizeRecordListResponse(body, source) {
  const data = responseDataObject(body, source);
  const records = Array.isArray(data.records) ? data.records : [];
  const total = toFiniteNumber(data.total);
  return {
    ok: true,
    source,
    total: Number.isFinite(total) ? total : records.length,
    records,
    raw: body,
  };
}

function normalizeDailySignInStatusResponse(body, source = "tabbit-daily-sign-in-status", label = "daily sign-in status") {
  const data = responseDataObject(body, label);
  const results = Array.isArray(data.results) ? data.results : [];
  const firstResult = results.find((item) => isPlainObject(item)) || null;
  const signedDays = toFiniteNumber(firstDefined(firstResult?.signed_days, data.signed_days));
  const totalSignedDays = toFiniteNumber(firstDefined(firstResult?.total_signed_days, data.total_signed_days));
  return {
    ok: true,
    source,
    ...(data.sign_in_date ? { signInDate: String(data.sign_in_date) } : {}),
    ...(firstResult?.scene_code ? { sceneCode: String(firstResult.scene_code) } : {}),
    ...(typeof firstDefined(firstResult?.signed_today, data.signed_today) === "boolean" ? { signedToday: firstDefined(firstResult?.signed_today, data.signed_today) } : {}),
    ...(firstDefined(firstResult?.sign_in_result, data.sign_in_result) ? { signInResult: String(firstDefined(firstResult?.sign_in_result, data.sign_in_result)) } : {}),
    ...(Number.isFinite(signedDays) ? { signedDays } : {}),
    ...(Number.isFinite(totalSignedDays) ? { totalSignedDays } : {}),
    results,
    raw: body,
  };
}

function normalizeCouponListResponse(body) {
  const data = responseDataObject(body, "benefit coupon list");
  const records = Array.isArray(data.records)
    ? data.records
    : (Array.isArray(data.coupons) ? data.coupons : (Array.isArray(data.items) ? data.items : []));
  const total = toFiniteNumber(firstDefined(data.total, data.count, data.total_count, data.totalCount));
  return {
    ok: true,
    source: "tabbit-benefit-coupon-list",
    total: Number.isFinite(total) ? total : records.length,
    records,
    raw: body,
  };
}

function normalizeCommerceObjectResponse(body, source, label) {
  const data = responseDataObject(body, label);
  const usageResult = firstDefined(data.use_result, data.usage_result, data.useResult, data.usageResult);
  const couponResult = firstDefined(data.coupon_result, data.couponResult);
  return {
    ok: true,
    source,
    raw: body,
    ...(data.activity_id !== undefined && data.activity_id !== null && data.activity_id !== "" ? { activityId: String(data.activity_id) } : {}),
    ...(data.participation_result ? { participationResult: String(data.participation_result) } : {}),
    ...(usageResult ? { usageResult: String(usageResult) } : {}),
    ...(couponResult ? { couponResult: String(couponResult) } : {}),
    ...(data.used === true ? { used: true } : {}),
    ...(data.status ? { status: String(data.status) } : {}),
    ...(data.result ? { result: data.result } : {}),
  };
}

function requireConfiguredPath(path, code, message) {
  if (path) return;
  throw new ProtocolTabbitError(message, {
    category: "protocol_missing",
    code,
    retryable: false,
  });
}

function accountSessionCookie(account = {}) {
  return account.cookie || account.cookieHeader;
}

function requireSessionCookie(account = {}, purpose) {
  const cookie = accountSessionCookie(account);
  if (cookie) return cookie;
  throw new ProtocolTabbitError(`Session material is required for Tabbit ${purpose}.`, {
    category: "session_missing",
    code: "SESSION_MISSING",
    retryable: false,
  });
}

function requireUserId({ account = {}, userId = null, purpose }) {
  const finalUserId = firstDefined(userId, account.userId, account.user_id, account.user?.id);
  if (finalUserId) return String(finalUserId);
  throw new ProtocolTabbitError(`Tabbit user_id is required for ${purpose}.`, {
    category: "invalid_request",
    code: "MISSING_USER_ID",
    retryable: false,
  });
}

function requireNonEmptyString(value, label, code) {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ProtocolTabbitError(`${label} must be a non-empty string.`, {
    category: "invalid_request",
    code,
    retryable: false,
  });
}

function requireAuthClientUuid(value) {
  const text = requireNonEmptyString(value, "uuid", "MISSING_AUTH_CLIENT_UUID");
  if (/^[A-Za-z0-9]{64}$/.test(text)) return text;
  throw new ProtocolTabbitError("uuid must be a 64-character alphanumeric auth client value.", {
    category: "invalid_request",
    code: "INVALID_AUTH_CLIENT_UUID",
    retryable: false,
  });
}

function requireRequestNo(value) {
  const text = requireNonEmptyString(value, "requestNo", "MISSING_REQUEST_NO");
  if (text.length <= 64) return text;
  throw new ProtocolTabbitError("requestNo must be at most 64 characters.", {
    category: "invalid_request",
    code: "INVALID_REQUEST_NO",
    retryable: false,
  });
}

function normalizeSceneCodes(sceneCodes = [DEFAULT_DAILY_SIGN_IN_SCENE]) {
  const raw = Array.isArray(sceneCodes) ? sceneCodes : [sceneCodes];
  const normalized = raw.map((item) => String(item || "").trim()).filter(Boolean);
  if (normalized.length > 0) return normalized;
  throw new ProtocolTabbitError("sceneCodes must contain at least one scene code.", {
    category: "invalid_request",
    code: "INVALID_SCENE_CODES",
    retryable: false,
  });
}

function requirePlainObjectInput(value, label, code) {
  if (isPlainObject(value)) return value;
  throw new ProtocolTabbitError(`${label} must be a JSON object.`, {
    category: "invalid_request",
    code,
    retryable: false,
  });
}

function requireSideEffectConfirmation(confirmSideEffect) {
  if (confirmSideEffect === true) return;
  throw new ProtocolTabbitError("Explicit confirmSideEffect:true is required for this Tabbit side-effect operation.", {
    category: "invalid_request",
    code: "SIDE_EFFECT_CONFIRMATION_REQUIRED",
    retryable: false,
  });
}

function normalizeNonNegativeIntegerInput(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (Number.isInteger(number) && number >= 0) return number;
  throw new ProtocolTabbitError(`${label} must be a non-negative integer.`, {
    category: "invalid_request",
    code: `INVALID_${label.toUpperCase()}`,
    retryable: false,
  });
}

function validatedNewbieExplorationViewMode(viewMode) {
  const value = String(viewMode || "event_gate").trim();
  if (NEWBIE_EXPLORATION_VIEW_MODES.has(value)) return value;
  throw new ProtocolTabbitError("Unsupported Tabbit newbie exploration view_mode.", {
    category: "invalid_request",
    code: "INVALID_NEWBIE_EXPLORATION_VIEW_MODE",
    retryable: false,
    detail: { viewMode: value, allowed: [...NEWBIE_EXPLORATION_VIEW_MODES] },
  });
}

export function classifyProtocolError(input = {}) {
  if (input instanceof ProtocolTabbitError) {
    return { category: input.category, status: input.status, code: input.code, message: input.message, retryable: input.retryable, cooldownMs: input.cooldownMs };
  }
  if (input instanceof Error && input.status === undefined) {
    return { category: "network_error", status: null, code: null, message: input.message || "Network error.", retryable: true, cooldownMs: 1000 };
  }
  const status = input.status ?? null;
  const body = input.body ?? input.detail ?? null;
  const message = body?.error_message || body?.invalid_reason || body?.detail?.error_message || body?.detail?.message || body?.error || body?.message || (status ? `Tabbit protocol request failed with status ${status}.` : "Tabbit protocol request failed.");
  const code = body?.error_code || body?.invalid_code || body?.detail?.error_code || body?.code || body?.errorCode || null;
  if (status === 401) return { category: "login_required", status, code, message, retryable: false, cooldownMs: 0 };
  if (isQuotaExhaustedSignal({ code, message, body })) return { category: "quota_exhausted", status, code, message, retryable: true, cooldownMs: 0 };
  if (status === 403) return { category: "forbidden", status, code, message, retryable: false, cooldownMs: 30 * 60_000 };
  if (status === 429) return { category: "rate_limited", status, code, message, retryable: true, cooldownMs: parseRetryAfter(input.headers) || 60_000 };
  if (status >= 500) return { category: "upstream_error", status, code, message, retryable: true, cooldownMs: 10_000 };
  if (status >= 400) return { category: "invalid_request", status, code, message, retryable: false, cooldownMs: 0 };
  return { category: "unknown", status, code, message, retryable: false, cooldownMs: 0 };
}

function isQuotaExhaustedSignal({ code, message, body } = {}) {
  const text = [
    code,
    message,
    body?.reason,
    body?.type,
    body?.data?.code,
    body?.data?.message,
  ].filter(Boolean).join(" ").toLowerCase();
  if (!text) return false;
  if (/(^|[^a-z])(quota_exhausted|insufficient_quota|usage_limit_exceeded|credit_exhausted)([^a-z]|$)/i.test(text)) return true;
  return /\b(quota|credit|usage)\b/.test(text) && /\b(exhausted|insufficient|depleted|limit|used up)\b/.test(text);
}

function accountStatusForCategory(category) {
  return category === "login_required" || category === "session_missing" ? "login_expired" : "suspect";
}

function verificationFailure(error) {
  const classified = classifyProtocolError(error);
  return {
    ok: false,
    category: classified.category,
    code: classified.code,
    message: classified.message,
    retryable: classified.retryable,
    cooldownMs: classified.cooldownMs,
    httpStatus: classified.status,
    accountStatus: accountStatusForCategory(classified.category),
    error: new ProtocolTabbitError(classified.message, classified),
  };
}

function protocolResponseError(response, body) {
  const classified = classifyProtocolError({ status: response.status, headers: response.headers, body });
  return new ProtocolTabbitError(classified.message, classified);
}

function normalizeVerificationResponse(body) {
  const data = isPlainObject(body?.data) ? body.data : body;
  const userInfo = isPlainObject(data?.user_info) ? data.user_info : data?.userInfo;
  const userId = firstDefined(data?.userId, data?.user_id, data?.user?.id, data?.account?.userId, userInfo?.id);
  const accessTier = firstDefined(data?.accessTier, data?.access_tier, data?.tier, data?.user?.accessTier, data?.account?.accessTier, userInfo?.accessTier, userInfo?.access_tier, userInfo?.tier);
  return {
    ok: true,
    ...(userId ? { userId: String(userId) } : {}),
    ...(accessTier ? { accessTier: String(accessTier) } : {}),
    raw: body,
  };
}

function headerValue(headers, name) {
  return headers?.get?.(name) || headers?.get?.(name.toLowerCase()) || null;
}

function normalizeAuthSubmitResponse(body, headers = null) {
  const data = isPlainObject(body?.data) ? body.data : body;
  const userInfo = isPlainObject(data?.user_info) ? data.user_info : data?.userInfo;
  const cookieHeader = firstDefined(
    headerValue(headers, "set-cookie"),
    data?.cookieHeader,
    data?.cookie_header,
    data?.session?.cookieHeader,
    data?.session?.cookie_header,
  );
  const cookie = firstDefined(data?.cookie, data?.session?.cookie);
  const cookieJar = firstDefined(data?.cookieJar, data?.cookie_jar, data?.session?.cookieJar, data?.session?.cookie_jar);
  const session = firstDefined(data?.session && typeof data.session === "string" ? data.session : null, data?.session?.value);
  const sessionToken = firstDefined(data?.sessionToken, data?.session_token, data?.session?.token);
  const token = firstDefined(data?.token, data?.accessToken, data?.access_token);
  const userId = firstDefined(data?.userId, data?.user_id, data?.user?.id, data?.account?.userId, userInfo?.id);
  const accessTier = firstDefined(data?.accessTier, data?.access_tier, data?.tier, data?.user?.accessTier, data?.account?.accessTier, userInfo?.accessTier, userInfo?.access_tier, userInfo?.tier);
  return {
    ok: true,
    source: "tabbit-auth-submit-code",
    ...(cookieHeader ? { cookieHeader: String(cookieHeader) } : {}),
    ...(cookie ? { cookie: String(cookie) } : {}),
    ...(cookieJar ? { cookieJar } : {}),
    ...(session ? { session: String(session) } : {}),
    ...(sessionToken ? { sessionToken: String(sessionToken) } : {}),
    ...(token ? { token: String(token) } : {}),
    ...(userId ? { userId: String(userId) } : {}),
    ...(accessTier ? { accessTier: String(accessTier) } : {}),
    raw: body,
  };
}

function resultFromError(error) {
  const classified = classifyProtocolError(error);
  return {
    ok: false,
    category: classified.category,
    code: classified.code,
    message: classified.message,
    retryable: classified.retryable,
    cooldownMs: classified.cooldownMs,
    httpStatus: classified.status,
    error: new ProtocolTabbitError(classified.message, classified),
  };
}

export class ProtocolTabbitClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL, signKeyPath = DEFAULT_SIGN_KEY_PATH, modelCatalogPath = DEFAULT_MODEL_CATALOG_PATH, modelCatalogScene = DEFAULT_MODEL_CATALOG_SCENE, sendPath = null, authSendCodePath = null, authSendCodeMethod = "POST", authSubmitCodePath = null, authSubmitCodeMethod = "POST", attachmentUploadPath = null, attachmentCompleteUploadPath = null, quotaUsagePath = null, activityLotteryPath = null, newbieExplorationPath = null, placementResourcesPath = null, rewardCardRecordsPath = null, lotteryHitRecordsPath = null, signInStatusPath = null, signInPath = null, benefitCouponListPath = null, benefitCouponUsePath = null, activityParticipatePath = null, usageResetCouponSkuPath = null, lotteryAvailableChancesPath = null, lotteryActiveMainPoolsPath = null, lotteryChanceRecordsPath = null, lotteryDrawPath = null, sessionVerifyPath = null, sessionVerifyMethod = "GET",
    reqCtx = DEFAULT_REQ_CTX, defaultChatSessionId = null,
    fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), nonce = () => randomUUID(), signature = null, uniqueUuid = null, authClientUuid = null, signKeyTtlMs = 5 * 60_000, modelCatalogTtlMs = 5 * 60_000,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new ProtocolTabbitError("fetch implementation is required", { category: "invalid_request", code: "MISSING_FETCH" });
    this.baseUrl = trimTrailingSlash(baseUrl);
    this.signKeyPath = normalizePath(signKeyPath);
    this.modelCatalogPath = normalizePath(modelCatalogPath);
    this.modelCatalogScene = modelCatalogScene;
    this.sendPath = sendPath ? normalizePath(sendPath) : null;
    this.authSendCodePath = authSendCodePath ? normalizePath(authSendCodePath) : null;
    this.authSendCodeMethod = String(authSendCodeMethod || "POST").toUpperCase();
    this.authSubmitCodePath = authSubmitCodePath ? normalizePath(authSubmitCodePath) : null;
    this.authSubmitCodeMethod = String(authSubmitCodeMethod || "POST").toUpperCase();
    this.attachmentUploadPath = attachmentUploadPath ? normalizePath(attachmentUploadPath) : null;
    this.attachmentCompleteUploadPath = attachmentCompleteUploadPath ? normalizePath(attachmentCompleteUploadPath) : null;
    this.quotaUsagePath = quotaUsagePath ? normalizePath(quotaUsagePath) : null;
    this.activityLotteryPath = activityLotteryPath ? normalizePath(activityLotteryPath) : null;
    this.newbieExplorationPath = newbieExplorationPath ? normalizePath(newbieExplorationPath) : null;
    this.placementResourcesPath = placementResourcesPath ? normalizePath(placementResourcesPath) : null;
    this.rewardCardRecordsPath = rewardCardRecordsPath ? normalizePath(rewardCardRecordsPath) : null;
    this.lotteryHitRecordsPath = lotteryHitRecordsPath ? normalizePath(lotteryHitRecordsPath) : null;
    this.signInStatusPath = signInStatusPath ? normalizePath(signInStatusPath) : null;
    this.signInPath = signInPath ? normalizePath(signInPath) : null;
    this.benefitCouponListPath = benefitCouponListPath ? normalizePath(benefitCouponListPath) : null;
    this.benefitCouponUsePath = benefitCouponUsePath ? normalizePath(benefitCouponUsePath) : null;
    this.activityParticipatePath = activityParticipatePath ? normalizePath(activityParticipatePath) : null;
    this.usageResetCouponSkuPath = usageResetCouponSkuPath ? normalizePath(usageResetCouponSkuPath) : null;
    this.lotteryAvailableChancesPath = lotteryAvailableChancesPath ? normalizePath(lotteryAvailableChancesPath) : null;
    this.lotteryActiveMainPoolsPath = lotteryActiveMainPoolsPath ? normalizePath(lotteryActiveMainPoolsPath) : null;
    this.lotteryChanceRecordsPath = lotteryChanceRecordsPath ? normalizePath(lotteryChanceRecordsPath) : null;
    this.lotteryDrawPath = lotteryDrawPath ? normalizePath(lotteryDrawPath) : null;
    this.sessionVerifyPath = sessionVerifyPath ? normalizePath(sessionVerifyPath) : null;
    this.sessionVerifyMethod = String(sessionVerifyMethod || "GET").toUpperCase();
    this.reqCtx = reqCtx;
    this.defaultChatSessionId = defaultChatSessionId;
    this.fetch = fetchImpl; this.now = now; this.nonce = nonce; this.signature = signature || nonce; this.uniqueUuid = uniqueUuid || (() => createUniqueUuid({ now: this.now })); this.authClientUuid = typeof authClientUuid === "function" ? authClientUuid : (() => authClientUuid || createAuthClientUuid()); this.signKeyTtlMs = signKeyTtlMs; this.modelCatalogTtlMs = modelCatalogTtlMs;
    this.signKeyCache = null; this.modelCatalogCache = null; this.cachedAuthClientUuid = null;
  }

  buildUrl(path, query = {}) {
    const url = new URL(`${this.baseUrl}${normalizePath(path)}`);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    return url.toString();
  }

  buildUrlWithParams(path, params) {
    const url = new URL(`${this.baseUrl}${normalizePath(path)}`);
    for (const [key, value] of params.entries()) url.searchParams.append(key, value);
    return url.toString();
  }

  async getSignKey({ force = false } = {}) {
    const now = this.now();
    if (!force && this.signKeyCache && this.signKeyCache.expiresAt > now) return this.signKeyCache.key;
    const response = await this.fetch(this.buildUrl(this.signKeyPath), { method: "GET", headers: {} });
    const body = await parseBody(response);
    if (!response.ok) throw new ProtocolTabbitError("Failed to fetch Tabbit sign key", classifyProtocolError({ status: response.status, headers: response.headers, body }));
    const key = extractSignKey(body);
    if (!key) throw new ProtocolTabbitError("Tabbit sign-key response did not contain a key", { category: "protocol_changed", detail: body });
    this.signKeyCache = { key, expiresAt: now + this.signKeyTtlMs };
    return key;
  }

  async listModels({ force = false, scene = this.modelCatalogScene } = {}) {
    const now = this.now();
    if (!force && this.modelCatalogCache && this.modelCatalogCache.expiresAt > now) return this.modelCatalogCache.models;
    const response = await this.fetch(this.buildUrl(this.modelCatalogPath, { a: 0, ...(scene ? { scene } : {}) }), { method: "GET", headers: {} });
    const body = await parseBody(response);
    if (!response.ok) throw new ProtocolTabbitError("Failed to fetch Tabbit model catalog", classifyProtocolError({ status: response.status, headers: response.headers, body }));
    const models = normalizeModelCatalog(body);
    this.modelCatalogCache = { models, expiresAt: now + this.modelCatalogTtlMs };
    return models;
  }

  async verifySession({ account = {}, session = null } = {}) {
    if (!this.sessionVerifyPath) {
      return {
        ok: false,
        category: "protocol_missing",
        code: "MISSING_SESSION_VERIFY_PATH",
        message: "Tabbit session verification endpoint is not configured.",
        retryable: false,
        cooldownMs: 0,
        httpStatus: null,
        accountStatus: "suspect",
      };
    }

    const cookie = session || account.cookie || account.cookieHeader;
    if (!cookie) {
      return {
        ok: false,
        category: "session_missing",
        code: "SESSION_MISSING",
        message: "Session material is required for Tabbit session verification.",
        retryable: false,
        cooldownMs: 0,
        httpStatus: null,
        accountStatus: "login_expired",
      };
    }

    try {
      const signKey = await this.getSignKey();
      const timestamp = this.now();
      const nonce = this.nonce();
      const headers = {
        Cookie: cookie,
        ...createSignedHeaders({ method: this.sessionVerifyMethod, path: this.sessionVerifyPath, signKey, timestamp, nonce }),
      };
      const response = await this.fetch(this.buildUrl(this.sessionVerifyPath), { method: this.sessionVerifyMethod, headers });
      const body = await parseBody(response);
      if (!response.ok) return verificationFailure(protocolResponseError(response, body));
      return normalizeVerificationResponse(body);
    } catch (error) {
      return verificationFailure(error);
    }
  }

  authJsonHeaders(bodyText, signKey) {
    const timestamp = this.now();
    return {
      accept: "application/json",
      "Content-Type": "application/json",
      ...(this.reqCtx ? { "x-req-ctx": this.reqCtx } : {}),
      "unique-uuid": this.uniqueUuid(),
      ...createSignedHeaders({ bodyText, signKey, timestamp, signature: this.signature() }),
    };
  }

  proxyOauthJsonHeaders() {
    return {
      accept: "application/json",
      "Content-Type": "application/json",
      ...(this.reqCtx ? { "x-req-ctx": this.reqCtx } : {}),
      "unique-uuid": this.uniqueUuid(),
    };
  }

  async postAuthJson({ path, method, body }) {
    const bodyText = JSON.stringify(body);
    const headers = usesProxyOauthProtocol(path)
      ? this.proxyOauthJsonHeaders()
      : this.authJsonHeaders(bodyText, await this.getSignKey());
    const response = await this.fetch(this.buildUrl(path), {
      method,
      headers,
      body: bodyText,
    });
    const responseBody = await parseBody(response);
    if (!response.ok) return resultFromError(protocolResponseError(response, responseBody));
    return { response, responseBody };
  }

  getAuthClientUuid(candidate = null) {
    if (candidate !== null && candidate !== undefined && candidate !== "") return requireAuthClientUuid(candidate);
    if (!this.cachedAuthClientUuid) this.cachedAuthClientUuid = requireAuthClientUuid(this.authClientUuid());
    return this.cachedAuthClientUuid;
  }

  buildProxyOauthSendCodeBody({ mobile = null, uuid = null, input = {} } = {}) {
    return {
      uuid: this.getAuthClientUuid(firstDefined(uuid, input?.uuid, input?.authClientUuid)),
      platform: "1",
      version: "",
      app: "1000",
      mobile: requireNonEmptyString(firstDefined(mobile, input?.mobile, input?.phoneNumber, input?.phone_number), "mobile", "MISSING_MOBILE"),
    };
  }

  buildProxyOauthSubmitBody({ mobile = null, code = null, uuid = null, input = {} } = {}) {
    const body = {
      ...this.buildProxyOauthSendCodeBody({ mobile, uuid, input }),
      smsCode: requireNonEmptyString(firstDefined(code, input?.code, input?.smsCode), "code", "MISSING_VERIFICATION_CODE"),
    };
    const channel = firstDefined(input?.channel, input?.tabChannel);
    if (channel !== undefined && channel !== null && String(channel).trim()) body.channel = String(channel).trim();
    return body;
  }

  async sendVerificationCode({ email = null, mobile = null, uuid = null, body = null, input = {} } = {}) {
    try {
      requireConfiguredPath(
        this.authSendCodePath,
        "MISSING_AUTH_SEND_CODE_PATH",
        "Tabbit auth send-code endpoint is not configured.",
      );
      const requestBody = body !== null && body !== undefined
        ? requirePlainObjectInput(body, "body", "INVALID_AUTH_SEND_CODE_BODY")
        : (isPlainObject(input?.authSendCodeBody)
            ? input.authSendCodeBody
            : (usesProxyOauthProtocol(this.authSendCodePath)
                ? this.buildProxyOauthSendCodeBody({ mobile, uuid, input })
                : { email: requireNonEmptyString(firstDefined(email, input?.email), "email", "MISSING_EMAIL") }));
      const result = await this.postAuthJson({
        path: this.authSendCodePath,
        method: this.authSendCodeMethod,
        body: requestBody,
      });
      if (result.ok === false) return result;
      return {
        ok: true,
        source: "tabbit-auth-send-code",
        raw: result.responseBody,
      };
    } catch (error) {
      return resultFromError(error);
    }
  }

  async submitRegistrationOrLogin({ email = null, mobile = null, uuid = null, code = null, body = null, input = {} } = {}) {
    try {
      requireConfiguredPath(
        this.authSubmitCodePath,
        "MISSING_AUTH_SUBMIT_CODE_PATH",
        "Tabbit auth submit-code endpoint is not configured.",
      );
      const requestBody = body !== null && body !== undefined
        ? requirePlainObjectInput(body, "body", "INVALID_AUTH_SUBMIT_CODE_BODY")
        : (isPlainObject(input?.authSubmitCodeBody)
            ? input.authSubmitCodeBody
            : (usesProxyOauthProtocol(this.authSubmitCodePath)
                ? this.buildProxyOauthSubmitBody({ mobile, uuid, code, input })
                : {
                    email: requireNonEmptyString(firstDefined(email, input?.email), "email", "MISSING_EMAIL"),
                    code: requireNonEmptyString(firstDefined(code, input?.code), "code", "MISSING_VERIFICATION_CODE"),
                  }));
      const result = await this.postAuthJson({
        path: this.authSubmitCodePath,
        method: this.authSubmitCodeMethod,
        body: requestBody,
      });
      if (result.ok === false) return result;
      return normalizeAuthSubmitResponse(result.responseBody, result.response.headers);
    } catch (error) {
      return resultFromError(error);
    }
  }

  async uploadAttachment({ account = {}, attachment = {} } = {}) {
    if (!this.attachmentUploadPath) {
      return resultFromError(new ProtocolTabbitError("Tabbit attachment upload endpoint is not configured.", { category: "protocol_missing", code: "MISSING_ATTACHMENT_UPLOAD_PATH", retryable: false }));
    }
    if (this.attachmentCompleteUploadPath) {
      try {
        const cookie = requireSessionCookie(account, "attachment upload");
        const { filename, mimeType, payload, presignBody } = buildCosAttachmentUploadParts(attachment);
        const presignResponse = await this.fetch(this.buildUrl(this.attachmentUploadPath), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "trace-id": this.uniqueUuid(),
            Cookie: cookie,
          },
          body: JSON.stringify(presignBody),
        });
        const presignBodyResponse = await parseBody(presignResponse);
        if (!presignResponse.ok) return resultFromError(protocolResponseError(presignResponse, presignBodyResponse));
        const presigned = normalizeCosPresignedUploadResponse(presignBodyResponse);

        const putResponse = await this.fetch(presigned.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": mimeType },
          body: payload,
        });
        if (!putResponse.ok) {
          const putBody = await parseBody(putResponse);
          return resultFromError(protocolResponseError(putResponse, putBody));
        }

        const completeBody = { file_id: presigned.fileId };
        const completeResponse = await this.fetch(this.buildUrl(this.attachmentCompleteUploadPath), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "trace-id": this.uniqueUuid(),
            Cookie: cookie,
          },
          body: JSON.stringify(completeBody),
        });
        const completeResponseBody = await parseBody(completeResponse);
        if (!completeResponse.ok) return resultFromError(protocolResponseError(completeResponse, completeResponseBody));
        return normalizeCosAttachmentUploadResult({ presigned, completeBody: completeResponseBody, filename, mimeType, payload });
      } catch (error) {
        return resultFromError(error);
      }
    }
    const body = { attachment };
    try {
      const signKey = await this.getSignKey();
      const timestamp = this.now();
      const nonce = this.nonce();
      const headers = {
        "Content-Type": "application/json",
        ...createSignedHeaders({ method: "POST", path: this.attachmentUploadPath, body, signKey, timestamp, nonce }),
      };
      const cookie = account.cookie || account.cookieHeader;
      if (cookie) headers.Cookie = cookie;
      const response = await this.fetch(this.buildUrl(this.attachmentUploadPath), { method: "POST", headers, body: JSON.stringify(body) });
      const responseBody = await parseBody(response);
      if (!response.ok) return resultFromError(protocolResponseError(response, responseBody));
      return normalizeAttachmentUploadResponse(responseBody);
    } catch (error) {
      return resultFromError(error);
    }
  }

  async refreshQuota({ account = {}, userId = null } = {}) {
    if (!this.quotaUsagePath) {
      throw new ProtocolTabbitError("Tabbit quota usage endpoint is not configured.", {
        category: "protocol_missing",
        code: "MISSING_QUOTA_USAGE_PATH",
        retryable: false,
      });
    }

    const finalUserId = firstDefined(userId, account.userId, account.user_id, account.user?.id);
    if (!finalUserId) {
      throw new ProtocolTabbitError("Tabbit user_id is required for quota usage.", {
        category: "invalid_request",
        code: "MISSING_USER_ID",
        retryable: false,
      });
    }

    const cookie = account.cookie || account.cookieHeader;
    if (!cookie) {
      throw new ProtocolTabbitError("Session material is required for Tabbit quota usage.", {
        category: "session_missing",
        code: "SESSION_MISSING",
        retryable: false,
      });
    }

    const headers = {
      accept: "application/json",
      ...(this.reqCtx ? { "x-req-ctx": this.reqCtx } : {}),
      "unique-uuid": this.uniqueUuid(),
      Cookie: cookie,
    };
    const response = await this.fetch(this.buildUrl(this.quotaUsagePath, { user_id: finalUserId }), { method: "GET", headers });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeQuotaUsageResponse(body);
  }

  commerceReadOnlyHeaders(cookie) {
    return {
      accept: "application/json",
      ...(this.reqCtx ? { "x-req-ctx": this.reqCtx } : {}),
      "unique-uuid": this.uniqueUuid(),
      Cookie: cookie,
    };
  }

  commerceContextJsonHeaders(cookie) {
    return {
      ...this.commerceReadOnlyHeaders(cookie),
      "Content-Type": "application/json",
    };
  }

  commerceTraceJsonHeaders(cookie) {
    return {
      accept: "application/json",
      "Content-Type": "application/json",
      "trace-id": this.uniqueUuid(),
      Cookie: cookie,
    };
  }

  async getLotteryExplorationMe({ account = {} } = {}) {
    requireConfiguredPath(
      this.activityLotteryPath,
      "MISSING_ACTIVITY_LOTTERY_PATH",
      "Tabbit activity lottery endpoint is not configured.",
    );
    const cookie = requireSessionCookie(account, "activity lottery");
    const response = await this.fetch(this.buildUrl(this.activityLotteryPath), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeActivityLotteryResponse(body);
  }

  async getPlacementResources({
    account = {},
    placementCode = "home.input_below",
    clientVersion = null,
  } = {}) {
    requireConfiguredPath(
      this.placementResourcesPath,
      "MISSING_PLACEMENT_RESOURCES_PATH",
      "Tabbit placement resources endpoint is not configured.",
    );
    const finalPlacementCode = requireNonEmptyString(placementCode, "placementCode", "MISSING_PLACEMENT_CODE");
    const cookie = requireSessionCookie(account, "placement resources");
    const response = await this.fetch(this.buildUrl(this.placementResourcesPath, {
      placement_code: finalPlacementCode,
      ...(clientVersion ? { client_version: clientVersion } : {}),
    }), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizePlacementResourcesResponse(body);
  }

  async getNewbieExplorationMe({
    account = {},
    viewMode = "event_gate",
    includeCompletions = true,
    includeRewards = true,
    intentTaskCode = null,
    intentCompletionEventType = null,
  } = {}) {
    requireConfiguredPath(
      this.newbieExplorationPath,
      "MISSING_NEWBIE_EXPLORATION_PATH",
      "Tabbit newbie exploration endpoint is not configured.",
    );
    const finalViewMode = validatedNewbieExplorationViewMode(viewMode);
    const cookie = requireSessionCookie(account, "newbie exploration");
    const query = {
      view_mode: finalViewMode,
      ...(includeCompletions ? { include_completions: true } : {}),
      ...(includeRewards ? { include_rewards: true } : {}),
      ...(intentTaskCode ? { intent_task_code: intentTaskCode } : {}),
      ...(intentCompletionEventType ? { intent_completion_event_type: intentCompletionEventType } : {}),
    };
    const response = await this.fetch(this.buildUrl(this.newbieExplorationPath, query), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeNewbieExplorationResponse(body);
  }

  async listRewardCardRecords({
    account = {},
    userId = null,
    offset = 0,
    limit = 10,
    order = "desc",
    rewardPackageId = null,
    awardStatus = null,
  } = {}) {
    requireConfiguredPath(
      this.rewardCardRecordsPath,
      "MISSING_REWARD_CARD_RECORDS_PATH",
      "Tabbit reward card records endpoint is not configured.",
    );
    const finalUserId = requireUserId({ account, userId, purpose: "reward card records" });
    const cookie = requireSessionCookie(account, "reward card records");
    const query = {
      user_id: finalUserId,
      offset: normalizeNonNegativeIntegerInput(offset, 0, "offset"),
      limit: normalizeNonNegativeIntegerInput(limit, 10, "limit"),
      "order.field": "award_time",
      "order.order": String(order || "desc"),
      ...(rewardPackageId ? { reward_package_id: rewardPackageId } : {}),
      ...(awardStatus ? { award_status: awardStatus } : {}),
    };
    const response = await this.fetch(this.buildUrl(this.rewardCardRecordsPath, query), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeRecordListResponse(body, "tabbit-reward-card-records");
  }

  async listLotteryHitRecords({
    account = {},
    userId = null,
    offset = 0,
    limit = 20,
    mainPoolId = null,
  } = {}) {
    requireConfiguredPath(
      this.lotteryHitRecordsPath,
      "MISSING_LOTTERY_HIT_RECORDS_PATH",
      "Tabbit lottery hit records endpoint is not configured.",
    );
    const finalUserId = requireUserId({ account, userId, purpose: "lottery hit records" });
    const cookie = requireSessionCookie(account, "lottery hit records");
    const query = {
      user_id: finalUserId,
      offset: normalizeNonNegativeIntegerInput(offset, 0, "offset"),
      limit: normalizeNonNegativeIntegerInput(limit, 20, "limit"),
      ...(mainPoolId ? { main_pool_id: mainPoolId } : {}),
    };
    const response = await this.fetch(this.buildUrl(this.lotteryHitRecordsPath, query), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeRecordListResponse(body, "tabbit-lottery-hit-records");
  }

  async getDailySignInStatus({
    account = {},
    sceneCodes = [DEFAULT_DAILY_SIGN_IN_SCENE],
  } = {}) {
    requireConfiguredPath(
      this.signInStatusPath,
      "MISSING_SIGN_IN_STATUS_PATH",
      "Tabbit daily sign-in status endpoint is not configured.",
    );
    const cookie = requireSessionCookie(account, "daily sign-in status");
    const params = new URLSearchParams();
    for (const sceneCode of normalizeSceneCodes(sceneCodes)) params.append("scene_codes", sceneCode);
    const response = await this.fetch(this.buildUrlWithParams(this.signInStatusPath, params), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeDailySignInStatusResponse(body);
  }

  async dailySignIn({
    account = {},
    requestNo = null,
    sceneCodes = [DEFAULT_DAILY_SIGN_IN_SCENE],
    confirmSideEffect = false,
  } = {}) {
    requireSideEffectConfirmation(confirmSideEffect);
    requireConfiguredPath(
      this.signInPath,
      "MISSING_SIGN_IN_PATH",
      "Tabbit daily sign-in endpoint is not configured.",
    );
    const cookie = requireSessionCookie(account, "daily sign-in");
    const body = {
      request_no: requireRequestNo(requestNo),
      scene_codes: normalizeSceneCodes(sceneCodes),
    };
    const response = await this.fetch(this.buildUrl(this.signInPath), {
      method: "POST",
      headers: this.commerceTraceJsonHeaders(cookie),
      body: JSON.stringify(body),
    });
    const responseBody = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, responseBody);
    return normalizeDailySignInStatusResponse(responseBody, "tabbit-daily-sign-in", "daily sign-in");
  }

  async listBenefitCoupons({
    account = {},
    userId = null,
    couponType = WEEKLY_RESET_COUPON_TYPE,
    offset = 0,
    limit = 50,
    status = null,
  } = {}) {
    requireConfiguredPath(
      this.benefitCouponListPath,
      "MISSING_BENEFIT_COUPON_LIST_PATH",
      "Tabbit benefit coupon list endpoint is not configured.",
    );
    const finalUserId = requireUserId({ account, userId, purpose: "benefit coupon list" });
    const cookie = requireSessionCookie(account, "benefit coupon list");
    const query = {
      user_id: finalUserId,
      coupon_type: requireNonEmptyString(couponType, "couponType", "MISSING_COUPON_TYPE"),
      offset: normalizeNonNegativeIntegerInput(offset, 0, "offset"),
      limit: normalizeNonNegativeIntegerInput(limit, 50, "limit"),
      ...(status !== null && status !== undefined && status !== "" ? { user_coupon_status: status } : {}),
    };
    const response = await this.fetch(this.buildUrl(this.benefitCouponListPath, query), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeCouponListResponse(body);
  }

  async participateResetCouponActivity({
    account = {},
    userId = null,
    requestNo = null,
    confirmSideEffect = false,
  } = {}) {
    requireSideEffectConfirmation(confirmSideEffect);
    requireConfiguredPath(
      this.activityParticipatePath,
      "MISSING_ACTIVITY_PARTICIPATE_PATH",
      "Tabbit activity participate endpoint is not configured.",
    );
    const finalUserId = requireUserId({ account, userId, purpose: "reset coupon activity participate" });
    const cookie = requireSessionCookie(account, "reset coupon activity participate");
    const body = {
      user_id: finalUserId,
      request_no: requireRequestNo(requestNo),
    };
    const response = await this.fetch(this.buildUrl(this.activityParticipatePath), {
      method: "POST",
      headers: this.commerceContextJsonHeaders(cookie),
      body: JSON.stringify(body),
    });
    const responseBody = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, responseBody);
    return normalizeCommerceObjectResponse(responseBody, "tabbit-reset-coupon-activity-participate", "reset coupon activity participate");
  }

  async useResetCoupon({
    account = {},
    userId = null,
    couponCode = null,
    couponType = WEEKLY_RESET_COUPON_TYPE,
    requestNo = null,
    confirmSideEffect = false,
  } = {}) {
    requireSideEffectConfirmation(confirmSideEffect);
    requireConfiguredPath(
      this.benefitCouponUsePath,
      "MISSING_BENEFIT_COUPON_USE_PATH",
      "Tabbit benefit coupon use endpoint is not configured.",
    );
    const finalUserId = requireUserId({ account, userId, purpose: "reset coupon use" });
    const cookie = requireSessionCookie(account, "reset coupon use");
    const body = {
      user_id: finalUserId,
      coupon_code: requireNonEmptyString(couponCode, "couponCode", "MISSING_COUPON_CODE"),
      coupon_type: requireNonEmptyString(couponType, "couponType", "MISSING_COUPON_TYPE"),
      request_no: requireRequestNo(requestNo),
    };
    const response = await this.fetch(this.buildUrl(this.benefitCouponUsePath), {
      method: "POST",
      headers: this.commerceContextJsonHeaders(cookie),
      body: JSON.stringify(body),
    });
    const responseBody = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, responseBody);
    return {
      ...normalizeCommerceObjectResponse(responseBody, "tabbit-reset-coupon-use", "reset coupon use"),
      evidence: {
        endpointHash: sha256Evidence(this.benefitCouponUsePath),
        bodyHash: sha256Evidence(body),
        resultHash: sha256Evidence(responseBody),
        safe: true,
        sanitized: true,
        rawPayload: false,
      },
    };
  }

  async participateActivity({
    account = {},
    body = null,
    confirmSideEffect = false,
  } = {}) {
    requireSideEffectConfirmation(confirmSideEffect);
    requireConfiguredPath(
      this.activityParticipatePath,
      "MISSING_ACTIVITY_PARTICIPATE_PATH",
      "Tabbit activity participate endpoint is not configured.",
    );
    const cookie = requireSessionCookie(account, "activity participate");
    const requestBody = requirePlainObjectInput(body, "body", "MISSING_ACTIVITY_PARTICIPATE_BODY");
    const response = await this.fetch(this.buildUrl(this.activityParticipatePath), {
      method: "POST",
      headers: this.commerceTraceJsonHeaders(cookie),
      body: JSON.stringify(requestBody),
    });
    const responseBody = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, responseBody);
    return normalizeCommerceObjectResponse(responseBody, "tabbit-activity-participate", "activity participate");
  }

  async getUsageResetCouponSku({ account = {} } = {}) {
    requireConfiguredPath(
      this.usageResetCouponSkuPath,
      "MISSING_USAGE_RESET_COUPON_SKU_PATH",
      "Tabbit usage reset coupon sku endpoint is not configured.",
    );
    const cookie = requireSessionCookie(account, "usage reset coupon sku");
    const response = await this.fetch(this.buildUrl(this.usageResetCouponSkuPath), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeCommerceObjectResponse(body, "tabbit-usage-reset-coupon-sku", "usage reset coupon sku");
  }

  async getAvailableLotteryChanceCount({
    account = {},
    userId = null,
    activityId = null,
  } = {}) {
    requireConfiguredPath(
      this.lotteryAvailableChancesPath,
      "MISSING_LOTTERY_AVAILABLE_CHANCES_PATH",
      "Tabbit lottery available chances endpoint is not configured.",
    );
    const finalUserId = requireUserId({ account, userId, purpose: "lottery available chances" });
    const finalActivityId = requireNonEmptyString(activityId, "activityId", "MISSING_ACTIVITY_ID");
    const cookie = requireSessionCookie(account, "lottery available chances");
    const response = await this.fetch(this.buildUrl(this.lotteryAvailableChancesPath, {
      user_id: finalUserId,
      activity_id: finalActivityId,
    }), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeCommerceObjectResponse(body, "tabbit-lottery-available-chances", "lottery available chances");
  }

  async getActiveMainPools({
    account = {},
    activityId = null,
  } = {}) {
    requireConfiguredPath(
      this.lotteryActiveMainPoolsPath,
      "MISSING_LOTTERY_ACTIVE_MAIN_POOLS_PATH",
      "Tabbit lottery active main pools endpoint is not configured.",
    );
    const finalActivityId = requireNonEmptyString(activityId, "activityId", "MISSING_ACTIVITY_ID");
    const cookie = requireSessionCookie(account, "lottery active main pools");
    const response = await this.fetch(this.buildUrl(this.lotteryActiveMainPoolsPath, {
      activity_id: finalActivityId,
    }), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeCommerceObjectResponse(body, "tabbit-lottery-active-main-pools", "lottery active main pools");
  }

  async listLotteryChanceRecords({
    account = {},
    activityId = null,
    offset = 0,
    limit = 20,
  } = {}) {
    requireConfiguredPath(
      this.lotteryChanceRecordsPath,
      "MISSING_LOTTERY_CHANCE_RECORDS_PATH",
      "Tabbit lottery chance records endpoint is not configured.",
    );
    const finalActivityId = requireNonEmptyString(activityId, "activityId", "MISSING_ACTIVITY_ID");
    const cookie = requireSessionCookie(account, "lottery chance records");
    const response = await this.fetch(this.buildUrl(this.lotteryChanceRecordsPath, {
      activity_id: finalActivityId,
      offset: normalizeNonNegativeIntegerInput(offset, 0, "offset"),
      limit: normalizeNonNegativeIntegerInput(limit, 20, "limit"),
    }), {
      method: "GET",
      headers: this.commerceReadOnlyHeaders(cookie),
    });
    const body = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, body);
    return normalizeRecordListResponse(body, "tabbit-lottery-chance-records");
  }

  async drawLottery({
    account = {},
    body = null,
    confirmSideEffect = false,
  } = {}) {
    requireSideEffectConfirmation(confirmSideEffect);
    requireConfiguredPath(
      this.lotteryDrawPath,
      "MISSING_LOTTERY_DRAW_PATH",
      "Tabbit lottery draw endpoint is not configured.",
    );
    const cookie = requireSessionCookie(account, "lottery draw");
    const requestBody = requirePlainObjectInput(body, "body", "MISSING_LOTTERY_DRAW_BODY");
    const response = await this.fetch(this.buildUrl(this.lotteryDrawPath), {
      method: "POST",
      headers: this.commerceTraceJsonHeaders(cookie),
      body: JSON.stringify(requestBody),
    });
    const responseBody = await parseBody(response);
    if (!response.ok) throw protocolResponseError(response, responseBody);
    return normalizeCommerceObjectResponse(responseBody, "tabbit-lottery-draw", "lottery draw");
  }

  async resolveRestoredAttachmentReferences({ account = {}, attachments = [] } = {}) {
    const normalized = [];
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      const existing = normalizeSingleAttachmentReference(attachment);
      if (existing) {
        normalized.push(existing);
        continue;
      }
      if (!this.attachmentCompleteUploadPath || !hasAttachmentPayload(attachment)) {
        return {
          ok: false,
          error: new ProtocolTabbitError("Attachments must be uploaded before sendMessage; provide path, file_id, fileId, id, or metadata.file_id.", {
            category: "unsupported_feature",
            code: "ATTACHMENT_REFERENCE_REQUIRED",
            retryable: false,
          }),
        };
      }
      const uploadResult = await this.uploadAttachment({ account, attachment });
      if (!uploadResult.ok) return uploadResult;
      const uploadedReference = normalizeSingleAttachmentReference(attachmentFromUploadResult(attachment, uploadResult));
      if (!uploadedReference) {
        return {
          ok: false,
          error: new ProtocolTabbitError("Uploaded attachment could not be converted into a Tabbit reference.", {
            category: "protocol_changed",
            code: "ATTACHMENT_REFERENCE_NORMALIZATION_FAILED",
            retryable: false,
          }),
        };
      }
      normalized.push(uploadedReference);
    }
    return { ok: true, references: normalized };
  }

  async sendMessage({ account = {}, model, messages = [], attachments = [], stream = false, tools = null, toolChoice = null, parallelToolCalls = null, chatSessionId = null, content = null, references = [], metadatas = null, entity = null, messageId = null, parallelGroupId = null, taskName = "chat", agentMode = false } = {}) {
    if (!this.sendPath) {
      return resultFromError(new ProtocolTabbitError("Tabbit send endpoint is not configured.", { category: "invalid_request", code: "MISSING_SEND_PATH", retryable: false }));
    }
    try {
      const restoredChatCompletion = usesRestoredChatCompletionProtocol(this.sendPath);
      if (restoredChatCompletion && hasNativeToolFields({ tools, toolChoice, parallelToolCalls })) {
        return resultFromError(new ProtocolTabbitError("Native tool fields are not calibrated for the restored Tabbit chat completion protocol.", {
          category: "unsupported_feature",
          code: "TOOL_FIELDS_UNSUPPORTED",
          retryable: false,
        }));
      }
      const attachmentReferenceResult = restoredChatCompletion
        ? await this.resolveRestoredAttachmentReferences({ account, attachments })
        : normalizeAttachmentReferences(attachments);
      if (!attachmentReferenceResult.ok) return resultFromError(attachmentReferenceResult.error);
      const body = restoredChatCompletion
        ? buildRealChatCompletionBody({
          account,
          defaultChatSessionId: this.defaultChatSessionId,
          chatSessionId,
          model,
          messages,
          content,
          references: [
            ...(Array.isArray(references) ? references : []),
            ...attachmentReferenceResult.references,
          ],
          metadatas,
          entity,
          messageId,
          parallelGroupId,
          taskName,
          agentMode,
        })
        : { model, messages, stream: Boolean(stream) };
      if (!restoredChatCompletion) {
        if (attachmentReferenceResult.references.length) {
          return resultFromError(new ProtocolTabbitError("Attachment references are only calibrated for the restored Tabbit chat completion protocol.", {
            category: "unsupported_feature",
            code: "ATTACHMENTS_UNSUPPORTED",
            retryable: false,
          }));
        }
        if (Array.isArray(tools)) body.tools = tools;
        if (toolChoice !== null && toolChoice !== undefined) body.tool_choice = toolChoice;
        if (parallelToolCalls !== null && parallelToolCalls !== undefined) body.parallel_tool_calls = Boolean(parallelToolCalls);
      }
      const bodyText = JSON.stringify(body);
      const signKey = await this.getSignKey();
      const timestamp = this.now();
      const headers = restoredChatCompletion
        ? {
          accept: "text/event-stream",
          "content-type": "application/json",
          "cache-control": "no-cache",
          ...(this.reqCtx ? { "x-req-ctx": this.reqCtx } : {}),
          "unique-uuid": this.uniqueUuid(),
          ...createSignedHeaders({ bodyText, signKey, timestamp, signature: this.signature() }),
        }
        : {
          "Content-Type": "application/json",
          ...createSignedHeaders({ method: "POST", path: this.sendPath, body, signKey, timestamp, nonce: this.nonce() }),
        };
      const cookie = account.cookie || account.cookieHeader;
      if (cookie) headers.Cookie = cookie;
      const response = await this.fetch(this.buildUrl(this.sendPath), { method: "POST", headers, body: bodyText });
      const contentType = response.headers?.get?.("content-type") || "";
      const streamFormat = stream ? streamFormatFromContentType(contentType) : null;
      if (response.ok && streamFormat && isReadableBody(response.body)) {
        return normalizeAsyncMessageResponse(response.body, streamFormat, restoredChatCompletion ? body.selected_model : model, {
          upstreamEvidence: restoredChatCompletion
            ? { source: "tabbit-live", real: true, stream: true, format: streamFormat }
            : null,
        });
      }
      const responseBody = await parseBody(response);
      if (!response.ok) return resultFromError(protocolResponseError(response, responseBody));
      return normalizeMessageResponse(responseBody, restoredChatCompletion ? body.selected_model : model);
    } catch (error) {
      return resultFromError(error);
    }
  }
}
