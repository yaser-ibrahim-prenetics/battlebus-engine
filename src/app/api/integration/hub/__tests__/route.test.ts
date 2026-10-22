import { createServer } from "node:http";
import { once } from "node:events";
import { NextRequest } from "next/server";
import { expect, it, vi } from "vitest";

it("authenticates the real HTTP round trip in dry-run without sending business events", async () => {
  const env = { ...process.env };
  const paths: string[] = [];
  let corrupt = false;
  const server = createServer(async (req, res) => {
    paths.push(req.url || "");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/webhooks/probe") {
      const body = JSON.parse(raw);
      res.end(JSON.stringify({ ok: true, event: body.event, id: corrupt ? "wrong-id" : body.id, writes: false }));
    } else if (req.url === "/api/locations/mappings") {
      res.end(JSON.stringify({ success: true, locations: [] }));
    } else { res.statusCode = 501; res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    Object.assign(process.env, { CS_PLATFORM_URL: `http://127.0.0.1:${address.port}`, CS_PLATFORM_ENABLED: "true", CS_PLATFORM_WEBHOOK_SECRET: "local-key", BATTLE_BUS_API_KEY: "local-api-key", DRY_RUN_MODE: "true" });
    delete process.env.K_SERVICE;
    delete process.env.BATTLE_HUB_IAP_ENABLED;
    vi.resetModules();
    const { GET } = await import("../route");
    expect((await GET(new NextRequest("http://localhost/api/integration/hub"))).status).toBe(401);
    expect(paths).toHaveLength(0);
    const request = () => new NextRequest("http://localhost/api/integration/hub", { headers: { Authorization: "Bearer local-api-key" } });
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, writes: false, dryRun: true, locationMappings: "reachable" });
    expect(paths).toEqual(["/api/webhooks/probe", "/api/locations/mappings"]);
    corrupt = true;
    expect((await GET(request())).status).toBe(503);
    expect(paths).toHaveLength(3);
  } finally {
    process.env = env; vi.resetModules();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
