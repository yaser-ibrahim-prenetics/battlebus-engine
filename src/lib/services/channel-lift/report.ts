import {
  CHANNEL_LIFT_ALLOWLIST,
  CHANNEL_LIFT_MAPPING,
  ChannelLiftError,
  buildMetaPurchaseEvent,
  channelLiftDigest,
  mapAndDeduplicateChannels,
  type MetaChannelLiftEvent,
} from "@/lib/channel-lift/model";
import { readChannelLiftOrders } from "@/lib/clients/channel-lift-shopify";
import { META_GRAPH_API_VERSION } from "@/lib/clients/meta-conversions";
import { readTripleWhaleAttribution } from "@/lib/clients/triple-whale";
import { config } from "@/lib/config";

type ReportDependencies = {
  readAttribution: typeof readTripleWhaleAttribution;
  readOrders: typeof readChannelLiftOrders;
};

const defaultDependencies: ReportDependencies = {
  readAttribution: readTripleWhaleAttribution,
  readOrders: readChannelLiftOrders,
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
  };
};

function increment(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

export async function prepareChannelLiftReport(
  reportingDate: string,
  eligibilityCutoffSeconds: number,
  dependencies: ReportDependencies = defaultDependencies
): Promise<PreparedChannelLiftReport> {
  const shop = config.shopify.im8.shopDomain.trim().toLowerCase();
  const tripleWhaleShop = config.channelLift.tripleWhaleShopId.trim().toLowerCase();
  if (!shop || shop !== tripleWhaleShop) throw new ChannelLiftError("shop_identity_mismatch");

  const extraction = await dependencies.readAttribution({
    reportingDate,
    shopId: tripleWhaleShop,
    pageSize: config.channelLift.pageSize,
    maxRows: config.channelLift.maxRows,
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

  for (const pair of mapped.pairs) {
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
      increment(exclusionCounts, error.code);
    }
  }

  events.sort((left, right) => left.event_id.localeCompare(right.event_id));
  const configHash = channelLiftDigest([
    extraction.configHash,
    CHANNEL_LIFT_MAPPING,
    CHANNEL_LIFT_ALLOWLIST,
    config.channelLift.sourceUrl,
    config.channelLift.maxEventAgeSeconds,
    config.channelLift.metaDatasetId,
    META_GRAPH_API_VERSION,
  ]);
  const snapshotHash = channelLiftDigest([
    extraction.snapshotHash,
    eligibilityCutoffSeconds,
    events,
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
    },
  };
}
