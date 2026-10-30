import { config } from "@/lib/config";

const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_MS = 10 * 60 * 1000;

export type OpenAiAdsConfiguration = typeof config.openAiAds;

export class OpenAiAdsDeliveryError extends Error {
  constructor(
    message: string,
    readonly category: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = "OpenAiAdsDeliveryError";
  }
}

function safeEndpoint(settings: OpenAiAdsConfiguration): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(settings.endpoint);
  } catch {
    throw new OpenAiAdsDeliveryError(
      "OpenAI Ads endpoint configuration is invalid",
      "endpoint_invalid",
      false
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "bzr.openai.com" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "")
  ) {
    throw new OpenAiAdsDeliveryError(
      "OpenAI Ads endpoint configuration is not allowed",
      "endpoint_invalid",
      false
    );
  }
  if (!/^v[1-9][0-9]*$/.test(settings.apiVersion)) {
    throw new OpenAiAdsDeliveryError(
      "OpenAI Ads API version configuration is invalid",
      "api_version_invalid",
      false
    );
  }
  return endpoint;
}

export function openAiAdsConfigurationIssue(
  store: string,
  settings: OpenAiAdsConfiguration = config.openAiAds
): string | null {
  if (!settings.enabled) return "integration_disabled";
  if (!settings.allowedStore) return "allowed_store_missing";
  if (store.toLowerCase() !== settings.allowedStore) return "store_not_allowed";
  if (!settings.pixelId) return "pixel_id_missing";
  if (!settings.conversionsApiKey) return "api_key_missing";
  if (!settings.sourceUrl) return "source_url_missing";
  try {
    safeEndpoint(settings);
    const sourceUrl = new URL(settings.sourceUrl);
    if (sourceUrl.protocol !== "https:") return "source_url_invalid";
  } catch (error) {
    if (error instanceof OpenAiAdsDeliveryError) return error.category;
    return "source_url_invalid";
  }
  return null;
}

export function toOpenAiAdsTimestampMs(at: string, now = Date.now()): number {
  const parsed = Date.parse(at);
  if (!at || Number.isNaN(parsed)) {
    throw new OpenAiAdsDeliveryError(
      "OpenAI Ads conversion timestamp is invalid",
      "timestamp_invalid",
      false
    );
  }
  if (parsed < now - MAX_EVENT_AGE_MS) {
    throw new OpenAiAdsDeliveryError(
      "OpenAI Ads conversion timestamp is too old",
      "timestamp_too_old",
      false
    );
  }
  if (parsed > now + MAX_EVENT_FUTURE_MS) {
    throw new OpenAiAdsDeliveryError(
      "OpenAI Ads conversion timestamp is in the future",
      "timestamp_in_future",
      false
    );
  }
  return parsed;
}

export function openAiAdsErrorStatus(error: unknown): number | undefined {
  if (error instanceof OpenAiAdsDeliveryError) return error.status;
  return undefined;
}

export function openAiAdsErrorCategory(error: unknown): string {
  if (error instanceof OpenAiAdsDeliveryError) return error.category;
  return "network_error";
}

export function isRetryableOpenAiAdsError(error: unknown): boolean {
  return error instanceof OpenAiAdsDeliveryError ? error.retryable : true;
}

export function sanitizeOpenAiAdsError(error: unknown): string {
  return String(error instanceof Error ? error.message : "OpenAI Ads delivery failed")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/([?&](?:key|token|secret|api_key)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 1000);
}

export async function sendOpenAiAdsOrderCreatedConversion(
  {
    eventId,
    occurredAt,
    shopifyStore,
  }: {
    eventId: string;
    occurredAt: string;
    shopifyStore: string;
  },
  settings: OpenAiAdsConfiguration = config.openAiAds,
  fetchImplementation: typeof fetch = fetch
): Promise<number> {
  const issue = openAiAdsConfigurationIssue(shopifyStore, settings);
  if (issue) {
    throw new OpenAiAdsDeliveryError(
      "OpenAI Ads delivery configuration is incomplete",
      issue,
      false
    );
  }

  const endpoint = safeEndpoint(settings);
  endpoint.pathname = `/${settings.apiVersion}/events`;
  endpoint.searchParams.set("pid", settings.pixelId);

  let response: Response;
  try {
    response = await fetchImplementation(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${settings.conversionsApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        validate_only: false,
        integration_source: "battle_bus",
        events: [
          {
            id: eventId,
            type: "order_created",
            timestamp_ms: toOpenAiAdsTimestampMs(occurredAt),
            source_url: settings.sourceUrl,
            action_source: "web",
            data: { type: "contents" },
          },
        ],
      }),
    });
  } catch (error) {
    throw new OpenAiAdsDeliveryError(
      error instanceof DOMException && error.name === "TimeoutError"
        ? "OpenAI Ads request timed out"
        : "OpenAI Ads network request failed",
      error instanceof DOMException && error.name === "TimeoutError"
        ? "request_timeout"
        : "network_error",
      true
    );
  }

  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    const category =
      response.status === 408
        ? "request_timeout"
        : response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "provider_unavailable"
            : response.status === 401 || response.status === 403
              ? "authentication_rejected"
              : "provider_rejected";
    // Do not read or persist provider response bodies: they may contain reflected identifiers.
    response.body?.cancel().catch(() => undefined);
    throw new OpenAiAdsDeliveryError(
      `OpenAI Ads request returned HTTP ${response.status}`,
      category,
      retryable,
      response.status
    );
  }

  response.body?.cancel().catch(() => undefined);
  return response.status;
}
