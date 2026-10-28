import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { settings } = vi.hoisted(() => ({
  settings: {
    features: { dryRunMode: true, enableGpsSync: false },
    gps: {
      baseUrl: "https://us.example.test",
      apiKey: "us-key",
      apiSecret: "us-secret",
      warehouseCode: "US-WH",
    },
    gpsUk: {
      baseUrl: "https://uk.example.test/",
      apiKey: "uk-key",
      apiSecret: "uk-secret",
      warehouseCode: "UK-WH",
    },
  },
}));
vi.mock("@/lib/config", () => ({ config: settings }));
import { probeGps } from "../gps";
const request = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", request);
  request
    .mockReset()
    .mockResolvedValue(new Response(JSON.stringify({ code: 200, data: { records: [] } })));
});
afterEach(() => vi.unstubAllGlobals());
describe("GPS authenticated readiness", () => {
  it.each(["US", "UK"] as const)(
    "performs a bounded signed %s read despite dry-run writes",
    async (region) => {
      const credentials = region === "US" ? settings.gps : settings.gpsUk;
      expect(await probeGps(region)).toEqual({ region, connectivity: "verified" });
      expect(request).toHaveBeenCalledTimes(1);
      const [url, options] = request.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(url.origin).toBe(new URL(credentials.baseUrl).origin);
      expect(url.pathname).toBe("/openapi/v1/integratedInventory/pageOpen");
      expect(body).toEqual({
        appKey: credentials.apiKey,
        reqTime: expect.any(String),
        data: { pageNum: 1, pageSize: 1, whCode: credentials.warehouseCode },
      });
      const canonicalData = JSON.stringify({
        pageNum: 1,
        pageSize: 1,
        whCode: credentials.warehouseCode,
      });
      const expectedSignature = crypto
        .createHmac("sha256", credentials.apiSecret)
        .update(credentials.apiKey + canonicalData + body.reqTime)
        .digest("hex");
      expect(url.searchParams.get("authcode")).toBe(expectedSignature);
      expect(options).toMatchObject({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
    }
  );
  it.each([
    { code: 401, data: { records: [] } },
    { code: 200, data: {} },
    { code: 200, data: { records: {} } },
    null,
  ])("rejects unsuccessful or malformed evidence", async (result) => {
    request.mockResolvedValue(new Response(JSON.stringify(result)));
    await expect(probeGps("US")).rejects.toThrow("incomplete or unsuccessful");
  });
  it("does not reveal upstream response bodies on HTTP failures", async () => {
    request.mockResolvedValue(new Response("private provider details", { status: 403 }));
    await expect(probeGps("US")).rejects.toThrow(/^GPS inventory probe HTTP 403$/);
  });
  it("rejects missing UK credentials without falling back to US", async () => {
    const saved = settings.gpsUk.apiSecret;
    settings.gpsUk.apiSecret = "";
    try {
      await expect(probeGps("UK")).rejects.toThrow("incomplete");
      expect(request).not.toHaveBeenCalled();
    } finally {
      settings.gpsUk.apiSecret = saved;
    }
  });
  it("rejects insecure URLs before sending credentials", async () => {
    const saved = settings.gps.baseUrl;
    try {
      for (const invalid of [
        "http://us.example.test",
        "https://user:pass@us.example.test",
        "https://us.example.test?token=value",
      ]) {
        settings.gps.baseUrl = invalid;
        await expect(probeGps("US")).rejects.toThrow("HTTPS endpoint");
      }
      expect(request).not.toHaveBeenCalled();
    } finally {
      settings.gps.baseUrl = saved;
    }
  });
});
