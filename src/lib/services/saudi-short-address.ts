import { getOrderMetafields } from "@/lib/clients/shopify";
import { getIm8ShortAddressFromMetafields } from "@/lib/transformers/address";
import type { ShopifyOrderPayload } from "@/inngest/events";

type DurableStepRunner = {
  run<T>(id: string, callback: () => Promise<T> | T): Promise<T>;
};

/** Load the checkout-blocks Saudi national short address in a replay-safe step. */
export async function loadSaudiShortAddress({
  step,
  order,
  shopifyOrderId,
  shopifyStore,
}: {
  step: DurableStepRunner;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyStore?: string;
}): Promise<string> {
  if (order.shipping_address?.country_code !== "SA") return "";

  return step.run("shopify-load-saudi-short-address", async () => {
    const metafields = await getOrderMetafields(shopifyOrderId, shopifyStore);
    const shortAddress = getIm8ShortAddressFromMetafields(metafields);
    if (!shortAddress) {
      console.warn(`[Shopify] Missing Saudi national short address for ${order.name}`);
    }
    return shortAddress;
  });
}
