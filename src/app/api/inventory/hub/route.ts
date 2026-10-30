import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";
import { readHubLocationMappings, sendHubWebhook } from "@/lib/clients/hub-transport";

const allowedPaths = new Set(["/api/webhooks/products", "/api/webhooks/locations", "/api/webhooks/inventory", "/api/webhooks/probe"]);
function authorize(request: Request) {
  return requireServiceAuth(request, {envVars: ["INVENTORY_SERVICE_API_KEY"]});
}
function relay(response: Response) {
  return new Response(response.body, {status: response.status, headers: {
    "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store",
  }});
}
/** Read mappings only. Inventory never receives a generic Hub API proxy. */
export async function GET(request: Request) {
  const auth = authorize(request);
  if (!auth.ok) return NextResponse.json(auth.body, {status: auth.status});
  try { return relay(await readHubLocationMappings()); }
  catch (error) {
    console.error(JSON.stringify({tag: "inventory.hub-relay.failure", requestId: randomUUID(), operation: "read-mappings",
      errorType: error instanceof Error ? error.name : "UnknownError"}));
    return NextResponse.json({error: "hub_unavailable"}, {status: 502});
  }
}
/** Preserve Hub's existing Battle Bus identity gate for inventory-only callbacks. */
export async function POST(request: Request) {
  const auth = authorize(request);
  if (!auth.ok) return NextResponse.json(auth.body, {status: auth.status});
  const path = new URL(request.url).searchParams.get("path") || "";
  if (!allowedPaths.has(path)) return NextResponse.json({error: "unsupported_inventory_callback"}, {status: 400});
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({error: "invalid_json"}, {status: 400}); }
  try { return relay(await sendHubWebhook(path, body)); }
  catch (error) {
    console.error(JSON.stringify({tag: "inventory.hub-relay.failure", requestId: randomUUID(), operation: "callback", path,
      errorType: error instanceof Error ? error.name : "UnknownError"}));
    return NextResponse.json({error: "hub_unavailable"}, {status: 502});
  }
}
