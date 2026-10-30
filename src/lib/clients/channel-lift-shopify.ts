import type { ShopifyChannelLiftOrder } from "@/lib/channel-lift/model";
import {
  ChannelLiftError,
  normalizeMetaPhone,
  validateShopifyOrderId,
} from "@/lib/channel-lift/model";
import { withBoundedChannelLiftRetry } from "@/lib/clients/channel-lift-retry";
import {
  ShopifyAdminGraphqlError,
  shopifyAdminGraphql,
} from "@/lib/clients/shopify";

const QUERY = `
  query ChannelLiftOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      id
      ... on Order {
        legacyResourceId
        processedAt
        totalPriceSet { presentmentMoney { amount currencyCode } }
        test
        cancelledAt
        displayFinancialStatus
        sourceName
        email
        phone
        clientIp
        customAttributes { key value }
        customer {
          legacyResourceId email phone firstName lastName
          defaultAddress { city provinceCode zip countryCodeV2 }
        }
        billingAddress { firstName lastName phone city provinceCode zip countryCodeV2 }
        shippingAddress { firstName lastName phone city provinceCode zip countryCodeV2 }
      }
    }
  }
`;

type Address = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  city: string | null;
  provinceCode: string | null;
  zip: string | null;
  countryCodeV2: string | null;
};

type GraphqlOrder = {
  __typename: string;
  id: string;
  legacyResourceId: string;
  processedAt: string | null;
  totalPriceSet?: { presentmentMoney?: { amount?: string; currencyCode?: string } };
  test: boolean;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  sourceName: string | null;
  email: string | null;
  phone: string | null;
  clientIp: string | null;
  customAttributes?: { key: string; value: string }[];
  customer: {
    legacyResourceId: string;
    email: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    defaultAddress: Address | null;
  } | null;
  billingAddress: Address | null;
  shippingAddress: Address | null;
};

type ShopifyDependencies = {
  request: typeof shopifyAdminGraphql;
  sleep: (milliseconds: number) => Promise<void>;
};

const defaultDependencies: ShopifyDependencies = {
  request: shopifyAdminGraphql,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export async function readChannelLiftOrders(
  ids: string[],
  dependencies: ShopifyDependencies = defaultDependencies
): Promise<Map<string, ShopifyChannelLiftOrder>> {
  const uniqueIds = [...new Set(ids.map(validateShopifyOrderId))];
  const orders = new Map<string, ShopifyChannelLiftOrder>();

  for (const batch of chunks(uniqueIds, 100)) {
    const payload = await withBoundedChannelLiftRetry({
      operation: () =>
        dependencies.request(QUERY, {
          ids: batch.map((id) => `gid://shopify/Order/${id}`),
        }) as Promise<{ data?: { nodes?: (GraphqlOrder | null)[] } }>,
      normalizeError: (error) => {
        if (error instanceof ChannelLiftError) return error;
        if (error instanceof ShopifyAdminGraphqlError) {
          return new ChannelLiftError(
            error.status === 429
              ? "shopify_rate_limited"
              : error.retryable
                ? "shopify_unavailable"
                : "shopify_rejected",
            error.retryable
          );
        }
        return new ChannelLiftError("shopify_network_error", true);
      },
      sleep: dependencies.sleep,
    });

    const nodes = payload?.data?.nodes;
    if (!Array.isArray(nodes) || nodes.length !== batch.length) {
      throw new ChannelLiftError("shopify_response_shape");
    }
    for (const row of nodes) {
      if (!row) continue;
      const id = validateShopifyOrderId(row.legacyResourceId);
      if (
        row.__typename !== "Order" ||
        row.id !== `gid://shopify/Order/${id}` ||
        !batch.includes(id) ||
        orders.has(id)
      ) {
        throw new ChannelLiftError("shopify_join_mismatch");
      }
      const money = row.totalPriceSet?.presentmentMoney;
      if (typeof money?.amount !== "string" || typeof money.currencyCode !== "string") {
        throw new ChannelLiftError("shopify_value_missing");
      }
      orders.set(id, {
        id,
        processedAt: row.processedAt,
        currency: money.currencyCode,
        totalPrice: money.amount,
        test: row.test,
        cancelledAt: row.cancelledAt,
        financialStatus: row.displayFinancialStatus?.toLowerCase() || "",
        sourceName: row.sourceName || "",
        email: row.email || row.customer?.email,
        customerId: row.customer
          ? validateShopifyOrderId(row.customer.legacyResourceId)
          : undefined,
        phone: [
          row.phone,
          row.billingAddress?.phone,
          row.shippingAddress?.phone,
          row.customer?.phone,
        ].find((value) => normalizeMetaPhone(value)),
        firstName:
          row.billingAddress?.firstName ||
          row.shippingAddress?.firstName ||
          row.customer?.firstName,
        lastName:
          row.billingAddress?.lastName || row.shippingAddress?.lastName || row.customer?.lastName,
        city:
          row.billingAddress?.city ||
          row.shippingAddress?.city ||
          row.customer?.defaultAddress?.city,
        provinceCode:
          row.billingAddress?.provinceCode ||
          row.shippingAddress?.provinceCode ||
          row.customer?.defaultAddress?.provinceCode,
        zip:
          row.billingAddress?.zip || row.shippingAddress?.zip || row.customer?.defaultAddress?.zip,
        countryCode:
          row.billingAddress?.countryCodeV2 ||
          row.shippingAddress?.countryCodeV2 ||
          row.customer?.defaultAddress?.countryCodeV2,
        clientIpAddress: row.clientIp,
        fbp: row.customAttributes?.find((attribute) => attribute.key === "_fbp")?.value,
        fbc: row.customAttributes?.find((attribute) => attribute.key === "_fbc")?.value,
      });
    }
  }

  return orders;
}
