import { afterEach, describe, expect, it } from "vitest";

import { requireServiceAuth } from "../service-auth";

const originalApiKey = process.env.BATTLE_BUS_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.BATTLE_BUS_API_KEY;
  } else {
    process.env.BATTLE_BUS_API_KEY = originalApiKey;
  }
});

describe("requireServiceAuth", () => {
  it("fails closed when no service key is configured", () => {
    delete process.env.BATTLE_BUS_API_KEY;

    const result = requireServiceAuth(new Request("https://battle-bus.test/api/internal"));

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: "service_auth_not_configured" },
    });
  });

  it("rejects an invalid API key", () => {
    process.env.BATTLE_BUS_API_KEY = "expected-secret";

    const result = requireServiceAuth(
      new Request("https://battle-bus.test/api/internal", {
        headers: { "x-api-key": "wrong-secret" },
      })
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("accepts the configured key from x-api-key or Bearer auth", () => {
    process.env.BATTLE_BUS_API_KEY = "expected-secret";

    expect(
      requireServiceAuth(
        new Request("https://battle-bus.test/api/internal", {
          headers: { "x-api-key": "expected-secret" },
        })
      )
    ).toEqual({ ok: true });

    expect(
      requireServiceAuth(
        new Request("https://battle-bus.test/api/internal", {
          headers: { authorization: "Bearer expected-secret" },
        })
      )
    ).toEqual({ ok: true });
  });
});
