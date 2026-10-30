import {
  CHANNEL_LIFT_ALLOWLIST,
  CHANNEL_LIFT_MAPPING,
  ChannelLiftError,
  buildMetaPurchaseEvent,
  channelLiftDigest,
  mapAndDeduplicateChannels,
  type AttributionCounts,
  type ChannelPair,
  type MetaChannelLiftEvent,
  type ShopifyChannelLiftOrder,
} from "@/lib/channel-lift/model";
import { readChannelLiftOrders } from "@/lib/clients/channel-lift-shopify";
import { META_GRAPH_API_VERSION } from "@/lib/clients/meta-conversions";
import {
  readTripleWhaleAttribution,
  readTripleWhaleAttributionCounts,
  readTripleWhaleMappedPairCount,
  readTripleWhaleMappedPairPage,
  tripleWhaleAttributionConfigHash,
} from "@/lib/clients/triple-whale";
import { config } from "@/lib/config";

type ReportDependencies = {
  readAttribution: typeof readTripleWhaleAttribution;
  readOrders: typeof readChannelLiftOrders;
};

type DeliveryBatchDependencies = {
  readCounts: typeof readTripleWhaleAttributionCounts;
  readPairCount: typeof readTripleWhaleMappedPairCount;
  readPairPage: typeof readTripleWhaleMappedPairPage;
  readOrders: typeof readChannelLiftOrders;
};

const defaultDependencies: ReportDependencies = {
  readAttribution: readTripleWhaleAttribution,
  readOrders: readChannelLiftOrders,
};

const defaultDeliveryBatchDependencies: DeliveryBatchDependencies = {
  readCounts: readTripleWhaleAttributionCounts,
  readPairCount: readTripleWhaleMappedPairCount,
  readPairPage: readTripleWhaleMappedPairPage,
  readOrders: readChannelLiftOrders,
};

const META_BATCH_SIZE = 500;
const SOURCE_CHANNELS = Object.freeze(
  Object.entries(CHANNEL_LIFT_MAPPING)
    .filter(([, mapped]) => mapped !== null && CHANNEL_LIFT_ALLOWLIST.includes(mapped as "Klaviyo"))
    .map(([source]) => source)
);

export type ChannelLiftDeliveryBatch = {
  candidateOffset: number;
  candidateCount: number;
  eventCount: number;
  digest: string;
};

