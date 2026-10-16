import { WebhookSchemaError } from "@/lib/webhooks/schema-registry";

export type DeliveryErrorClass =
  | "transient_network"
  | "rate_limited"
  | "dependency_unavailable"
  | "authentication"
  | "validation"
  | "conflict"
  | "unknown";

export type DeliveryRecoveryAction =
  | "retry"
  | "retry_after"
  | "refresh_credentials"
  | "manual_review"
  | "reconcile";

export type ClassifiedDeliveryError = {
  message: string;
  errorClass: DeliveryErrorClass;
  recoveryAction: DeliveryRecoveryAction;
  terminal: boolean;
  retryDelaySeconds: number;
};

type ErrorLike = {
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  retryAfter?: unknown;
  response?: {
    status?: unknown;
    headers?: { get?: (name: string) => string | null } | Record<string, unknown>;
  };
};

const MAX_DELIVERY_ATTEMPTS = 10;

function statusCode(error: ErrorLike): number | undefined {
  const raw = error.status ?? error.statusCode ?? error.response?.status;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function retryAfterSeconds(error: ErrorLike): number | undefined {
  let raw = error.retryAfter;
  const headers = error.response?.headers;
  if (raw == null && headers && typeof headers === "object") {
    if ("get" in headers && typeof headers.get === "function") {
      raw = headers.get("retry-after");
    } else {
      raw = (headers as Record<string, unknown>)["retry-after"];
    }
  }
  if (raw == null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(String(raw));
  if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

function backoffSeconds(attempt: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
}

export function classifyDeliveryError(
  error: unknown,
  attempt: number
): ClassifiedDeliveryError {
  const value = (error && typeof error === "object" ? error : {}) as ErrorLike;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const status = statusCode(value);
  const exhausted = attempt >= MAX_DELIVERY_ATTEMPTS;
  const retryDelay = backoffSeconds(attempt);

  if (error instanceof WebhookSchemaError || status === 400 || status === 404 || status === 422) {
    return {
      message,
      errorClass: "validation",
      recoveryAction: "manual_review",
      terminal: true,
      retryDelaySeconds: retryDelay,
    };
  }
  if (status === 401 || status === 403) {
    return {
      message,
      errorClass: "authentication",
      recoveryAction: "refresh_credentials",
      terminal: true,
      retryDelaySeconds: retryDelay,
    };
  }
  if (status === 429 || normalized.includes("rate limit")) {
    return {
      message,
      errorClass: "rate_limited",
      recoveryAction: exhausted ? "manual_review" : "retry_after",
      terminal: exhausted,
      retryDelaySeconds: Math.min(3600, retryAfterSeconds(value) ?? retryDelay),
    };
  }
  if (status === 409 || normalized.includes("conflict")) {
    return {
      message,
      errorClass: "conflict",
      recoveryAction: exhausted ? "manual_review" : "reconcile",
      terminal: exhausted,
      retryDelaySeconds: retryDelay,
    };
  }
  if (
    status === 408 ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econn") ||
    normalized.includes("network") ||
    normalized.includes("socket")
  ) {
    return {
      message,
      errorClass: "transient_network",
      recoveryAction: exhausted ? "manual_review" : "retry",
      terminal: exhausted,
      retryDelaySeconds: retryDelay,
    };
  }
  if ((status != null && status >= 500) || normalized.includes("unavailable")) {
    return {
      message,
      errorClass: "dependency_unavailable",
      recoveryAction: exhausted ? "manual_review" : "retry",
      terminal: exhausted,
      retryDelaySeconds: retryDelay,
    };
  }
  return {
    message,
    errorClass: "unknown",
    recoveryAction: exhausted ? "manual_review" : "retry",
    terminal: exhausted,
    retryDelaySeconds: retryDelay,
  };
}
