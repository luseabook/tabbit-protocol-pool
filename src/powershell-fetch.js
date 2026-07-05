import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputJson = [Console]::In.ReadToEnd()
$request = $inputJson | ConvertFrom-Json
$headers = @{}
if ($request.headers) {
  foreach ($property in $request.headers.PSObject.Properties) {
    if ($null -ne $property.Value) {
      $headers[$property.Name] = [string]$property.Value
    }
  }
}
$params = @{
  Uri = [string]$request.url
  Method = [string]$request.method
  Headers = $headers
  MaximumRedirection = 0
  SkipHttpErrorCheck = $true
}
if ($request.bodyBase64) {
  $params.Body = [Convert]::FromBase64String([string]$request.bodyBase64)
}
$response = Invoke-WebRequest @params
$responseHeaders = @{}
foreach ($key in $response.Headers.Keys) {
  $value = $response.Headers[$key]
  if ($value -is [array]) {
    $responseHeaders[$key] = @($value | ForEach-Object { [string]$_ })
  } else {
    $responseHeaders[$key] = @([string]$value)
  }
}
if ($response.Content -is [byte[]]) {
  $bodyBytes = $response.Content
} else {
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$response.Content)
}
[pscustomobject]@{
  status = [int]$response.StatusCode
  headers = $responseHeaders
  bodyBase64 = [Convert]::ToBase64String($bodyBytes)
} | ConvertTo-Json -Compress -Depth 8
`;

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT];

export class PowerShellFetchError extends Error {
  constructor(message, { code = "POWERSHELL_FETCH_FAILED" } = {}) {
    super(message);
    this.name = "PowerShellFetchError";
    this.code = code;
  }
}

function normalizeHeaderEntries(headers = {}) {
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) return headers;
  if (headers && typeof headers === "object") return Object.entries(headers);
  return [];
}

function normalizeHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of normalizeHeaderEntries(headers)) {
    if (!key || value === undefined || value === null) continue;
    normalized[String(key)] = String(value);
  }
  return normalized;
}

async function bodyToBase64(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8").toString("base64");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8").toString("base64");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("base64");
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("base64");
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer()).toString("base64");
  }
  throw new PowerShellFetchError("PowerShell fetch does not support this request body type", { code: "UNSUPPORTED_BODY" });
}

function responseHeadersFromObject(headers = {}) {
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(key, String(item));
    } else if (value !== undefined && value !== null) {
      responseHeaders.append(key, String(value));
    }
  }
  return responseHeaders;
}

function responseBodyFromBase64(bodyBase64, status) {
  if (status === 204 || status === 304) return null;
  return Buffer.from(String(bodyBase64 || ""), "base64");
}

function inputUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input.url === "string") return input.url;
  return String(input);
}

function inputMethod(input, options = {}) {
  return String(options.method || input?.method || "GET").toUpperCase();
}

function inputHeaders(input, options = {}) {
  return normalizeHeaders(options.headers || input?.headers || {});
}

export async function runPowerShellProcess({ command, args, input, timeoutMs }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        settled = true;
        child.kill();
        reject(new PowerShellFetchError("PowerShell fetch failed (timeout)", { code: "POWERSHELL_FETCH_TIMEOUT" }));
      }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(new PowerShellFetchError(`PowerShell fetch failed (${error.code || "spawn_error"})`));
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

export function createPowerShellFetch({
  command = "pwsh",
  timeoutMs = 30_000,
  runPowerShell = runPowerShellProcess,
} = {}) {
  return async function powerShellFetch(input, options = {}) {
    const request = {
      url: inputUrl(input),
      method: inputMethod(input, options),
      headers: inputHeaders(input, options),
      bodyBase64: await bodyToBase64(options.body),
    };
    const invocation = {
      command,
      args: POWERSHELL_ARGS,
      input: JSON.stringify(request),
      timeoutMs,
    };
    const result = await runPowerShell(invocation);
    if (result.status !== 0) {
      throw new PowerShellFetchError(`PowerShell fetch failed (exit ${result.status ?? "unknown"})`);
    }

    let parsed;
    try {
      parsed = JSON.parse(String(result.stdout || ""));
    } catch {
      throw new PowerShellFetchError("PowerShell fetch failed (invalid child output)");
    }

    const status = Number(parsed.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new PowerShellFetchError("PowerShell fetch failed (invalid status)");
    }

    return new Response(responseBodyFromBase64(parsed.bodyBase64, status), {
      status,
      headers: responseHeadersFromObject(parsed.headers),
    });
  };
}

export const powershellFetch = createPowerShellFetch();
