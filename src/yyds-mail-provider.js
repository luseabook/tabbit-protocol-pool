export class MailProviderError extends Error {
  constructor(message, { code = "MAIL_PROVIDER_ERROR", status = null, retryAfterMs = null, detail = null } = {}) {
    super(message);
    this.name = "MailProviderError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.detail = detail;
  }
}

const DEFAULT_BASE_URL = "https://maliapi.215.im/v1";

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""),
  );
}

function parseRetryAfter(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

async function parseResponseBody(response) {
  try {
    return await response.json();
  } catch {
    try {
      const text = await response.text();
      return text ? { text } : {};
    } catch {
      return {};
    }
  }
}

function unwrapPayload(body, keys) {
  for (const key of keys) {
    if (body && typeof body === "object" && body[key] !== undefined) {
      return body[key];
    }
  }
  return body;
}

function normalizeInbox(body) {
  const payload = unwrapPayload(body, ["account", "data", "inbox"]);
  return {
    id: String(payload?.id ?? payload?.accountId ?? payload?.address ?? ""),
    address: String(payload?.address ?? payload?.email ?? ""),
    ...(payload?.token || payload?.tempToken || payload?.accessToken
      ? { tempToken: payload.token || payload.tempToken || payload.accessToken }
      : {}),
    ...(payload?.expiresAt || payload?.expires_at ? { expiresAt: payload.expiresAt || payload.expires_at } : {}),
  };
}

function normalizeList(body) {
  const payload = unwrapPayload(body, ["messages", "data", "items"]);
  return Array.isArray(payload) ? payload : [];
}

function normalizeMessage(body) {
  return unwrapPayload(body, ["message", "data"]);
}

function normalizeSource(body) {
  const payload = unwrapPayload(body, ["source", "raw", "data"]);
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object") {
    return payload.raw || payload.source || payload.text || JSON.stringify(payload);
  }
  return "";
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function findCodes(text) {
  const candidates = new Set();
  const pattern = /(?:^|\D)((?:\d[\s-]?){4,8})(?!\d)/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) {
    const code = match[1].replace(/\D/g, "");
    if (code.length >= 4 && code.length <= 8) {
      candidates.add(code);
    }
  }
  return [...candidates];
}

export function extractVerificationCode(message) {
  const sources = [
    ["subject", message?.subject],
    ["text", message?.text || message?.body],
    ["html", htmlToText(message?.html)],
    ["raw", message?.raw || message?.source],
  ];

  for (const [source, value] of sources) {
    const codes = findCodes(value);
    if (codes.length === 1) {
      return { code: codes[0], source };
    }
    if (codes.length > 1) {
      throw new MailProviderError(`ambiguous verification code in ${source}`, {
        code: "AMBIGUOUS_CODE",
        detail: { source, count: codes.length },
      });
    }
  }

  throw new MailProviderError("verification code not found", { code: "CODE_NOT_FOUND" });
}

export class YYDSMailProvider {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetch: fetchImpl = globalThis.fetch, sleep = null } = {}) {
    if (!apiKey) {
      throw new MailProviderError("YYDS Mail API key is required", { code: "MISSING_API_KEY" });
    }
    if (typeof fetchImpl !== "function") {
      throw new MailProviderError("fetch implementation is required", { code: "MISSING_FETCH" });
    }

    this.apiKey = apiKey;
    this.baseUrl = trimTrailingSlash(baseUrl);
    this.fetch = fetchImpl;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  buildUrl(path, query = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request(path, { method = "GET", query, body } = {}) {
    const headers = {
      "X-API-Key": this.apiKey,
    };
    const options = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await this.fetch(this.buildUrl(path, query), options);
    const responseBody = await parseResponseBody(response);
    if (!response.ok || responseBody?.success === false) {
      throw new MailProviderError(responseBody?.error || `YYDS Mail request failed with ${response.status}`, {
        code: responseBody?.errorCode || (response.status === 429 ? "RATE_LIMITED" : "HTTP_ERROR"),
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers?.get?.("Retry-After")),
        detail: responseBody,
      });
    }

    return responseBody;
  }

  async createInbox({ localPart, domain, subdomain } = {}) {
    const body = compactObject({ localPart, domain, subdomain });
    const response = await this.request("/accounts", { method: "POST", body });
    return normalizeInbox(response);
  }

  async listMessages(address) {
    const response = await this.request("/messages", { query: { address } });
    return normalizeList(response);
  }

  async getMessage(id, address) {
    const response = await this.request(`/messages/${encodeURIComponent(id)}`, { query: { address } });
    return normalizeMessage(response);
  }

  async getSource(id, address) {
    const response = await this.request(`/sources/${encodeURIComponent(id)}`, { query: { address } });
    return normalizeSource(response);
  }

  async waitForVerificationCode({ address, timeoutMs = 60_000, intervalMs = 2_000 } = {}) {
    if (!address) {
      throw new MailProviderError("address is required", { code: "MISSING_ADDRESS" });
    }

    const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs)));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const messages = await this.listMessages(address);
      for (const summary of messages) {
        const id = summary?.id || summary?.messageId;
        const message = id ? await this.getMessage(id, address) : summary;
        try {
          const extracted = extractVerificationCode(message);
          return { ...extracted, message };
        } catch (error) {
          if (!(error instanceof MailProviderError) || error.code !== "CODE_NOT_FOUND") {
            throw error;
          }
        }

        if (id) {
          const raw = await this.getSource(id, address);
          try {
            const extracted = extractVerificationCode({ ...message, raw });
            return { ...extracted, message: { ...message, raw } };
          } catch (error) {
            if (!(error instanceof MailProviderError) || error.code !== "CODE_NOT_FOUND") {
              throw error;
            }
          }
        }
      }

      if (attempt < attempts - 1) {
        await this.sleep(intervalMs);
      }
    }

    throw new MailProviderError("Timed out waiting for verification code", { code: "MAIL_TIMEOUT" });
  }
}
