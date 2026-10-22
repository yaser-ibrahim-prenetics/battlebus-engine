import { createHmac } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { config } from "@/lib/config";

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
let cached: { audience: string; account: string; token: string; expires: number } | undefined;
const paths = new Set([
  "/api/webhooks/orders", "/api/webhooks/products", "/api/webhooks/locations",
  "/api/webhooks/inventory", "/api/webhooks/probe",
]);

async function iapAuthorization(origin: string): Promise<string> {
  const account = process.env.BATTLE_HUB_CALLER_SERVICE_ACCOUNT || "";
  if (!account.endsWith(".iam.gserviceaccount.com")) throw new Error("Hub caller identity is not configured");
  const audience = `${origin}/*`;
  const now = Math.floor(Date.now() / 1000);
  if (cached?.audience === audience && cached.account === account && cached.expires > now + 60) {
    return `Bearer ${cached.token}`;
  }
  try {
    // IAM signs a ten-minute JWT with Google's managed key. No downloaded keys.
    const client = await auth.getClient();
    const response = await client.request<{ signedJwt: string }>({
      url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(account)}:signJwt`,
      method: "POST",
      timeout: 10000,
      data: { payload: JSON.stringify({ iss: account, sub: account, aud: audience, iat: now, exp: now + 600 }) },
    });
    if (!response.data.signedJwt) throw new Error("Missing JWT");
    cached = { audience, account, token: response.data.signedJwt, expires: now + 600 };
    return `Bearer ${cached.token}`;
  } catch {
    // Google auth errors can contain request headers. Never propagate those.
    throw new Error("Could not obtain the Battle Hub IAP credential");
  }
}

function hubBaseUrl(): URL {
  if (!config.csPlatform.baseUrl) throw new Error("Battle Hub URL is not configured");
  const base = new URL(config.csPlatform.baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname) && !process.env.K_SERVICE))) {
    throw new Error("Invalid Battle Hub service URL");
  }
  if (!config.csPlatform.webhookSecret) throw new Error("Battle Hub webhook signature key is not configured");
  return base;
}

async function addIapHeader(headers: Record<string, string>, origin: string) {
  if (process.env.BATTLE_HUB_IAP_ENABLED === "true") {
    headers.Authorization = await iapAuthorization(origin);
  } else if (process.env.K_SERVICE) {
    throw new Error("Cloud Run callbacks require Battle Hub IAP authentication");
  }
}

export async function readHubLocationMappings(): Promise<Response> {
  const base = hubBaseUrl();
  const headers = { "x-battle-bus-webhook-secret": config.csPlatform.webhookSecret };
  await addIapHeader(headers, base.origin);
  return fetch(`${base.origin}/api/locations/mappings`, {
    headers, redirect: "error", signal: AbortSignal.timeout(15000),
  });
}

export async function sendHubWebhook(path: string, data: unknown): Promise<Response> {
  if (!paths.has(path)) throw new Error("Unsupported Battle Hub webhook path");
  const base = hubBaseUrl();
  const payload = JSON.stringify(data);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Battle-Bus-Signature": createHmac("sha256", config.csPlatform.webhookSecret).update(payload).digest("hex"),
  };
  await addIapHeader(headers, base.origin);
  return fetch(`${base.origin}${path}`, {
    method: "POST", headers, body: payload, redirect: "error", signal: AbortSignal.timeout(15000),
  });
}
