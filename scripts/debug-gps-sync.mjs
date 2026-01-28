/**
 * Debug script to check GPS sync logic
 * Usage: node scripts/debug-gps-sync.mjs
 */

const SHOPIFY_SHOP_DOMAIN = 'im8health.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = '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';
const SHOPIFY_API_VERSION = '2024-07';

const GPS_METAFIELD_NAMESPACE = 'battle_bus';
const GPS_METAFIELD_KEY = 'gps_order';

function buildUrl(endpoint) {
  return `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${endpoint}`;
}

function getHeaders() {
  return {
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function getUnfulfilledOrders(limit = 250, daysBack = 30) {
  // Calculate date range - include orders from the last N days
  const minDate = new Date();
  minDate.setDate(minDate.getDate() - daysBack);
  const createdAtMin = minDate.toISOString();
  
  const url = buildUrl(`/orders.json?fulfillment_status=unfulfilled&limit=${limit}&created_at_min=${createdAtMin}`);
  console.log(`Fetching unfulfilled orders from: ${url}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get unfulfilled orders: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.orders;
}

async function getOrderByName(orderName) {
  const url = buildUrl(`/orders.json?name=${encodeURIComponent(orderName)}&status=any`);
  console.log(`Fetching order by name from: ${url}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get order: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.orders?.[0];
}

async function getGpsMetafield(orderId) {
  const url = buildUrl(`/orders/${orderId}/metafields.json?namespace=${GPS_METAFIELD_NAMESPACE}`);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: getHeaders(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get metafields: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const metafields = data.metafields || [];
  
  const gpsMetafield = metafields.find(
    mf => mf.namespace === GPS_METAFIELD_NAMESPACE && mf.key === GPS_METAFIELD_KEY
  );

  return gpsMetafield ? JSON.parse(gpsMetafield.value) : null;
}

async function main() {
  console.log('='.repeat(60));
  console.log('DEBUG: GPS Sync Logic');
  console.log('='.repeat(60));
  console.log('');

  // Step 1: Check unfulfilled orders
  console.log('Step 1: Fetching unfulfilled orders...');
  const unfulfilledOrders = await getUnfulfilledOrders();
  console.log(`Found ${unfulfilledOrders.length} unfulfilled orders`);
  
  if (unfulfilledOrders.length > 0) {
    console.log('Order names:', unfulfilledOrders.map(o => o.name).join(', '));
  }
  console.log('');

  // Step 2: Check if IM8-14959 is in the list
  console.log('Step 2: Looking for IM8-14959 in unfulfilled orders...');
  const targetOrder = unfulfilledOrders.find(o => o.name === 'IM8-14959');
  if (targetOrder) {
    console.log('✅ IM8-14959 IS in the unfulfilled orders list');
    console.log(`   ID: ${targetOrder.id}`);
    console.log(`   Fulfillment Status: ${targetOrder.fulfillment_status}`);
  } else {
    console.log('❌ IM8-14959 is NOT in the unfulfilled orders list');
  }
  console.log('');

  // Step 3: Get IM8-14959 directly
  console.log('Step 3: Fetching IM8-14959 directly...');
  const directOrder = await getOrderByName('IM8-14959');
  if (directOrder) {
    console.log(`✅ Found order directly:`);
    console.log(`   ID: ${directOrder.id}`);
    console.log(`   Name: ${directOrder.name}`);
    console.log(`   Fulfillment Status: ${directOrder.fulfillment_status || 'null (unfulfilled)'}`);
    console.log(`   Financial Status: ${directOrder.financial_status}`);
    console.log(`   Closed At: ${directOrder.closed_at}`);
    console.log(`   Cancelled At: ${directOrder.cancelled_at}`);
    
    // Check metafield
    console.log('');
    console.log('Step 4: Checking GPS metafield...');
    const gpsData = await getGpsMetafield(directOrder.id);
    if (gpsData) {
      console.log('✅ GPS metafield found:');
      console.log(JSON.stringify(gpsData, null, 2));
    } else {
      console.log('❌ No GPS metafield found');
    }
  } else {
    console.log('❌ Order IM8-14959 not found');
  }
  console.log('');

  // Step 5: Check GPS metafield specifically for IM8-14959 if it's in the list
  if (targetOrder) {
    console.log('Step 5: Checking GPS metafield for IM8-14959 from the unfulfilled list...');
    const gpsDataFromList = await getGpsMetafield(targetOrder.id);
    if (gpsDataFromList) {
      console.log('✅ GPS metafield found from unfulfilled list:');
      console.log(JSON.stringify(gpsDataFromList, null, 2));
    } else {
      console.log('❌ No GPS metafield found when checking from unfulfilled list');
    }
  }
  
  // Step 6: Check how many unfulfilled orders have GPS metafields (all of them)
  console.log('');
  console.log('Step 6: Checking GPS metafields for ALL unfulfilled orders...');
  console.log('This may take a while...');
  let ordersWithGps = 0;
  const ordersWithGpsList = [];
  for (const order of unfulfilledOrders) {
    const gpsData = await getGpsMetafield(order.id);
    if (gpsData) {
      ordersWithGps++;
      ordersWithGpsList.push({ name: order.name, gpsOrderId: gpsData.gpsOrderId });
      console.log(`  ✅ ${order.name} has GPS metafield: ${gpsData.gpsOrderId}`);
    }
  }
  console.log(`Found ${ordersWithGps} orders with GPS metafields (checked all ${unfulfilledOrders.length})`);

  console.log('');
  console.log('='.repeat(60));
  console.log('Done');
  console.log('='.repeat(60));
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
