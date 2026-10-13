import { describe, expect, it } from "vitest";

import {
  OpenAiAdsHttpError,
  OpenAiAdsPermanentError,
  isRetryableOpenAiAdsError,
  sanitizeOpenAiAdsError,
  toOpenAiAdsTimestampMs,
} from "../openai-ads";

describe("OpenAI Ads conversions", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");

  it("accepts timestamps within the seven-day delivery window", () => {
    expect(toOpenAiAdsTimestampMs("2026-10-12T12:00:00.000Z", now)).toBe(
      Date.parse("2026-10-12T12:00:00.000Z")
    );
  });

  it("rejects stale and far-future timestamps permanently", () => {
    expect(() => toOpenAiAdsTimestampMs("2026-10-01T12:00:00.000Z", now)).toThrow(
      OpenAiAdsPermanentError
    );
    expect(() => toOpenAiAdsTimestampMs("2026-10-13T12:11:00.000Z", now)).toThrow(
      OpenAiAdsPermanentError
    );
  });

  it("retries network, timeout, throttling, and server failures only", () => {
    expect(isRetryableOpenAiAdsError(new Error("network unavailable"))).toBe(true);
    expect(isRetryableOpenAiAdsError(new OpenAiAdsHttpError("timeout", 408))).toBe(true);
    expect(isRetryableOpenAiAdsError(new OpenAiAdsHttpError("throttled", 429))).toBe(true);
    expect(isRetryableOpenAiAdsError(new OpenAiAdsHttpError("server", 503))).toBe(true);
    expect(isRetryableOpenAiAdsError(new OpenAiAdsHttpError("bad request", 400))).toBe(false);
    expect(isRetryableOpenAiAdsError(new OpenAiAdsPermanentError("invalid config"))).toBe(false);
  });

  it("redacts bearer credentials from persisted errors", () => {
    expect(sanitizeOpenAiAdsError(new Error("failed Bearer secret-token"))).toBe(
      "failed Bearer [redacted]"
    );
  });
});
