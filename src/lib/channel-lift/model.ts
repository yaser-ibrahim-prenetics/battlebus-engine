import { createHash } from "node:crypto";
import { isIP } from "node:net";

export type ChannelLiftMode = "dry_run" | "live";
export type ChannelLiftSource = "schedule" | "manual";
export const CHANNEL_LIFT_REASON_CODES = [
  "parity_validation",
  "live_canary",
  "incident_recovery",
  "operator_replay",
] as const;
export type ChannelLiftReasonCode = (typeof CHANNEL_LIFT_REASON_CODES)[number];

export class ChannelLiftError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false
  ) {
    super(code);
    this.name = "ChannelLiftError";
  }
}

export type AttributionRow = {
  orderId: string;
  channel: string | null;
  eventDate: string;
};

export type AttributionCounts = {
  rows: number;
  orders: number;
  pairs: number;
};

export type ChannelMapping = Readonly<Record<string, string | null>>;

export const CHANNEL_LIFT_MAPPING: ChannelMapping = Object.freeze({
  klaviyo: "Klaviyo",
  Excluded: null,
});

export const CHANNEL_LIFT_ALLOWLIST = Object.freeze(["Klaviyo"] as const);

export type ChannelPair = { orderId: string; channel: string };

export type ShopifyChannelLiftOrder = {
  id: string;
  processedAt: string | null;
  currency: string;
  totalPrice: string;
  test: boolean;
  cancelledAt: string | null;
  financialStatus: string;
  sourceName: string;
  email?: string | null;
  customerId?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  countryCode?: string | null;
  clientIpAddress?: string | null;
  fbp?: string | null;
  fbc?: string | null;
};

export type MetaChannelLiftEvent = {
  event_name: string;
  event_id: string;
  event_time: number;
  action_source: "website";
  event_source_url: string;
  user_data: Record<string, string | string[]>;
  custom_data: { value: number; currency: string };
};

export function channelLiftDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function channelLiftRunId(reportingDate: string, mode: ChannelLiftMode): string {
  return `channel_lift_${channelLiftDigest([reportingDate, mode])}`;
}

export function validateReportingDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ChannelLiftError("invalid_reporting_date");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ChannelLiftError("invalid_reporting_date");
  }
  return value;
}

export function validateShopifyOrderId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) {
    throw new ChannelLiftError("invalid_order_id");
  }
  return value;
}

export function countAttributionRows(rows: AttributionRow[]): AttributionCounts {
  const orders = new Set(rows.map((row) => row.orderId));
  const pairs = new Set(rows.map((row) => JSON.stringify([row.orderId, row.channel])));
  return { rows: rows.length, orders: orders.size, pairs: pairs.size };
}

export function reconcileAttributionCounts(
  rows: AttributionRow[],
  expected: AttributionCounts
): void {
  const actual = countAttributionRows(rows);
  if (
    actual.rows !== expected.rows ||
    actual.orders !== expected.orders ||
    actual.pairs !== expected.pairs
  ) {
    throw new ChannelLiftError("extraction_count_mismatch");
  }
}

export function mapAndDeduplicateChannels(
  rows: AttributionRow[],
  mapping: ChannelMapping = CHANNEL_LIFT_MAPPING,
  allowlist: readonly string[] = CHANNEL_LIFT_ALLOWLIST
): { pairs: ChannelPair[]; exclusions: Record<string, number> } {
  const pairs = new Map<string, ChannelPair>();
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => {
    exclusions[reason] = (exclusions[reason] ?? 0) + 1;
  };

  for (const row of rows) {
    validateShopifyOrderId(row.orderId);
    if (!row.channel || !Object.prototype.hasOwnProperty.call(mapping, row.channel)) {
      exclude("unknown_channel");
      continue;
    }
    const mapped = mapping[row.channel];
    if (mapped === null) {
      exclude("excluded_channel");
      continue;
    }
    if (!mapped || !/^[A-Za-z][A-Za-z0-9]*$/.test(mapped)) {
      throw new ChannelLiftError("invalid_channel_mapping");
    }
    if (!allowlist.includes(mapped)) {
      exclude("outside_allowlist");
      continue;
    }
    pairs.set(JSON.stringify([row.orderId, mapped]), { orderId: row.orderId, channel: mapped });
  }

  return { pairs: [...pairs.values()], exclusions };
}

function decimalValue(amount: string): number {
  if (typeof amount !== "string" || !/^\d+(?:\.\d+)?$/.test(amount)) {
    throw new ChannelLiftError("invalid_value");
  }
  const [whole, fraction = ""] = amount.split(".");
  const compact = `${whole}${fraction.replace(/0+$/, "")}`;
  if (!Number.isSafeInteger(Number(compact))) throw new ChannelLiftError("unsafe_value");
  return Number(amount);
}

