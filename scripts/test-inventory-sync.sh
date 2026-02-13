#!/bin/bash
# ============================================================================
# TEST INVENTORY SYNC
# ============================================================================
# Tests inventory sync flow via the inventory mesh API
# Syncs inventory from Shopify to Dynamics and GPS

set -e

BATTLE_BUS_URL="${BATTLE_BUS_URL:-http://localhost:7000}"

echo "============================================================================"
echo "TEST INVENTORY SYNC"
echo "============================================================================"
echo "Battle Bus URL: $BATTLE_BUS_URL"
echo ""

# Test 1: Health check
echo "1️⃣  Testing API health check..."
HEALTH_RESPONSE=$(curl -s "$BATTLE_BUS_URL/api/inventory/sync")
echo "$HEALTH_RESPONSE" | jq '.' 2>/dev/null || echo "$HEALTH_RESPONSE"
echo ""

# Test 2: Sync inventory from Shopify to Dynamics
echo "2️⃣  Testing Shopify → Dynamics inventory sync..."
SYNC_PAYLOAD=$(cat <<EOF
{
  "source": "shopify",
  "destinations": ["dynamics"],
  "inventory": {
    "sku": "TEST-SKU-001",
    "inventoryItemId": "46166911778983",
    "locationId": "79527313640",
    "quantity": 100,
    "available": 100,
    "warehouseName": "GPS Warehouse"
  }
}
EOF
)

SYNC_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$BATTLE_BUS_URL/api/inventory/sync" \
  -H "Content-Type: application/json" \
  -d "$SYNC_PAYLOAD")

SYNC_HTTP_CODE=$(echo "$SYNC_RESPONSE" | tail -n1)
SYNC_BODY=$(echo "$SYNC_RESPONSE" | sed '$d')

echo "Response Code: $SYNC_HTTP_CODE"
echo "Response Body:"
echo "$SYNC_BODY" | jq '.' 2>/dev/null || echo "$SYNC_BODY"
echo ""

if [ "$SYNC_HTTP_CODE" -eq 200 ] || [ "$SYNC_HTTP_CODE" -eq 201 ]; then
  echo "✅ Inventory sync initiated successfully!"
else
  echo "❌ Inventory sync failed with status $SYNC_HTTP_CODE"
fi

# Test 3: Sync inventory from Shopify to multiple destinations
echo "3️⃣  Testing Shopify → Dynamics + GPS inventory sync..."
MULTI_SYNC_PAYLOAD=$(cat <<EOF
{
  "source": "shopify",
  "destinations": ["dynamics", "gps"],
  "inventory": {
    "sku": "TEST-SKU-002",
    "inventoryItemId": "46166911778984",
    "locationId": "79527313640",
    "quantity": 50,
    "available": 50,
    "warehouseName": "GPS Warehouse"
  }
}
EOF
)

MULTI_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$BATTLE_BUS_URL/api/inventory/sync" \
  -H "Content-Type: application/json" \
  -d "$MULTI_SYNC_PAYLOAD")

MULTI_HTTP_CODE=$(echo "$MULTI_RESPONSE" | tail -n1)
MULTI_BODY=$(echo "$MULTI_RESPONSE" | sed '$d')

echo "Response Code: $MULTI_HTTP_CODE"
echo "Response Body:"
echo "$MULTI_BODY" | jq '.' 2>/dev/null || echo "$MULTI_BODY"
echo ""

if [ "$MULTI_HTTP_CODE" -eq 200 ] || [ "$MULTI_HTTP_CODE" -eq 201 ]; then
  echo "✅ Multi-destination inventory sync initiated successfully!"
else
  echo "❌ Multi-destination inventory sync failed with status $MULTI_HTTP_CODE"
fi

echo ""
echo "============================================================================"
echo "TEST COMPLETE"
echo "============================================================================"
echo "Next steps:"
echo "1. Check Inngest dashboard for inventory sync processing"
echo "2. Verify inventory in Dynamics (if Dynamics sync enabled)"
echo "3. Verify inventory in GPS (if GPS sync enabled)"
echo "4. Check Battle Hub for inventory updates"

