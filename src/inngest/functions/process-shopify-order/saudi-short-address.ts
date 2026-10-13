import { getOrderMetafields } from "@/lib/clients/shopify";
import { getIm8ShortAddressFromMetafields } from "@/lib/transformers/address";
import type { ShopifyOrderPayload } from "../../events";
import type { StepTools } from "./types";

export async function loadSaudiShortAddress({
  step,
  order,
  shopifyOrderId,
  shopifyStore,
}: {
  step: StepTools;
  order: ShopifyOrderPayload;
  shopifyOrderId: string;
  shopifyStore?: string;
}): Promise<string> {
  const countryCode = order.shipping_address?.country_code;
  if (countryCode !== "SA") return "";

  return step.run("shopify-load-saudi-short-address", async () => {
    const metafields = await getOrderMetafields(shopifyOrderId, shopifyStore);
    const shortAddress = getIm8ShortAddressFromMetafields(metafields);
    if (!shortAddress) {
      console.warn(`[Shopify] Missing Saudi national short address for ${order.name}`);
    }
    return shortAddress;
  });
}
