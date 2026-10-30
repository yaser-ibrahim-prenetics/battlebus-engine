import {
  ChannelLiftError,
  channelLiftDigest,
  reconcileAttributionCounts,
  validateReportingDate,
  validateShopifyOrderId,
  type AttributionCounts,
  type AttributionRow,
} from "@/lib/channel-lift/model";
import { withBoundedChannelLiftRetry } from "@/lib/clients/channel-lift-retry";

const ENDPOINT = "https://api.triplewhale.com/api/v2/orcabase/api/sql";
const HARD_MAX_ATTRIBUTION_ROWS = 250_000;
const MAX_ATTRIBUTION_PAGES = 1_000;

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
  maxRows?: number;
};

type TripleWhaleCredentials = {
  shopId: string;
  reportingDate: string;
  apiKey: string;
};

const ATTRIBUTION_WHERE =
  "event_date BETWEEN @startDate AND @endDate AND (model = 'Triple Attribution' AND attribution_window = 'lifetime')";

function attributionSql(pageSize: number): { baseSql: string; countSql: string } {
  const from = `FROM pixel_orders_table WHERE ${ATTRIBUTION_WHERE}`;
  return {
    baseSql: `SELECT order_id, channel, event_date ${from} ORDER BY order_id, channel, event_date LIMIT ${pageSize}`,
    countSql: `SELECT COUNT(*) AS rows, COUNT(DISTINCT order_id) AS orders, COUNT(DISTINCT tuple(order_id, channel)) AS pairs ${from}`,
  };
}

function validateCredentials(input: TripleWhaleCredentials): string {
  const reportingDate = validateReportingDate(input.reportingDate);
  if (!input.shopId || input.shopId.length > 253 || !input.apiKey) {
    throw new ChannelLiftError("triple_whale_configuration_invalid");
  }
  return reportingDate;
}

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

async function queryTripleWhale(
  input: TripleWhaleCredentials,
  sql: string,
  dependencies: TripleWhaleDependencies
): Promise<Record<string, unknown>[]> {
  const reportingDate = validateCredentials(input);
  return withBoundedChannelLiftRetry({
    operation: async () => {
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
        throw new ChannelLiftError(
          response.status === 429
            ? "triple_whale_rate_limited"
            : response.status >= 500
              ? "triple_whale_unavailable"
              : "triple_whale_rejected",
          retryable
        );
      }
      return responseRows(await response.json());
    },
    normalizeError: (error) =>
      error instanceof ChannelLiftError
        ? error
        : new ChannelLiftError("triple_whale_network_error", true),
    sleep: dependencies.sleep,
  });
}

export function tripleWhaleAttributionConfigHash(input: TripleWhaleAttributionConfig): string {
  const reportingDate = validateReportingDate(input.reportingDate);
  const { baseSql, countSql } = attributionSql(input.pageSize);
  return channelLiftDigest({
    shopId: input.shopId,
    reportingDate,
    pageSize: input.pageSize,
    baseSql,
    countSql,
  });
}

export async function readTripleWhaleAttributionCounts(
  input: TripleWhaleCredentials,
  dependencies: TripleWhaleDependencies = defaultDependencies
): Promise<AttributionCounts> {
  const { countSql } = attributionSql(1);
  return parseCounts(await queryTripleWhale(input, countSql, dependencies));
}

