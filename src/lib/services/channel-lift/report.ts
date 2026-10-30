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
  readTripleWhaleAttributionSummary,
  readTripleWhaleAttributionCounts,
  readTripleWhaleMappedPairPage,
  readTripleWhaleMappedPairSnapshot,
  tripleWhaleAttributionConfigHash,
} from "@/lib/clients/triple-whale";
import { config } from "@/lib/config";

type PlanDependencies = {
  readSummary: typeof readTripleWhaleAttributionSummary;
  readPairSnapshot: typeof readTripleWhaleMappedPairSnapshot;
};

type DeliveryBatchDependencies = {
  readCounts: typeof readTripleWhaleAttributionCounts;
  readPairPage: typeof readTripleWhaleMappedPairPage;
  readOrders: typeof readChannelLiftOrders;
};

const defaultPlanDependencies: PlanDependencies = {
  readSummary: readTripleWhaleAttributionSummary,
  readPairSnapshot: readTripleWhaleMappedPairSnapshot,
};

const defaultDeliveryBatchDependencies: DeliveryBatchDependencies = {
  readCounts: readTripleWhaleAttributionCounts,
  readPairPage: readTripleWhaleMappedPairPage,
  readOrders: readChannelLiftOrders,
};

const META_BATCH_SIZE = 500;
const MAX_PREPARATION_BATCHES = 200;
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

export type ChannelLiftCandidateBatch = Pick<
  ChannelLiftDeliveryBatch,
  "candidateOffset" | "candidateCount"
>;

type ChannelLiftBatchContext = {
  reportingDate: string;
  eligibilityCutoffSeconds: number;
  expectedCounts: AttributionCounts;
  expectedMappedPairs: number;
  expectedMappedSnapshotHash: string;
};

type ChannelLiftCandidatePreparation = ChannelLiftBatchContext & {
  candidateBatch: ChannelLiftCandidateBatch;
};

type ChannelLiftDeliveryPreparation = ChannelLiftBatchContext & {
  batch: ChannelLiftDeliveryBatch;
};

export type ChannelLiftPreparationPlan = {
  counts: AttributionCounts;
  mappedPairs: number;
  mappedSnapshotHash: string;
  mappingExclusions: Record<string, number>;
  extractionConfigHash: string;
  extractionSnapshotHash: string;
  candidateBatches: ChannelLiftCandidateBatch[];
};

