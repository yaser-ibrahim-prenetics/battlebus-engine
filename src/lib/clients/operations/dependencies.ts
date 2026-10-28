import { readHubLocationMappings } from "@/lib/clients/hub-transport";
export { probeGps } from "./gps";
export async function probeHub() {
  const response = await readHubLocationMappings();
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json"))
    throw new Error("Hub authenticated read unavailable");
  return { connectivity: "verified" as const };
}
