#!/usr/bin/env tsx
/**
 * Query D365 OData metadata to see available fields
 */
import { config } from "../src/lib/config";

const D365_BASE_URL = config.dynamics.baseUrl;
const D365_TENANT_ID = config.dynamics.tenantId;
const D365_CLIENT_ID = config.dynamics.clientId;
const D365_CLIENT_SECRET = config.dynamics.clientSecret;
const D365_SCOPE = config.dynamics.scope;

async function getAuthToken(): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${D365_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: D365_CLIENT_ID,
    client_secret: D365_CLIENT_SECRET,
    scope: D365_SCOPE,
  });
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`Auth failed: ${await response.text()}`);
  const token = await response.json();
  return token.access_token;
}

async function queryMetadata() {
  const token = await getAuthToken();

  // Try to get metadata for ReleasedProductsV2
  console.log("Querying ReleasedProductsV2 metadata...");
  const metadataUrl = `${D365_BASE_URL}/data/$metadata#ReleasedProductsV2`;
  const response = await fetch(metadataUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/xml",
    },
  });

  if (response.ok) {
    const xml = await response.text();
    console.log("Metadata (first 2000 chars):");
    console.log(xml.substring(0, 2000));
  } else {
    console.log(`Failed: ${response.status}`);
    console.log(await response.text());
  }

  // Try to query an existing product to see what fields are returned
  console.log("\n\nQuerying existing product to see fields...");
  const queryUrl = `${D365_BASE_URL}/data/ReleasedProductsV2?$top=1`;
  const queryResponse = await fetch(queryUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (queryResponse.ok) {
    const data = await queryResponse.json();
    if (data.value && data.value.length > 0) {
      console.log("\nSample product fields:");
      console.log(JSON.stringify(data.value[0], null, 2));
    } else {
      console.log("No products found");
    }
  } else {
    console.log(`Query failed: ${queryResponse.status}`);
    console.log(await queryResponse.text());
  }
}

queryMetadata().catch(console.error);
