import {
  ChannelLiftError,
  channelLiftDigest,
  reconcileAttributionCounts,
  validateReportingDate,
  validateShopifyOrderId,
  type AttributionCounts,
  type AttributionRow,
} from "@/lib/channel-lift/model";

const ENDPOINT = "https://api.triplewhale.com/api/v2/orcabase/api/sql";
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

type TripleWhaleDependencies = {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
};

const defaultDependencies: TripleWhaleDependencies = {
  fetch: globalThis.fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export type TripleWhaleAttributionConfig = {
  shopId: string;
  reportingDate: string;
  pageSize: number;
};

function responseRows(value: unknown): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  ) {
    throw new ChannelLiftError("triple_whale_response_shape");
  }
  return value as Record<string, unknown>[];
}

function parseCount(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) {
    throw new ChannelLiftError("triple_whale_aggregate_invalid");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ChannelLiftError("triple_whale_aggregate_invalid");
  }
  return count;
}

function parseCounts(rows: Record<string, unknown>[]): AttributionCounts {
  if (rows.length !== 1) throw new ChannelLiftError("triple_whale_aggregate_shape");
  return {
    rows: parseCount(rows[0].rows),
    orders: parseCount(rows[0].orders),
    pairs: parseCount(rows[0].pairs),
  };
}

export async function readTripleWhaleAttribution(
  input: TripleWhaleAttributionConfig & { apiKey: string },
  dependencies: TripleWhaleDependencies = defaultDependencies
): Promise<{
  rows: AttributionRow[];
  counts: AttributionCounts;
  configHash: string;
  snapshotHash: string;
}> {
  const reportingDate = validateReportingDate(input.reportingDate);
  if (!input.shopId || input.shopId.length > 253 || !input.apiKey) {
    throw new ChannelLiftError("triple_whale_configuration_invalid");
  }
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 50_000) {
    throw new ChannelLiftError("triple_whale_page_size_invalid");
  }

  const where =
    "event_date BETWEEN @startDate AND @endDate AND (model = 'Triple Attribution' AND attribution_window = 'lifetime')";
  const from = `FROM pixel_orders_table WHERE ${where}`;
  const baseSql = `SELECT order_id, channel, event_date ${from} ORDER BY order_id, channel, event_date LIMIT ${input.pageSize}`;
  const countSql = `SELECT COUNT(*) AS rows, COUNT(DISTINCT order_id) AS orders, COUNT(DISTINCT tuple(order_id, channel)) AS pairs ${from}`;

  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await dependencies.fetch(ENDPOINT, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { "Content-Type": "application/json", "x-api-key": input.apiKey },
          body: JSON.stringify({
            shopId: input.shopId,
            query: sql,
            period: { startDate: reportingDate, endDate: reportingDate },
          }),
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
            throw new ChannelLiftError(
              response.status === 429
                ? "triple_whale_rate_limited"
                : response.status >= 500
                  ? "triple_whale_unavailable"
                  : "triple_whale_rejected",
              retryable
            );
          }
          await dependencies.sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        return responseRows(await response.json());
      } catch (error) {
        if (error instanceof ChannelLiftError) throw error;
        if (attempt >= RETRY_DELAYS_MS.length) {
          throw new ChannelLiftError("triple_whale_network_error", true);
        }
        await dependencies.sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  };

  const counts = parseCounts(await query(countSql));
  const rows: AttributionRow[] = [];
  for (let offset = 0; offset < counts.rows; offset += input.pageSize) {
    const page = await query(`${baseSql} OFFSET ${offset}`);
    if (page.length > input.pageSize) throw new ChannelLiftError("triple_whale_page_oversized");
    for (const row of page) {
      if (row.channel !== null && typeof row.channel !== "string") {
        throw new ChannelLiftError("triple_whale_channel_invalid");
      }
      if (typeof row.event_date !== "string" || row.event_date.slice(0, 10) !== reportingDate) {
        throw new ChannelLiftError("triple_whale_period_mismatch");
      }
      rows.push({
        orderId: validateShopifyOrderId(row.order_id),
        channel: row.channel as string | null,
        eventDate: row.event_date,
      });
    }
    if (rows.length > counts.rows) throw new ChannelLiftError("extraction_count_mismatch");
    if (page.length < input.pageSize) break;
  }

  reconcileAttributionCounts(rows, counts);
  const snapshot = rows.map((row) => JSON.stringify(row)).sort();
  return {
    rows,
    counts,
    configHash: channelLiftDigest({
      shopId: input.shopId,
      reportingDate,
      pageSize: input.pageSize,
      baseSql,
      countSql,
    }),
    snapshotHash: channelLiftDigest(snapshot),
  };
}
