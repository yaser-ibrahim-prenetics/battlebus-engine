import { NextResponse } from "next/server";
import { requireServiceAuth } from "@/lib/auth/service-auth";

export async function forwardInventoryRequest(request: Request): Promise<Response> {
  const auth = requireServiceAuth(request);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const configured = process.env.INVENTORY_SERVICE_URL;
  const credential = process.env.INVENTORY_SERVICE_API_KEY;
  if (!configured || !credential) return NextResponse.json(
    { error: "inventory_service_not_configured" }, { status: 503 });
  try {
    const base = new URL(configured);
    if (base.protocol !== "https:" || base.username || base.password ||
        base.pathname !== "/" || base.search || base.hash) throw new Error("Invalid origin");
    const incoming = new URL(request.url);
    if (!["/api/inventory/sync", "/api/inventory/list"].includes(incoming.pathname)) {
      return NextResponse.json({ error: "unsupported_inventory_path" }, { status: 400 });
    }
    const headers = new Headers({ "x-api-key": credential });
    for (const name of ["content-type", "idempotency-key", "x-request-id"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const response = await fetch(`${base.origin}${incoming.pathname}${incoming.search}`, {
      method: request.method, headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
      redirect: "error", signal: AbortSignal.timeout(240000),
    });
    return new Response(response.body, { status: response.status, headers: {
      "content-type": response.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    } });
  } catch {
    return NextResponse.json({ error: "inventory_service_unavailable" }, { status: 502 });
  }
}