export async function readTripleWhaleMappedPairPage(
  input: TripleWhaleCredentials & {
    sourceChannels: readonly string[];
    offset: number;
    limit: number;
  },
  dependencies: TripleWhaleDependencies = defaultDependencies
): Promise<AttributionRow[]> {
  const reportingDate = validateCredentials(input);
  if (
    input.sourceChannels.length < 1 ||
    input.sourceChannels.some((channel) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(channel)) ||
    !Number.isInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 500
  ) {
    throw new ChannelLiftError("triple_whale_pair_page_invalid");
  }
  const channelList = input.sourceChannels.map((channel) => `'${channel}'`).join(",");
  const sql = `SELECT order_id, channel, MIN(event_date) AS event_date FROM pixel_orders_table WHERE ${ATTRIBUTION_WHERE} AND channel IN (${channelList}) GROUP BY order_id, channel ORDER BY order_id, channel LIMIT ${input.limit} OFFSET ${input.offset}`;
  const page = await queryTripleWhale(input, sql, dependencies);
  if (page.length > input.limit) throw new ChannelLiftError("triple_whale_page_oversized");
  return page.map((row) => {
    if (typeof row.channel !== "string" || !input.sourceChannels.includes(row.channel)) {
      throw new ChannelLiftError("triple_whale_channel_invalid");
    }
    if (typeof row.event_date !== "string" || row.event_date.slice(0, 10) !== reportingDate) {
      throw new ChannelLiftError("triple_whale_period_mismatch");
    }
    return {
      orderId: validateShopifyOrderId(row.order_id),
      channel: row.channel,
      eventDate: row.event_date,
    };
  });
}

export async function readTripleWhaleMappedPairCount(
  input: TripleWhaleCredentials & { sourceChannels: readonly string[] },
  dependencies: TripleWhaleDependencies = defaultDependencies
): Promise<number> {
  validateCredentials(input);
  if (
    input.sourceChannels.length < 1 ||
    input.sourceChannels.some((channel) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(channel))
  ) {
    throw new ChannelLiftError("triple_whale_pair_page_invalid");
  }
  const channelList = input.sourceChannels.map((channel) => `'${channel}'`).join(",");
  const sql = `SELECT COUNT(DISTINCT tuple(order_id, channel)) AS pairs FROM pixel_orders_table WHERE ${ATTRIBUTION_WHERE} AND channel IN (${channelList})`;
  const rows = await queryTripleWhale(input, sql, dependencies);
  if (rows.length !== 1) throw new ChannelLiftError("triple_whale_aggregate_shape");
  return parseCount(rows[0].pairs);
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
  const reportingDate = validateCredentials(input);
  if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 50_000) {
    throw new ChannelLiftError("triple_whale_page_size_invalid");
  }
  const maxRows = input.maxRows ?? 100_000;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > HARD_MAX_ATTRIBUTION_ROWS) {
    throw new ChannelLiftError("triple_whale_max_rows_invalid");
  }

  const { baseSql, countSql } = attributionSql(input.pageSize);
  const query = (sql: string) => queryTripleWhale(input, sql, dependencies);

  const counts = parseCounts(await query(countSql));
  if (counts.rows > maxRows) throw new ChannelLiftError("triple_whale_row_limit_exceeded");
  const maximumPages = Math.floor(counts.rows / input.pageSize) + 1;
  if (maximumPages > MAX_ATTRIBUTION_PAGES) {
    throw new ChannelLiftError("triple_whale_page_limit_exceeded");
  }
  const rows: AttributionRow[] = [];
  for (let offset = 0; offset <= counts.rows; offset += input.pageSize) {
    const page = await query(`${baseSql} OFFSET ${offset}`);
    if (page.length > input.pageSize) throw new ChannelLiftError("triple_whale_page_oversized");
    if (offset === counts.rows && page.length !== 0) {
      throw new ChannelLiftError("triple_whale_page_termination_mismatch");
    }
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

  const finalCounts = parseCounts(await query(countSql));
  if (
    finalCounts.rows !== counts.rows ||
    finalCounts.orders !== counts.orders ||
    finalCounts.pairs !== counts.pairs
  ) {
    throw new ChannelLiftError("triple_whale_snapshot_changed");
  }
  reconcileAttributionCounts(rows, counts);
  const snapshot = rows.map((row) => JSON.stringify(row)).sort();
  return {
    rows,
    counts,
    configHash: tripleWhaleAttributionConfigHash(input),
    snapshotHash: channelLiftDigest(snapshot),
  };
}