export type PreparedChannelLiftReport = {
  events: MetaChannelLiftEvent[];
  evidence: {
    counts: { rows: number; orders: number; pairs: number };
    mappedPairs: number;
    eligibleEvents: number;
    exclusionCounts: Record<string, number>;
    configHash: string;
    snapshotHash: string;
    deliveryBatches: ChannelLiftDeliveryBatch[];
  };
};

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function mergeCounts(target: Record<string, number>, additions: Record<string, number>): void {
  for (const [reason, count] of Object.entries(additions)) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

function buildEvents({
  pairs,
  orders,
  shop,
  eligibilityCutoffSeconds,
}: {
  pairs: ChannelPair[];
  orders: Map<string, ShopifyChannelLiftOrder>;
  shop: string;
  eligibilityCutoffSeconds: number;
}): { events: MetaChannelLiftEvent[]; exclusions: Record<string, number> } {
  const events: MetaChannelLiftEvent[] = [];
  const exclusions: Record<string, number> = {};
  for (const pair of pairs) {
    try {
      const order = orders.get(pair.orderId);
      if (!order || order.id !== pair.orderId) {
        throw new ChannelLiftError("shopify_order_missing_or_mismatched");
      }
      events.push(
        buildMetaPurchaseEvent({
          shop,
          order,
          channel: pair.channel,
          sourceUrl: config.channelLift.sourceUrl,
          maxEventAgeSeconds: config.channelLift.maxEventAgeSeconds,
          nowSeconds: eligibilityCutoffSeconds,
        })
      );
    } catch (error) {
      if (!(error instanceof ChannelLiftError)) {
        throw new ChannelLiftError("order_validation_failure");
      }
      if (error.code === "source_url_unapproved") throw error;
      increment(exclusions, error.code);
    }
  }
  events.sort((left, right) => left.event_id.localeCompare(right.event_id));
  return { events, exclusions };
}

function reportConfigHash(extractionConfigHash: string): string {
  return channelLiftDigest([
    extractionConfigHash,
    CHANNEL_LIFT_MAPPING,
    CHANNEL_LIFT_ALLOWLIST,
    config.channelLift.sourceUrl,
    config.channelLift.maxEventAgeSeconds,
    config.channelLift.metaDatasetId,
    META_GRAPH_API_VERSION,
  ]);
}

function tripleWhaleInput(reportingDate: string, shopId: string) {
  return {
    reportingDate,
    shopId,
    pageSize: config.channelLift.pageSize,
    maxRows: config.channelLift.maxRows,
  };
}

export async function prepareChannelLiftReport(
  reportingDate: string,
  eligibilityCutoffSeconds: number,
  dependencies: ReportDependencies = defaultDependencies
): Promise<PreparedChannelLiftReport> {
  const shop = config.shopify.im8.shopDomain.trim().toLowerCase();
  const tripleWhaleShop = config.channelLift.tripleWhaleShopId.trim().toLowerCase();
  if (!shop || shop !== tripleWhaleShop) throw new ChannelLiftError("shop_identity_mismatch");

  const extractionInput = tripleWhaleInput(reportingDate, tripleWhaleShop);
  const extraction = await dependencies.readAttribution({
    ...extractionInput,
    apiKey: config.channelLift.tripleWhaleApiKey,
  });
  const mapped = mapAndDeduplicateChannels(
    extraction.rows,
    CHANNEL_LIFT_MAPPING,
    CHANNEL_LIFT_ALLOWLIST
  );
  const orders = await dependencies.readOrders([
    ...new Set(mapped.pairs.map((pair) => pair.orderId)),
  ]);
  const exclusionCounts = { ...mapped.exclusions };
  const events: MetaChannelLiftEvent[] = [];
  const deliveryBatches: ChannelLiftDeliveryBatch[] = [];
  for (let offset = 0; offset < mapped.pairs.length; offset += META_BATCH_SIZE) {
    const pairs = mapped.pairs.slice(offset, offset + META_BATCH_SIZE);
    const batch = buildEvents({ pairs, orders, shop, eligibilityCutoffSeconds });
    mergeCounts(exclusionCounts, batch.exclusions);
    events.push(...batch.events);
    if (batch.events.length > 0) {
      deliveryBatches.push({
        candidateOffset: offset,
        candidateCount: pairs.length,
        eventCount: batch.events.length,
        digest: channelLiftDigest([pairs, batch.events]),
      });
    }
  }

  events.sort((left, right) => left.event_id.localeCompare(right.event_id));
  const configHash = reportConfigHash(extraction.configHash);
  const snapshotHash = channelLiftDigest([
    extraction.snapshotHash,
    eligibilityCutoffSeconds,
    events,
    deliveryBatches,
    Object.entries(exclusionCounts).sort(([left], [right]) => left.localeCompare(right)),
  ]);

  return {
    events,
    evidence: {
      counts: extraction.counts,
      mappedPairs: mapped.pairs.length,
      eligibleEvents: events.length,
      exclusionCounts,
      configHash,
      snapshotHash,
      deliveryBatches,
    },
  };
}

export async function prepareChannelLiftDeliveryBatch(
  {
    reportingDate,
    eligibilityCutoffSeconds,
    expectedCounts,
    expectedMappedPairs,
    batch,
  }: {
    reportingDate: string;
    eligibilityCutoffSeconds: number;
    expectedCounts: AttributionCounts;
    expectedMappedPairs: number;
    batch: ChannelLiftDeliveryBatch;
  },
  dependencies: DeliveryBatchDependencies = defaultDeliveryBatchDependencies
): Promise<{ events: MetaChannelLiftEvent[]; digest: string; configHash: string }> {
  const shop = config.shopify.im8.shopDomain.trim().toLowerCase();
  const tripleWhaleShop = config.channelLift.tripleWhaleShopId.trim().toLowerCase();
  if (!shop || shop !== tripleWhaleShop) throw new ChannelLiftError("shop_identity_mismatch");

  const credentials = {
    reportingDate,
    shopId: tripleWhaleShop,
    apiKey: config.channelLift.tripleWhaleApiKey,
  };
  const counts = await dependencies.readCounts(credentials);
  if (
    counts.rows !== expectedCounts.rows ||
    counts.orders !== expectedCounts.orders ||
    counts.pairs !== expectedCounts.pairs
  ) {
    throw new ChannelLiftError("triple_whale_snapshot_changed");
  }
  const mappedPairCount = await dependencies.readPairCount({
    ...credentials,
    sourceChannels: SOURCE_CHANNELS,
  });
  if (mappedPairCount !== expectedMappedPairs) {
    throw new ChannelLiftError("triple_whale_snapshot_changed");
  }
  const rows = await dependencies.readPairPage({
    ...credentials,
    sourceChannels: SOURCE_CHANNELS,
    offset: batch.candidateOffset,
    limit: batch.candidateCount,
  });
  const mapped = mapAndDeduplicateChannels(rows, CHANNEL_LIFT_MAPPING, CHANNEL_LIFT_ALLOWLIST);
  if (mapped.pairs.length !== batch.candidateCount || Object.keys(mapped.exclusions).length > 0) {
    throw new ChannelLiftError("prepared_snapshot_changed");
  }
  const orders = await dependencies.readOrders([
    ...new Set(mapped.pairs.map((pair) => pair.orderId)),
  ]);
  const prepared = buildEvents({
    pairs: mapped.pairs,
    orders,
    shop,
    eligibilityCutoffSeconds,
  });
  return {
    events: prepared.events,
    digest: channelLiftDigest([mapped.pairs, prepared.events]),
    configHash: reportConfigHash(
      tripleWhaleAttributionConfigHash(tripleWhaleInput(reportingDate, tripleWhaleShop))
    ),
  };
}
