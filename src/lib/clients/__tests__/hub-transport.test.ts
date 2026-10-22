import { createServer } from "node:http";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Hub callback HTTP transport", () => {
  const previous = { ...process.env };
  afterEach(() => { process.env = { ...previous }; vi.resetModules(); });

  it("delivers signed payloads over real HTTP and rejects redirects and missing signing configuration", async () => {
    const received: Array<{ path?: string; body: string; signature?: string }> = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push({ path: req.url, body, signature: req.headers["x-battle-bus-signature"] as string });
      if (req.url === "/api/webhooks/products") res.writeHead(302, { Location: "http://127.0.0.1:1/steal" });
      else res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test port");
      process.env.CS_PLATFORM_URL = `http://127.0.0.1:${address.port}`;
      process.env.CS_PLATFORM_WEBHOOK_SECRET = "local-test-key";
      delete process.env.K_SERVICE;
      delete process.env.BATTLE_HUB_IAP_ENABLED;
      vi.resetModules();
      const { sendHubWebhook } = await import("../hub-transport");
      const payload = { event: "integration.probe", id: "test-id" };
      expect((await sendHubWebhook("/api/webhooks/probe", payload)).status).toBe(200);
      expect(received[0].body).toBe(JSON.stringify(payload));
      expect(received[0].signature).toBe(createHmac("sha256", "local-test-key").update(JSON.stringify(payload)).digest("hex"));
      await expect(sendHubWebhook("/api/webhooks/products", payload)).rejects.toThrow();
      await expect(sendHubWebhook("/api/users", payload)).rejects.toThrow(/Unsupported/);
      process.env.K_SERVICE = "battle-bus";
      await expect(sendHubWebhook("/api/webhooks/probe", payload)).rejects.toThrow();
      delete process.env.K_SERVICE;
      process.env.CS_PLATFORM_WEBHOOK_SECRET = "";
      vi.resetModules();
      const fresh = await import("../hub-transport");
      await expect(fresh.sendHubWebhook("/api/webhooks/probe", payload)).rejects.toThrow(/signature key/);
      expect(received).toHaveLength(2);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
