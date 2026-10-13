import { config } from "@/lib/config";

const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_MS = 10 * 60 * 1000;

export class OpenAiAdsPermanentError extends Error {}

export class OpenAiAdsHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export function toOpenAiAdsTimestampMs(at: string, now = Date.now()): number {
  if (!at) throw new OpenAiAdsPermanentError("OpenAI Ads conversion timestamp missing");
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) {
    throw new OpenAiAdsPermanentError(`Invalid OpenAI Ads conversion timestamp: ${at}`);
  }
  if (parsed < now - MAX_EVENT_AGE_MS) {
    throw new OpenAiAdsPermanentError(
      `OpenAI Ads conversion timestamp is older than 7 days: ${at}`
    );
  }
  if (parsed > now + MAX_EVENT_FUTURE_MS) {
    throw new OpenAiAdsPermanentError(
      `OpenAI Ads conversion timestamp is more than 10 minutes in the future: ${at}`
    );
  }
  return parsed;
}

export function openAiAdsErrorStatus(error: unknown): number | undefined {
  if (error instanceof OpenAiAdsHttpError) return error.status;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  const parsed = Number(candidate?.status ?? candidate?.statusCode);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isRetryableOpenAiAdsError(error: unknown): boolean {
  if (error instanceof OpenAiAdsPermanentError) return false;
  const status = openAiAdsErrorStatus(error);
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

export function sanitizeOpenAiAdsError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

export async function sendOpenAiAdsOrderCreatedConversion({
  eventId,
  occurredAt,
}: {
  eventId: string;
  occurredAt: string;
}): Promise<number> {
  const { pixelId, conversionsApiKey, sourceUrl } = config.openAiAds;
  if (!pixelId) throw new OpenAiAdsPermanentError("OpenAI Ads pixel ID not configured");
  if (!conversionsApiKey) {
    throw new OpenAiAdsPermanentError("OpenAI Ads Conversions API key not configured");
  }
  if (!sourceUrl) throw new OpenAiAdsPermanentError("OpenAI Ads source URL not configured");

  const response = await fetch(
    `https://bzr.openai.com/v1/events?pid=${encodeURIComponent(pixelId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${conversionsApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        validate_only: false,
        events: [
          {
            id: eventId,
            type: "order_created",
            timestamp_ms: toOpenAiAdsTimestampMs(occurredAt),
            source_url: sourceUrl,
            action_source: "web",
            data: { type: "contents" },
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 500);
    throw new OpenAiAdsHttpError(
      `OpenAI Ads delivery failed (${response.status}): ${responseText}`,
      response.status
    );
  }
  return response.status;
}
