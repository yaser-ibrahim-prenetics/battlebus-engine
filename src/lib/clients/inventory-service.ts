import { randomUUID } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";

const googleAuth = new GoogleAuth();
const inventoryPaths = new Set(["/api/inventory/sync", "/api/inventory/list", "/api/inventory/d365", "/api/inventory/unified", "/api/inventory/availability"]);

type InventoryRequest = { method: string; query?: string; headers?: Headers; body?: string };

/** Private service transport, also used directly by background order recovery. */
export async function requestInventoryService(path: string, request: InventoryRequest): Promise<Response> {
  const requestId = randomUUID();
  let phase = "configuration";
  const inngestCallback = path === "/api/inngest";
  if (!inngestCallback && !inventoryPaths.has(path)) return NextResponse.json({error: "unsupported_inventory_path"}, {status: 400});
  const configured = process.env.INVENTORY_SERVICE_URL;
  const credential = process.env.INVENTORY_SERVICE_API_KEY;
  if (!configured || !credential) {
    console.error(JSON.stringify({tag: "inventory.gateway.failure", requestId, phase, path, errorType: "MissingConfiguration"}));
    return NextResponse.json({error: "inventory_service_not_configured"}, {status: 503});
  }
  try {
    const base = new URL(configured);
    if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
      throw new Error("Invalid inventory origin");
    }
    const headers = new Headers({"x-api-key": credential, "x-request-id": requestId});
    for (const name of ["content-type", "idempotency-key"]) {
      const value = request.headers?.get(name);
      if (value) headers.set(name, value);
    }
    if (inngestCallback) for (const [name, value] of request.headers || []) {
      if (name.startsWith("x-inngest-")) headers.set(name, value);
    }
    phase = "cloud-run-identity";
    const identity = await googleAuth.getIdTokenClient(base.origin);
    headers.set("Authorization", `Bearer ${await identity.idTokenProvider.fetchIdToken(base.origin)}`);
    phase = "upstream-request";
    const response = await fetch(`${base.origin}${path}${request.query || ""}`, {
      method: request.method, headers, body: request.body,
      redirect: "error", signal: AbortSignal.timeout(275000),
    });
    const responseHeaders = new Headers({
      "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store",
    });
    if (inngestCallback) for (const [name, value] of response.headers) {
      if (name.startsWith("x-inngest-") || name === "retry-after") responseHeaders.set(name, value);
    }
    return new Response(response.body, {status: response.status, headers: responseHeaders});
  } catch (error) {
    // Auth-library errors may carry headers or tokens. Never log the raw error/message.
    console.error(JSON.stringify({tag: "inventory.gateway.failure", requestId, phase, path,
      errorType: error instanceof Error ? error.name : "UnknownError"}));
    return NextResponse.json({error: "inventory_service_unavailable"}, {status: 502});
  }
}

export async function forwardInventoryRequest(request: Request): Promise<Response> {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, {status: auth.status});
  const url = new URL(request.url);
  // The business API must never bypass signature verification through the SDK endpoint.
  if (!inventoryPaths.has(url.pathname)) return NextResponse.json({error: "unsupported_inventory_path"}, {status: 400});
  return requestInventoryService(url.pathname, {method: request.method, query: url.search, headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text()});
}

/** Dedicated ingress only; the private worker verifies the untouched Inngest signature. */
export async function forwardInventoryInngestRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/inventory/inngest") return NextResponse.json({error: "unsupported_inventory_path"}, {status: 400});
  return requestInventoryService("/api/inngest", {method: request.method, query: url.search, headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text()});
}
