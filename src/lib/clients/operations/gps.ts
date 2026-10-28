import { config } from "@/lib/config";
import { generateAuthCode } from "@/lib/clients/gps";

/** Verify a real, bounded read even when business writes are in dry-run mode. */
export async function probeGps(region: "US" | "UK") {
  const credentials = region === "US" ? config.gps : config.gpsUk;
  if (
    !credentials.baseUrl ||
    !credentials.apiKey ||
    !credentials.apiSecret ||
    !credentials.warehouseCode
  )
    throw new Error("GPS probe configuration is incomplete");
  const baseUrl = new URL(credentials.baseUrl);
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  )
    throw new Error("GPS probe requires an HTTPS endpoint without embedded credentials");

  const data = { pageNum: 1, pageSize: 1, whCode: credentials.warehouseCode };
  const reqTime = Math.floor(Date.now() / 1000).toString();
  const url = new URL(
    `${baseUrl.toString().replace(/\/$/, "")}/openapi/v1/integratedInventory/pageOpen`
  );
  url.searchParams.set(
    "authcode",
    generateAuthCode(data, reqTime, credentials.apiKey, credentials.apiSecret)
  );
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey: credentials.apiKey, reqTime, data }),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GPS inventory probe HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("code" in result) ||
    result.code !== 200 ||
    !("data" in result) ||
    !result.data ||
    typeof result.data !== "object" ||
    !("records" in result.data) ||
    !Array.isArray(result.data.records)
  )
    throw new Error("GPS inventory probe returned incomplete or unsuccessful evidence");
  return { region, connectivity: "verified" as const };
}
