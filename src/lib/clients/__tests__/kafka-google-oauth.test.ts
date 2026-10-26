import { afterEach, describe, expect, it, vi } from "vitest";

const getAccessToken = vi.fn();
const getCredentials = vi.fn();
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getClient = async () => ({ getAccessToken, credentials: { expiry_date: 1_800_000_000_000 } });
    getCredentials = getCredentials;
  },
}));

const decode = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

describe("Google Managed Kafka OAuth token", () => {
  afterEach(() => {
    vi.resetModules();
    getAccessToken.mockReset();
    getCredentials.mockReset();
  });

  it("wraps the runtime service account access token in the managed Kafka format", async () => {
    getAccessToken.mockResolvedValue({ token: "ya29.access" });
    getCredentials.mockResolvedValue({ client_email: "battle-bus-runtime@battle-bus-509406.iam.gserviceaccount.com" });
    const { googleManagedKafkaToken } = await import("../kafka");

    const [header, payload, token] = (await googleManagedKafkaToken()).split(".");
    expect(decode(header)).toEqual({ typ: "JWT", alg: "GOOG_OAUTH2_TOKEN" });
    expect(decode(payload)).toMatchObject({
      exp: 1_800_000_000,
      iss: "Google",
      scope: "kafka",
      sub: "battle-bus-runtime@battle-bus-509406.iam.gserviceaccount.com",
    });
    expect(Buffer.from(token, "base64url").toString("utf8")).toBe("ya29.access");
  });

  it("does not propagate Google auth errors, which can contain request headers", async () => {
    getAccessToken.mockRejectedValue(new Error("401 Authorization: Bearer secret"));
    getCredentials.mockResolvedValue({ client_email: "x@y" });
    const { googleManagedKafkaToken } = await import("../kafka");

    await expect(googleManagedKafkaToken()).rejects.toThrow("Could not obtain the Kafka OAuth credential");
    await expect(googleManagedKafkaToken()).rejects.not.toThrow(/secret/);
  });
});
