// Test D365 Inventory API

const D365_BASE_URL = "https://p-uat.sandbox.operations.dynamics.com";
const D365_TENANT_ID = "fdea3f0c-62d4-40b7-bb83-017d9e8f6bd7";
const D365_CLIENT_ID = "740f1eb2-8f38-4c57-8150-81836a399a8e";
const D365_CLIENT_SECRET = "dEP8Q~WmFC9TWibaH3~rETToqmZDeh666zYEqcA3";

async function getToken() {
  const tokenUrl = `https://login.microsoftonline.com/${D365_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: D365_CLIENT_ID,
    client_secret: D365_CLIENT_SECRET,
    scope: `${D365_BASE_URL}/.default`,
  });
  
  console.log("Authenticating to D365...");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Auth failed: ${res.status} - ${err}`);
  }
  
  const token = await res.json();
  console.log("✅ Authenticated, token expires in", token.expires_in, "seconds");
  return token.access_token;
}

async function getInventory(accessToken: string) {
  // Try InventorySitesOnHandV2 endpoint
  const url = `${D365_BASE_URL}/data/InventorySitesOnHandV2?cross-company=true&$top=5`;
  console.log("Fetching inventory from:", url);
  
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
    },
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Inventory fetch failed: ${res.status} - ${err.substring(0, 500)}`);
  }
  
  const data = await res.json();
  console.log("✅ Inventory response:");
  console.log(JSON.stringify(data, null, 2));
  return data;
}

async function main() {
  try {
    const token = await getToken();
    await getInventory(token);
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

main();