function hashNormalized(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeMetaPhone(value?: string | null): string | undefined {
  const phone = value
    ?.trim()
    .replace(/[\s().-]/g, "")
    .replace(/^\+|^00/, "");
  return phone && /^[1-9]\d{6,14}$/.test(phone) ? phone : undefined;
}

function prepareMetaUserData(
  shop: string,
  order: ShopifyChannelLiftOrder
): MetaChannelLiftEvent["user_data"] {
  const user: MetaChannelLiftEvent["user_data"] = {};
  const email = order.email?.trim().toLowerCase();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) user.em = [hashNormalized(email)];
  if (order.customerId) {
    user.external_id = [hashNormalized(`${shop}:${validateShopifyOrderId(order.customerId)}`)];
  }
  const country = order.countryCode?.trim().toLowerCase();
  if (country && /^[a-z]{2}$/.test(country)) user.country = [hashNormalized(country)];
  const phone = normalizeMetaPhone(order.phone);
  if (phone) user.ph = [hashNormalized(phone)];
  const firstName = order.firstName?.trim().toLowerCase();
  const lastName = order.lastName?.trim().toLowerCase();
  const city = order.city
    ?.trim()
    .toLowerCase()
    .replace(/[0-9.\s\-()]/g, "");
  const state = order.provinceCode
    ?.trim()
    .toLowerCase()
    .replace(/[0-9.\s\-()]/g, "");
  const zip = order.zip?.trim().toLowerCase().replace(/\s/g, "").split("-")[0];
  if (firstName) user.fn = [hashNormalized(firstName)];
  if (lastName) user.ln = [hashNormalized(lastName)];
  if (city) user.ct = [hashNormalized(city)];
  if (state) user.st = [hashNormalized(state)];
  if (zip) user.zp = [hashNormalized(zip)];
  if (order.clientIpAddress && isIP(order.clientIpAddress)) {
    user.client_ip_address = order.clientIpAddress;
  }
  if (order.fbp && /^fb\.[012]\.\d{13}\.\d+$/.test(order.fbp)) user.fbp = order.fbp;
  if (order.fbc && /^fb\.[012]\.\d{13}\.[^\s]+$/.test(order.fbc)) user.fbc = order.fbc;
  if (!user.em && !user.external_id) throw new ChannelLiftError("identity_missing");
  return user;
}

export function validateChannelLiftSourceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ChannelLiftError("source_url_unapproved");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "im8health.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ChannelLiftError("source_url_unapproved");
  }
  return parsed.toString();
}

export function buildMetaPurchaseEvent({
  shop,
  order,
  channel,
  sourceUrl,
  maxEventAgeSeconds,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  shop: string;
  order: ShopifyChannelLiftOrder;
  channel: string;
  sourceUrl: string;
  maxEventAgeSeconds: number;
  nowSeconds?: number;
}): MetaChannelLiftEvent {
  validateShopifyOrderId(order.id);
  if (order.test !== false) throw new ChannelLiftError("test_or_unknown_test_status");
  if (order.cancelledAt !== null || order.financialStatus.toLowerCase() !== "paid") {
    throw new ChannelLiftError("cancelled_refunded_or_unpaid");
  }
  if (!order.processedAt || !/(Z|[+-]\d{2}:\d{2})$/.test(order.processedAt)) {
    throw new ChannelLiftError("timestamp_missing_timezone");
  }
  const eventTime = Math.floor(Date.parse(order.processedAt) / 1000);
  if (
    !Number.isFinite(eventTime) ||
    eventTime > nowSeconds ||
    eventTime < nowSeconds - maxEventAgeSeconds
  ) {
    throw new ChannelLiftError("event_age");
  }
  if (!/^[A-Z]{3}$/.test(order.currency)) throw new ChannelLiftError("invalid_currency");
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(channel)) {
    throw new ChannelLiftError("invalid_channel_mapping");
  }
  const eventName = `Purchase_${channel}`;
  return {
    event_name: eventName,
    // Preserve Spock Store's identity algorithm across cutover.
    event_id: channelLiftDigest([shop, order.id, eventName]),
    event_time: eventTime,
    action_source: "website",
    event_source_url: validateChannelLiftSourceUrl(sourceUrl),
    user_data: prepareMetaUserData(shop, order),
    custom_data: { value: decimalValue(order.totalPrice), currency: order.currency },
  };
}
