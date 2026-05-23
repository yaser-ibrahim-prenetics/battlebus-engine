/**
 * Sanitize and truncate D365 HTTP request/response bodies for flow logs and console traces.
 */

const DEFAULT_MAX_CHARS = 16_000;

const _maxCharsParsed = parseInt(process.env.D365_HTTP_LOG_MAX_CHARS || "", 10);
export const D365_HTTP_LOG_MAX_CHARS = Math.max(
  500,
  Number.isNaN(_maxCharsParsed) ? DEFAULT_MAX_CHARS : _maxCharsParsed
);

const SENSITIVE_KEYS = new Set([
  "authorization",
  "client_secret",
  "access_token",
  "refresh_token",
  "id_token",
  "password",
  "token",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) {
    return "[REDACTED]";
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(String(index), item));
  }

  if (isPlainObject(value)) {
    return redactObject(value);
  }

  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = redactValue(key, value);
  }
  return out;
}

export function truncateForLog(value: string, maxChars = D365_HTTP_LOG_MAX_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}… [truncated ${value.length - maxChars} chars]`;
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

export function normalizeBodyForLog(body: unknown, maxChars = D365_HTTP_LOG_MAX_CHARS): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }

  let normalized: unknown = body;

  if (typeof body === "string") {
    normalized = parseMaybeJson(body);
  } else if (body instanceof URLSearchParams) {
    normalized = Object.fromEntries(body.entries());
  } else if (typeof body === "object" && body !== null && typeof (body as Blob).text === "function") {
    normalized = "[binary body omitted]";
  }

  if (isPlainObject(normalized)) {
    normalized = redactObject(normalized);
  } else if (Array.isArray(normalized)) {
    normalized = normalized.map((item, index) => redactValue(String(index), item));
  } else if (typeof normalized === "string") {
    normalized = truncateForLog(normalized, maxChars);
  }

  const serialized = typeof normalized === "string" ? normalized : JSON.stringify(normalized);
  if (serialized.length > maxChars) {
    return truncateForLog(serialized, maxChars);
  }

  return normalized;
}

export async function readResponseBodyForLog(
  response: Response,
  maxChars = D365_HTTP_LOG_MAX_CHARS
): Promise<unknown> {
  try {
    const text = await response.clone().text();
    return normalizeBodyForLog(text, maxChars);
  } catch (err) {
    return {
      _readError: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function logD365HttpTrace(fields: {
  method: string;
  url: string;
  httpStatus?: number;
  durationMs: number;
  requestBody?: unknown;
  responseBody?: unknown;
  errorMessage?: string;
  source?: "d365_api" | "d365_auth";
}): void {
  console.log(
    JSON.stringify({
      msg: "D365HttpTrace",
      source: fields.source || "d365_api",
      method: fields.method,
      url: fields.url,
      httpStatus: fields.httpStatus,
      durationMs: fields.durationMs,
      request: fields.requestBody,
      response: fields.responseBody,
      errorMessage: fields.errorMessage,
    })
  );
}
