/**
 * Test Shopify Connection
 * Run with: npx tsx scripts/test-shopify-connection.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_IM8_SHOP_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_IM8_ACCESS_TOKEN;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_IM8_WEBHOOK_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-07';
const SHOPIFY_LOCATION_GPS = process.env.SHOPIFY_LOCATION_GPS;
const SHOPIFY_LOCATION_GPS_UK = process.env.SHOPIFY_LOCATION_GPS_UK;

console.log('='.repeat(60));
console.log('Shopify Connection Test');
console.log('='.repeat(60));

// Check config
console.log('\n📋 Configuration:');
console.log(`  Shop Domain: ${SHOPIFY_SHOP_DOMAIN}`);
console.log(`  Access Token: ${SHOPIFY_ACCESS_TOKEN ? '***' + SHOPIFY_ACCESS_TOKEN.slice(-8) : 'NOT SET'}`);
console.log(`  Webhook Secret: ${SHOPIFY_WEBHOOK_SECRET ? '***' + SHOPIFY_WEBHOOK_SECRET.slice(-8) : 'NOT SET'}`);
console.log(`  API Version: ${SHOPIFY_API_VERSION}`);
console.log(`  GPS Location ID: ${SHOPIFY_LOCATION_GPS}`);
console.log(`  GPS UK Location ID: ${SHOPIFY_LOCATION_GPS_UK}`);

async function testConnection() {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_SHOP_DOMAIN) {
    console.log('\n❌ Shopify credentials not configured');
    return;
  }

  // Clean up domain for API calls
  const shopDomain = SHOPIFY_SHOP_DOMAIN.replace('https://', '').replace('http://', '');
  const apiUrl = `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;

  // 1. Test Authentication - Get Shop Info
  console.log('\n🔐 Testing Shopify API Authentication...');
  
  try {
    const shopResponse = await fetch(`${apiUrl}/shop.json`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    if (!shopResponse.ok) {
      const error = await shopResponse.text();
      console.log(`❌ Authentication FAILED: ${shopResponse.status}`);
      console.log(`   Error: ${error}`);
      return;
    }

    const shopData = await shopResponse.json();
    console.log(`✅ Authentication SUCCESS`);
    console.log(`   Shop Name: ${shopData.shop?.name}`);
    console.log(`   Shop Email: ${shopData.shop?.email}`);
    console.log(`   Currency: ${shopData.shop?.currency}`);

    // 2. Test Orders API - Get Recent Orders
    console.log('\n📦 Testing Orders API (Get 3 recent orders)...');
    
    const ordersResponse = await fetch(`${apiUrl}/orders.json?limit=3&status=any`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    if (ordersResponse.ok) {
      const ordersData = await ordersResponse.json();
      console.log(`✅ Orders API SUCCESS`);
      console.log(`   Found ${ordersData.orders?.length || 0} recent orders`);
      
      if (ordersData.orders?.length > 0) {
        console.log('\n   Recent Orders:');
        for (const order of ordersData.orders.slice(0, 3)) {
          console.log(`   - #${order.order_number} | ${order.email} | ${order.financial_status} | ${order.fulfillment_status || 'unfulfilled'}`);
        }
      }
    } else {
      console.log(`⚠️ Orders API returned: ${ordersResponse.status}`);
    }

    // 3. Test Locations API
    console.log('\n📍 Testing Locations API...');
    
    const locationsResponse = await fetch(`${apiUrl}/locations.json`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    if (locationsResponse.ok) {
      const locationsData = await locationsResponse.json();
      console.log(`✅ Locations API SUCCESS`);
      console.log(`   Found ${locationsData.locations?.length || 0} locations`);
      
      if (locationsData.locations?.length > 0) {
        console.log('\n   Locations:');
        for (const location of locationsData.locations) {
          const isGps = location.id.toString() === SHOPIFY_LOCATION_GPS;
          const isGpsUk = location.id.toString() === SHOPIFY_LOCATION_GPS_UK;
          const marker = isGps ? ' ← GPS (US)' : isGpsUk ? ' ← GPS (UK)' : '';
          console.log(`   - ${location.id} | ${location.name}${marker}`);
        }
      }
    } else {
      console.log(`⚠️ Locations API returned: ${locationsResponse.status}`);
    }

    // 4. Check Webhook Configuration
    console.log('\n🔔 Checking Webhook Configuration...');
    
    const webhooksResponse = await fetch(`${apiUrl}/webhooks.json`, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    if (webhooksResponse.ok) {
      const webhooksData = await webhooksResponse.json();
      console.log(`✅ Webhooks API SUCCESS`);
      console.log(`   Found ${webhooksData.webhooks?.length || 0} webhooks`);
      
      if (webhooksData.webhooks?.length > 0) {
        console.log('\n   Configured Webhooks:');
        for (const webhook of webhooksData.webhooks) {
          console.log(`   - ${webhook.topic} → ${webhook.address}`);
        }
      } else {
        console.log('\n   ⚠️ No webhooks configured yet');
        console.log('   You need to set up webhooks pointing to your Battle Bus endpoint');
      }
    } else {
      console.log(`⚠️ Webhooks API returned: ${webhooksResponse.status}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ SHOPIFY CONNECTION TEST COMPLETE');
    console.log('='.repeat(60));

  } catch (error) {
    console.log(`\n❌ Connection Error: ${error}`);
  }
}

testConnection();
