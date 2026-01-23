/**
 * Script to list available items/SKUs from D365
 * Run with: npx tsx scripts/list-d365-items.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const D365_BASE_URL = process.env.D365_BASE_URL;
const D365_TENANT_ID = process.env.D365_TENANT_ID;
const D365_CLIENT_ID = process.env.D365_CLIENT_ID;
const D365_CLIENT_SECRET = process.env.D365_CLIENT_SECRET;
const D365_SCOPE = process.env.D365_SCOPE;

async function getAuthToken(): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${D365_TENANT_ID}/oauth2/v2.0/token`;
  
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: D365_CLIENT_ID!,
      client_secret: D365_CLIENT_SECRET!,
      scope: D365_SCOPE!,
    }),
  });

  if (!response.ok) {
    throw new Error(`Auth failed: ${await response.text()}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function listItems(searchTerm?: string) {
  const token = await getAuthToken();
  
  // Query released products (items available for sale)
  let url = `${D365_BASE_URL}/data/ReleasedProducts?$top=50&$select=ItemNumber,ProductName,ProductDescription`;
  
  if (searchTerm) {
    url += `&$filter=contains(ItemNumber,'${searchTerm}') or contains(ProductName,'${searchTerm}')`;
  }

  console.log(`\nQuerying D365: ${url}\n`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Query failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  
  console.log(`Found ${data.value.length} items:\n`);
  console.log("ItemNumber".padEnd(25) + "ProductName");
  console.log("-".repeat(80));
  
  for (const item of data.value) {
    console.log(`${(item.ItemNumber || "").padEnd(25)}${item.ProductName || item.ProductDescription || ""}`);
  }

  return data.value;
}

async function searchServiceItems() {
  const token = await getAuthToken();
  
  // Search for service items (SER in the name)
  const url = `${D365_BASE_URL}/data/ReleasedProducts?$filter=contains(ItemNumber,'SER') or contains(ItemNumber,'SERVICE') or contains(ProductName,'Service') or contains(ProductName,'Tax') or contains(ProductName,'Shipping')&$select=ItemNumber,ProductName,ProductDescription&$top=50`;

  console.log(`\nSearching for service items...\n`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Query failed: ${response.status} - ${error}`);
  }

  const data = await response.json();
  
  if (data.value.length === 0) {
    console.log("No service items found. Listing all IM8 items instead...\n");
    return listItems("IM8");
  }

  console.log(`Found ${data.value.length} service items:\n`);
  console.log("ItemNumber".padEnd(25) + "ProductName");
  console.log("-".repeat(80));
  
  for (const item of data.value) {
    console.log(`${(item.ItemNumber || "").padEnd(25)}${item.ProductName || item.ProductDescription || ""}`);
  }

  return data.value;
}

// Main
const args = process.argv.slice(2);
const searchTerm = args[0];

if (searchTerm === "--service") {
  searchServiceItems().catch(console.error);
} else if (searchTerm) {
  console.log(`Searching for items containing: "${searchTerm}"`);
  listItems(searchTerm).catch(console.error);
} else {
  console.log("Listing all IM8 items...");
  listItems("IM8").catch(console.error);
}
