import type { ShopifyOrderPayload } from "../../../inngest/events";
import type { GpsOrderData } from "../../clients/gps";
import { toGpsOrderAddress } from "../address";
import {
  createShopifyToDynamicsLineTransformer,
  explodeBundleLines,
  filterDummySkus,
  filterServiceSkus,
  mergeGpsDuplicateSkuLines,
} from "../sku";
import { getGpsLogisticsChannel, getGpsWarehouseCode } from "../../helpers/warehouse";
import { getSubscriptionRewards } from "../../helpers/subscription-rewards";

const PRODUCT_OUTBOUND_ORDER_TYPE = 1;

export function toGpsOutboundOrder(
  order: ShopifyOrderPayload,
  d365SalesOrderNumber: string,
  warehouseName: string = "GPS Warehouse",
  shortAddress?: string
): GpsOrderData {
  const shippingAddress = order.shipping_address || order.billing_address;
  if (!shippingAddress) throw new Error(`No shipping address for order ${order.name}`);

  if (!Array.isArray(order.line_items)) {
    console.warn(
      `[Transformers] order.line_items is missing or not an array for GPS order ${order.name} – using empty product list`
    );
  }

  const transformSku = createShopifyToDynamicsLineTransformer();
  const productLines = (Array.isArray(order.line_items) ? order.line_items : [])
    .filter((item) => item.requires_shipping && !item.gift_card)
    .map((item) => ({ itemNumber: item.sku, quantity: item.quantity }))
    .map(transformSku);
  const filteredLines = filterDummySkus(filterServiceSkus(explodeBundleLines(productLines)));
  const rewardLines = getSubscriptionRewards(order).map((reward) => ({
    itemNumber: reward.sku,
    quantity: reward.quantity,
  }));

  return {
    platformOrderNo: order.name,
    thirdOrderNo: d365SalesOrderNumber,
    whCode: getGpsWarehouseCode(warehouseName),
    subOrderType: PRODUCT_OUTBOUND_ORDER_TYPE,
    logisticsChannel: getGpsLogisticsChannel(warehouseName, order),
    ...toGpsOrderAddress({ ...shippingAddress, email: order.email }, shortAddress),
    productList: mergeGpsDuplicateSkuLines([...filteredLines, ...rewardLines]),
  };
}
