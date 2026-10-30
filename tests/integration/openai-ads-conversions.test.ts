import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@/lib/db/database", () => ({
  isDatabaseConfigured: () => true,
  queryDatabase: mocks.query,
}));
vi.mock("@/lib/clients/openai-ads", () => ({
  openAiAdsConfigurationIssue: () => null,
}));

import {
  claimOpenAiAdsConversions,
  enqueueOpenAiAdsConversion,
  markOpenAiAdsConversionDelivered,
  markOpenAiAdsConversionFailed,
} from "@/lib/services/openai-ads-conversions";

const connectionString = process.env.OPENAI_ADS_TEST_DATABASE_URL;
const store = "ads-fixture.myshopify.com";

describe.skipIf(!connectionString)("OpenAI Ads PostgreSQL outbox", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString });
    mocks.query.mockImplementation((sql, values) => pool.query(sql, values));
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM public.openai_ads_replay_requests");
    await pool.query("DELETE FROM public.openai_ads_conversions WHERE shopify_store=$1", [store]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("deduplicates concurrent paid-order captures", async () => {
    const captures = await Promise.all(
      Array.from({ length: 20 }, () =>
        enqueueOpenAiAdsConversion({
          shopifyStore: store,
          shopifyOrderId: "1001",
          occurredAt: new Date().toISOString(),
        })
      )
    );
    expect(new Set(captures.map((capture) => capture.eventId)).size).toBe(1);
    const count = await pool.query<{ count: string }>(
      "SELECT count(*) FROM public.openai_ads_conversions WHERE shopify_store=$1 AND shopify_order_id=$2",
      [store, "1001"]
    );
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("allows only one concurrent worker to claim a conversion", async () => {
    await enqueueOpenAiAdsConversion({
      shopifyStore: store,
      shopifyOrderId: "1002",
      occurredAt: new Date().toISOString(),
    });
    const claims = (
      await Promise.all([
        claimOpenAiAdsConversions({ limit: 1 }),
        claimOpenAiAdsConversions({ limit: 1 }),
      ])
    ).flat();
    expect(claims).toHaveLength(1);
    expect(claims[0].attempts).toBe(1);
  });

  it("reclaims an expired unknown attempt with the same provider identity", async () => {
    const conversion = await enqueueOpenAiAdsConversion({
      shopifyStore: store,
      shopifyOrderId: "1003",
      occurredAt: new Date().toISOString(),
    });
    const first = (await claimOpenAiAdsConversions({ limit: 1 }))[0];
    await pool.query(
      "UPDATE public.openai_ads_conversions SET lease_until=now()-interval '1 second' WHERE event_id=$1",
      [conversion.eventId]
    );
    const reclaimed = (await claimOpenAiAdsConversions({ limit: 1 }))[0];
    expect(reclaimed.eventId).toBe(first.eventId);
    expect(reclaimed.attempts).toBe(first.attempts);
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken);
    await markOpenAiAdsConversionDelivered({
      eventId: reclaimed.eventId,
      leaseToken: reclaimed.leaseToken,
      httpStatus: 202,
    });
  });

  it("moves retryable and permanent failures to distinct states", async () => {
    const retryable = await enqueueOpenAiAdsConversion({
      shopifyStore: store,
      shopifyOrderId: "1004",
      occurredAt: new Date().toISOString(),
    });
    const retryClaim = (await claimOpenAiAdsConversions({ limit: 1 }))[0];
    await expect(
      markOpenAiAdsConversionFailed({
        eventId: retryable.eventId,
        leaseToken: retryClaim.leaseToken,
        httpStatus: 429,
        terminal: false,
        retryDelaySeconds: 60,
        category: "rate_limited",
        error: "OpenAI Ads request returned HTTP 429",
      })
    ).resolves.toBe("retry_wait");

    const permanent = await enqueueOpenAiAdsConversion({
      shopifyStore: store,
      shopifyOrderId: "1005",
      occurredAt: new Date().toISOString(),
    });
    const permanentClaim = (await claimOpenAiAdsConversions({ limit: 1 }))[0];
    await expect(
      markOpenAiAdsConversionFailed({
        eventId: permanent.eventId,
        leaseToken: permanentClaim.leaseToken,
        httpStatus: 400,
        terminal: true,
        retryDelaySeconds: 0,
        category: "provider_rejected",
        error: "OpenAI Ads request returned HTTP 400",
      })
    ).resolves.toBe("permanent_failure");
  });
});
