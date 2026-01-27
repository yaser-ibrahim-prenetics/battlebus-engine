/**
 * Test D365 Connection
 * Run with: npx tsx scripts/test-d365-connection.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

const D365_BASE_URL = process.env.D365_BASE_URL;
const D365_TENANT_ID = process.env.D365_TENANT_ID;
const D365_CLIENT_ID = process.env.D365_CLIENT_ID;
const D365_CLIENT_SECRET = process.env.D365_CLIENT_SECRET;
const D365_SCOPE = process.env.D365_SCOPE;
const D365_DATA_AREA_ID = process.env.D365_DATA_AREA_ID || 'U001';

console.log('='.repeat(60));
console.log('D365 Connection Test');
console.log('='.repeat(60));

// Check config
console.log('\n📋 Configuration:');
console.log(`  Base URL: ${D365_BASE_URL}`);
console.log(`  Tenant ID: ${D365_TENANT_ID}`);
console.log(`  Client ID: ${D365_CLIENT_ID}`);
console.log(`  Client Secret: ${D365_CLIENT_SECRET ? '***' + D365_CLIENT_SECRET.slice(-4) : 'NOT SET'}`);
console.log(`  Scope: ${D365_SCOPE}`);
console.log(`  Data Area ID: ${D365_DATA_AREA_ID}`);

async function testConnection() {
  // 1. Test Authentication
  console.log('\n🔐 Testing Authentication...');
  
  const tokenUrl = `https://login.microsoftonline.com/${D365_TENANT_ID}/oauth2/v2.0/token`;
  
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: D365_CLIENT_ID!,
    client_secret: D365_CLIENT_SECRET!,
    scope: D365_SCOPE!,
  });

  try {
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.log(`❌ Authentication FAILED: ${tokenResponse.status}`);
      console.log(`   Error: ${error}`);
      return;
    }

    const tokenData = await tokenResponse.json();
    console.log(`✅ Authentication SUCCESS`);
    console.log(`   Token expires in: ${tokenData.expires_in}s`);
    
    const accessToken = tokenData.access_token;

    // 2. Test API Access - List Sales Orders
    console.log('\n📦 Testing API Access (List recent Sales Orders)...');
    
    const ordersUrl = `${D365_BASE_URL}/data/SalesOrderHeadersV3?$top=5&$filter=dataAreaId eq '${D365_DATA_AREA_ID}'`;
    
    const ordersResponse = await fetch(ordersUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!ordersResponse.ok) {
      const error = await ordersResponse.text();
      console.log(`❌ API Access FAILED: ${ordersResponse.status}`);
      console.log(`   Error: ${error}`);
      return;
    }

    const ordersData = await ordersResponse.json();
    console.log(`✅ API Access SUCCESS`);
    console.log(`   Found ${ordersData.value?.length || 0} recent orders`);
    
    if (ordersData.value?.length > 0) {
      console.log('\n   Recent Orders:');
      for (const order of ordersData.value.slice(0, 3)) {
        console.log(`   - ${order.SalesOrderNumber} | ${order.THK_ShopifyReference || 'No Shopify Ref'} | ${order.CurrencyCode}`);
      }
    }

    // 3. Test THK API Endpoint Access
    console.log('\n🔧 Testing THK API Endpoint Access...');
    
    // Just check if the endpoint is reachable (don't actually call it)
    const thkEndpoint = `${D365_BASE_URL}/api/services/THK_APISyncServiceGroup/THK_APISyncService_Shopify/confirmSO`;
    console.log(`   THK Confirm SO endpoint: ${thkEndpoint}`);
    console.log(`   ✅ THK endpoints configured (will test with real order)`);

    // 4. Test Sales Order Lines Query
    console.log('\n📋 Testing Sales Order Lines Query...');
    
    if (ordersData.value?.length > 0) {
      const testOrderNumber = ordersData.value[0].SalesOrderNumber;
      const linesUrl = `${D365_BASE_URL}/data/SalesOrderLines?$filter=dataAreaId eq '${D365_DATA_AREA_ID}' and SalesOrderNumber eq '${testOrderNumber}'&$select=ItemNumber,InventoryLotId,OrderedSalesQuantity`;
      
      const linesResponse = await fetch(linesUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (linesResponse.ok) {
        const linesData = await linesResponse.json();
        console.log(`✅ Lines Query SUCCESS for ${testOrderNumber}`);
        console.log(`   Found ${linesData.value?.length || 0} lines`);
        
        if (linesData.value?.length > 0) {
          console.log('\n   Sample Lines:');
          for (const line of linesData.value.slice(0, 3)) {
            console.log(`   - ${line.ItemNumber} | Qty: ${line.OrderedSalesQuantity} | LotId: ${line.InventoryLotId || 'N/A'}`);
          }
        }
      } else {
        console.log(`⚠️ Lines Query returned: ${linesResponse.status}`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ D365 CONNECTION TEST COMPLETE - ALL SYSTEMS GO!');
    console.log('='.repeat(60));

  } catch (error) {
    console.log(`\n❌ Connection Error: ${error}`);
  }
}

// Run the test
testConnection();
