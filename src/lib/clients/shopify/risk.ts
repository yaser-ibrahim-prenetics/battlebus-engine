import { config } from "../../config";
import { buildShopifyUrl, getShopifyHeaders } from "./request";
import type { ShopifyFraudAnalysis } from "./types";

/**
 * Get Order Risk
 */
export async function getOrderRisks(orderId: string | number): Promise<ShopifyFraudAnalysis[]> {
  if (!config.features.enabledShopifyRiskCheck) return [];

  if (config.features.enabledShopifyRiskMock) {
    const mockData = await import("../../mocks/shopify/risks.json");
    console.log(`Using mock risk data for order ${orderId}`);
    return mockData.risks;
  }

  const url = buildShopifyUrl(`/latest/orders/${orderId}/risks.json`);
  const response = await fetch(url, {
    method: "GET",
    headers: getShopifyHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get risk analysis order: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.risks;
}
