import { createHash } from "node:crypto";

const API_KEY_PATTERN = /\bAC-[A-Za-z0-9._-]{4,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const COOKIE_ASSIGNMENT_PATTERN = /((?:[A-Za-z0-9_.-]*(?:cookie|session|token)[A-Za-z0-9_.-]*)=)[^;\s]+/gi;
const EMAIL_PATTERN = /\b([A-Z0-9._%+-]{1,})@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const VERIFICATION_CODE_PATTERN = /\b(verification\s+code|code|验证码)([^0-9]{0,20})([0-9](?:[0-9\s-]{2,12})[0-9])\b/gi;

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function redactEmail(_match, localPart, domain) {
  const prefix = localPart.slice(0, Math.min(2, localPart.length));
  return `${prefix}***@${domain.toLowerCase()}`;
}

export function redactSensitiveValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  let text = String(value);
  text = text.replace(API_KEY_PATTERN, "AC-***");
  text = text.replace(BEARER_PATTERN, "Bearer ***");
  text = text.replace(COOKIE_ASSIGNMENT_PATTERN, "$1***");
  text = text.replace(EMAIL_PATTERN, redactEmail);
  text = text.replace(VERIFICATION_CODE_PATTERN, (_match, label, separator) => `${label}${separator}***`);
  return text;
}

function isSensitiveKey(key) {
  return /(api[_-]?key|authorization|cookie|session|token|verification|code|password|secret)/i.test(key);
}

export function redactObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (typeof item === "string" && isSensitiveKey(key)) {
          return [key, redactSensitiveValue(item)];
        }
        return [key, redactObject(item)];
      }),
    );
  }

  if (typeof value === "string") {
    return redactSensitiveValue(value);
  }

  return value;
}

export function fingerprintSensitiveValue(value) {
  return `sha256:${stableHash(value)}`;
}