export type ChannelLiftEvidence = {
  counts: AttributionCounts;
  mappedPairs: number;
  mappedSnapshotHash: string;
  eligibleEvents: number;
  exclusionCounts: Record<string, number>;
  configHash: string;
  snapshotHash: string;
  deliveryBatches: ChannelLiftDeliveryBatch[];
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

export async function prepareChannelLiftPlan(
  reportingDate: string,
  dependencies: PlanDependencies = defaultPlanDependencies
): Promise<ChannelLiftPreparationPlan> {
  const shop = config.shopify.im8.shopDomain.trim().toLowerCase();
  const tripleWhaleShop = config.channelLift.tripleWhaleShopId.trim().toLowerCase();
  if (!shop || shop !== tripleWhaleShop) throw new ChannelLiftError("shop_identity_mismatch");

  const extractionInput = tripleWhaleInput(reportingDate, tripleWhaleShop);
  const extraction = await dependencies.readSummary({
    ...extractionInput,
    apiKey: config.channelLift.tripleWhaleApiKey,
  });
  const mappingExclusions: Record<string, number> = {};
  let mappedPairs = 0;
  for (const summary of extraction.channels) {
    if (
      !summary.channel ||
      !Object.prototype.hasOwnProperty.call(CHANNEL_LIFT_MAPPING, summary.channel)
    ) {
      mappingExclusions.unknown_channel = (mappingExclusions.unknown_channel ?? 0) + summary.rows;
      continue;
    }
    const mapped = CHANNEL_LIFT_MAPPING[summary.channel];
    if (mapped === null) {
      mappingExclusions.excluded_channel = (mappingExclusions.excluded_channel ?? 0) + summary.rows;
      continue;
    }
    if (!mapped || !/^[A-Za-z][A-Za-z0-9]*$/.test(mapped)) {
      throw new ChannelLiftError("invalid_channel_mapping");
    }
    if (!CHANNEL_LIFT_ALLOWLIST.includes(mapped as "Klaviyo")) {
      mappingExclusions.outside_allowlist =
        (mappingExclusions.outside_allowlist ?? 0) + summary.rows;
      continue;
    }
    mappedPairs += summary.pairs;
  }
  if (
    mappedPairs > extraction.counts.pairs ||
    mappedPairs > config.channelLift.maxRows ||
    Math.ceil(mappedPairs / META_BATCH_SIZE) > MAX_PREPARATION_BATCHES
  ) {
    throw new ChannelLiftError("triple_whale_row_limit_exceeded");
  }
  const pairSnapshot = await dependencies.readPairSnapshot({
    reportingDate,
    shopId: tripleWhaleShop,
    apiKey: config.channelLift.tripleWhaleApiKey,
    sourceChannels: SOURCE_CHANNELS,
  });
  if (pairSnapshot.pairs !== mappedPairs) {
    throw new ChannelLiftError("triple_whale_snapshot_changed");
  }
  const candidateBatches: ChannelLiftCandidateBatch[] = [];
  for (let offset = 0; offset < mappedPairs; offset += META_BATCH_SIZE) {
    candidateBatches.push({
      candidateOffset: offset,
      candidateCount: Math.min(META_BATCH_SIZE, mappedPairs - offset),
    });
  }
  return {
    counts: extraction.counts,
    mappedPairs,
    mappedSnapshotHash: pairSnapshot.snapshotHash,
    mappingExclusions,
    extractionConfigHash: extraction.configHash,
    extractionSnapshotHash: channelLiftDigest([extraction.snapshotHash, pairSnapshot.snapshotHash]),
    candidateBatches,
  };
}

export async function prepareChannelLiftCandidateBatch(
  {
    reportingDate,
    eligibilityCutoffSeconds,
    expectedCounts,
    expectedMappedPairs,
    expectedMappedSnapshotHash,
    candidateBatch,
  }: ChannelLiftCandidatePreparation,
  dependencies: DeliveryBatchDependencies = defaultDeliveryBatchDependencies
): Promise<{
  events: MetaChannelLiftEvent[];
  batch: ChannelLiftDeliveryBatch;
  exclusionCounts: Record<string, number>;
  configHash: string;
}> {
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
  const page = await dependencies.readPairPage({
    ...credentials,
    sourceChannels: SOURCE_CHANNELS,
    offset: candidateBatch.candidateOffset,
    limit: candidateBatch.candidateCount,
  });
  if (page.pairs !== expectedMappedPairs || page.snapshotHash !== expectedMappedSnapshotHash) {
    throw new ChannelLiftError("triple_whale_snapshot_changed");
  }
  const mapped = mapAndDeduplicateChannels(page.rows, CHANNEL_LIFT_MAPPING, CHANNEL_LIFT_ALLOWLIST);
  if (
    mapped.pairs.length !== candidateBatch.candidateCount ||
    Object.keys(mapped.exclusions).length > 0
  ) {
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
    batch: {
      ...candidateBatch,
      eventCount: prepared.events.length,
      digest: channelLiftDigest([mapped.pairs, prepared.events]),
    },
    exclusionCounts: prepared.exclusions,
    configHash: reportConfigHash(
      tripleWhaleAttributionConfigHash(tripleWhaleInput(reportingDate, tripleWhaleShop))
    ),
  };
}

export function finalizeChannelLiftEvidence({
  plan,
  preparedBatches,
  eligibilityCutoffSeconds,
}: {
  plan: ChannelLiftPreparationPlan;
  preparedBatches: Array<{
    batch: ChannelLiftDeliveryBatch;
    exclusionCounts: Record<string, number>;
    configHash: string;
  }>;
  eligibilityCutoffSeconds: number;
}): ChannelLiftEvidence {
  if (preparedBatches.length !== plan.candidateBatches.length) {
    throw new ChannelLiftError("prepared_batch_inventory_mismatch");
  }
  const exclusionCounts = { ...plan.mappingExclusions };
  let eligibleEvents = 0;
  for (const [index, prepared] of preparedBatches.entries()) {
    const planned = plan.candidateBatches[index];
    if (
      prepared.batch.candidateOffset !== planned.candidateOffset ||
      prepared.batch.candidateCount !== planned.candidateCount ||
      prepared.configHash !== reportConfigHash(plan.extractionConfigHash)
    ) {
      throw new ChannelLiftError("prepared_batch_inventory_mismatch");
    }
    eligibleEvents += prepared.batch.eventCount;
    mergeCounts(exclusionCounts, prepared.exclusionCounts);
  }
  const deliveryBatches = preparedBatches.map((prepared) => prepared.batch);
  const configHash = reportConfigHash(plan.extractionConfigHash);
  return {
    counts: plan.counts,
    mappedPairs: plan.mappedPairs,
    mappedSnapshotHash: plan.mappedSnapshotHash,
    eligibleEvents,
    exclusionCounts,
    configHash,
    snapshotHash: channelLiftDigest([
      plan.extractionSnapshotHash,
      eligibilityCutoffSeconds,
      deliveryBatches,
      Object.entries(exclusionCounts).sort(([left], [right]) => left.localeCompare(right)),
    ]),
    deliveryBatches,
  };
}

export async function prepareChannelLiftDeliveryBatch(
  {
    reportingDate,
    eligibilityCutoffSeconds,
    expectedCounts,
    expectedMappedPairs,
    expectedMappedSnapshotHash,
    batch,
  }: ChannelLiftDeliveryPreparation,
  dependencies: DeliveryBatchDependencies = defaultDeliveryBatchDependencies
): Promise<{ events: MetaChannelLiftEvent[]; digest: string; configHash: string }> {
  // Keep the replay API payload-minimal so callers cannot checkpoint
  // exclusion details or other initial-preparation state by accident.
  const prepared = await prepareChannelLiftCandidateBatch(
    {
      reportingDate,
      eligibilityCutoffSeconds,
      expectedCounts,
      expectedMappedPairs,
      expectedMappedSnapshotHash,
      candidateBatch: batch,
    },
    dependencies
  );
  return {
    events: prepared.events,
    digest: prepared.batch.digest,
    configHash: prepared.configHash,
  };
}
