import { companies, type CompanyOrders, type ReconciliationResult } from "./types";

export function compareOrders(shopify: Set<string>, dynamics: CompanyOrders): ReconciliationResult {
  const all = new Set(companies.flatMap((company) => [...dynamics[company]]));
  return {
    shopifyCount: shopify.size,
    dynamicsCount: all.size,
    missingInDynamics: [...shopify].filter((name) => !all.has(name)).sort(),
    missingInShopify: {
      U001: [...dynamics.U001].filter((name) => !shopify.has(name)).sort(),
      H007: [...dynamics.H007].filter((name) => !shopify.has(name)).sort(),
    },
  };
}
