import { describe, expect, it } from "vitest";
import {
  normalizeBodyForLog,
  readResponseBodyForLog,
  truncateForLog,
} from "../d365-http-log";

describe("d365-http-log", () => {
  it("redacts sensitive fields in JSON bodies", () => {
    const body = JSON.stringify({
      client_id: "abc",
      client_secret: "super-secret",
      nested: { access_token: "token-value" },
    });

    expect(normalizeBodyForLog(body)).toEqual({
      client_id: "abc",
      client_secret: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
    });
  });

  it("redacts URLSearchParams secrets", () => {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_secret: "secret",
    });

    expect(normalizeBodyForLog(params)).toEqual({
      grant_type: "client_credentials",
      client_secret: "[REDACTED]",
    });
  });

  it("truncates large string bodies", () => {
    const long = "x".repeat(100);
    const result = truncateForLog(long, 20);
    expect(result).toContain("[truncated 80 chars]");
    expect(result.length).toBeLessThan(long.length);
  });

  it("reads response bodies without consuming the original response", async () => {
    const response = new Response(JSON.stringify({ ok: true, access_token: "secret" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const logged = await readResponseBodyForLog(response);
    expect(logged).toEqual({ ok: true, access_token: "[REDACTED]" });

    const original = await response.json();
    expect(original).toEqual({ ok: true, access_token: "secret" });
  });
});
