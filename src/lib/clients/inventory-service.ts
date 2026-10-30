import { GoogleAuth } from "google-auth-library";
import { NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";

const googleAuth = new GoogleAuth();

export function forwardInventoryRequest(request: Request): Promise<Response> {
  return forward(request, false);
}

/** Dedicated ingress only. The private worker verifies the untouched Inngest signature. */
export function forwardInventoryInngestRequest(request: Request): Promise<Response> {
  return forward(request, true);
}

async function forward(request: Request, inngestCallback: boolean): Promise<Response> {
  if (!inngestCallback) {
    const auth = requireServiceAuth(request);
    if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  }
  const configured = process.env.INVENTORY_SERVICE_URL;
  const credential = process.env.INVENTORY_SERVICE_API_KEY;
  if (!configured || !credential) return NextResponse.json(
    { error: "inventory_service_not_configured" }, { status: 503 });
  try {
    const base = new URL(configured);
    if (base.protocol !== "https:" || base.username || base.password ||
        base.pathname !== "/" || base.search || base.hash) throw new Error("Invalid origin");
    const incoming = new URL(request.url);
    const allowed = inngestCallback ? incoming.pathname === "/api/inventory/inngest"
      : ["/api/inventory/sync", "/api/inventory/list"].includes(incoming.pathname);
    if (!allowed) {
      return NextResponse.json({ error: "unsupported_inventory_path" }, { status: 400 });
    }
    const headers = new Headers({ "x-api-key": credential });
    for (const name of ["content-type", "idempotency-key", "x-request-id"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const identity = await googleAuth.getIdTokenClient(base.origin);
    headers.set("Authorization", `Bearer ${await identity.idTokenProvider.fetchIdToken(base.origin)}`);
    if (inngestCallback) {
      for (const [name, value] of request.headers) {
        if (name.startsWith("x-inngest-")) headers.set(name, value);
      }
    }
    const path = inngestCallback ? "/api/inngest" : incoming.pathname;
    const response = await fetch(`${base.origin}${path}${incoming.search}`, {
      method: request.method, headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
      redirect: "error", signal: AbortSignal.timeout(240000),
    });
    const responseHeaders = new Headers({
      "content-type": response.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    });
    if (inngestCallback) for (const [name, value] of response.headers) {
      if (name.startsWith("x-inngest-") || name === "retry-after") responseHeaders.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: "inventory_service_unavailable" }, { status: 502 });
  }
}
