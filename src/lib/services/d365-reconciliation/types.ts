export const companies = ["U001", "H007"] as const;
export type Company = (typeof companies)[number];
export type Kind = "salesorder" | "fulfillment";
export type Window = { start: string; end: string };
export type CompanyOrders = Record<Company, Set<string>>;
export type ReconciliationResult = {
  shopifyCount: number;
  dynamicsCount: number;
  missingInDynamics: string[];
  missingInShopify: Record<Company, string[]>;
};
