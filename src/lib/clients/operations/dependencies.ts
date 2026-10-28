import { readHubLocationMappings } from "@/lib/clients/hub-transport";
import { queryOmsInventory } from "@/lib/clients/gps-inventory";
export async function probeHub() {
  const response = await readHubLocationMappings();
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json"))
    throw new Error("Hub authenticated read unavailable");
  return { connectivity: "verified" as const };
}
export async function probeGps(region: "US" | "UK") {
  await queryOmsInventory({ region, page: 1, pageSize: 1, strict: true });
  return { region, connectivity: "verified" as const };
}
