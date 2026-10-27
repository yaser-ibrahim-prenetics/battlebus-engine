import type { Company, Window } from "@/lib/services/d365-reconciliation/types";
export function dynamicsQuery(
  base: string,
  entity: string,
  company: Company,
  filter: string,
  select: string
): URL {
  const url = new URL(`/data/${entity}`, base);
  url.searchParams.set("cross-company", "true");
  url.searchParams.set("$filter", `dataAreaId eq '${company.toLowerCase()}' and (${filter})`);
  url.searchParams.set("$select", `dataAreaId,${select}`);
  return url;
}
export const timeFilter = (field: string, window: Window) =>
  `${field} ge ${window.start} and ${field} lt ${window.end}`;
export const salesIdsFilter = (ids: string[]) =>
  ids.map((id) => `SalesOrderNumber eq '${id.replace(/'/g, "''")}'`).join(" or ");
