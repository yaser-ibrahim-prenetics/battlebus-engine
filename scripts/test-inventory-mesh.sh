#!/bin/bash

# Test script for Inventory Sync Mesh API
# Usage: ./test-inventory-mesh.sh [battle-bus-url]

BATTLE_BUS_URL=${1:-"http://localhost:7000"}

echo "=========================================="
echo "Testing Inventory Sync Mesh API"
echo "Battle Bus URL: $BATTLE_BUS_URL"
echo "=========================================="
echo ""

# Test 1: Get API documentation
echo "Test 1: Get API documentation"
echo "GET $BATTLE_BUS_URL/api/inventory/sync?docs=true"
echo ""
curl -s -X GET "${BATTLE_BUS_URL}/api/inventory/sync?docs=true" | jq '.' || echo "Failed to get docs"
echo ""
echo "---"
echo ""

# Test 2: Health check
echo "Test 2: Health check"
echo "GET $BATTLE_BUS_URL/api/inventory/sync"
echo ""
curl -s -X GET "${BATTLE_BUS_URL}/api/inventory/sync" | jq '.' || echo "Failed health check"
echo ""
echo "---"
echo ""

# Test 3: Sync from Shopify to Dynamics
echo "Test 3: Sync inventory from Shopify to Dynamics"
echo "POST $BATTLE_BUS_URL/api/inventory/sync?from=shopify&to=dynamics"
echo ""
PAYLOAD1=$(cat <<EOF
{
  "sku": "TEST-SKU-001",
  "inventoryItemId": "123456789",
  "locationId": "79527313640",
  "quantity": 100,
  "available": 95,
  "action": "update",
  "reason": "Test sync from Shopify to Dynamics"
}
EOF
)
echo "Payload:"
echo "$PAYLOAD1" | jq '.'
echo ""
echo "Response:"
curl -s -X POST "${BATTLE_BUS_URL}/api/inventory/sync?from=shopify&to=dynamics" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD1" | jq '.' || echo "Failed to sync"
echo ""
echo "---"
echo ""

# Test 4: Sync from Shopify to GPS
echo "Test 4: Sync inventory from Shopify to GPS"
echo "POST $BATTLE_BUS_URL/api/inventory/sync?from=shopify&to=gps"
echo ""
PAYLOAD2=$(cat <<EOF
{
  "sku": "TEST-SKU-002",
  "inventoryItemId": "987654321",
  "locationId": "79527313640",
  "quantity": 50,
  "available": 48,
  "action": "update",
  "reason": "Test sync from Shopify to GPS"
}
EOF
)
echo "Payload:"
echo "$PAYLOAD2" | jq '.'
echo ""
echo "Response:"
curl -s -X POST "${BATTLE_BUS_URL}/api/inventory/sync?from=shopify&to=gps" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD2" | jq '.' || echo "Failed to sync"
echo ""
echo "---"
echo ""

# Test 5: Sync from Shopify to multiple destinations
echo "Test 5: Sync inventory from Shopify to Dynamics and GPS"
echo "POST $BATTLE_BUS_URL/api/inventory/sync?from=shopify&to=dynamics,gps"
echo ""
PAYLOAD3=$(cat <<EOF
{
  "sku": "TEST-SKU-003",
  "inventoryItemId": "555666777",
  "locationId": "79527313640",
  "quantity": 200,
  "available": 195,
  "action": "update",
  "reason": "Test sync to multiple destinations"
}
EOF
)
echo "Payload:"
echo "$PAYLOAD3" | jq '.'
echo ""
echo "Response:"
curl -s -X POST "${BATTLE_BUS_URL}/api/inventory/sync?from=shopify&to=dynamics,gps" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD3" | jq '.' || echo "Failed to sync"
echo ""
echo "---"
echo ""

# Test 6: Sync from warehouse to Shopify
echo "Test 6: Sync inventory from warehouse to Shopify"
echo "POST $BATTLE_BUS_URL/api/inventory/sync?from=warehouse&to=shopify"
echo ""
PAYLOAD4=$(cat <<EOF
{
  "sku": "TEST-SKU-004",
  "available": 75,
  "warehouseId": "GPS-US",
  "warehouseName": "GPS Warehouse",
  "action": "update",
  "reason": "Test sync from warehouse to Shopify"
}
EOF
)
echo "Payload:"
echo "$PAYLOAD4" | jq '.'
echo ""
echo "Response:"
curl -s -X POST "${BATTLE_BUS_URL}/api/inventory/sync?from=warehouse&to=shopify" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD4" | jq '.' || echo "Failed to sync"
echo ""
echo "---"
echo ""

# Test 7: Product deletion sync
echo "Test 7: Product deletion sync"
echo "POST $BATTLE_BUS_URL/api/inventory/sync?from=shopify&to=dynamics,gps"
echo ""
PAYLOAD5=$(cat <<EOF
{
  "productId": "999888777",
  "sku": "TEST-SKU-DELETE",
  "action": "delete",
  "reason": "Test product deletion"
}
EOF
)
echo "Payload:"
echo "$PAYLOAD5" | jq '.'
echo ""
echo "Response:"
curl -s -X POST "${BATTLE_BUS_URL}/api/inventory/sync?from=shopify&to=dynamics,gps" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD5" | jq '.' || echo "Failed to sync"
echo ""
echo "---"
echo ""

echo "=========================================="
echo "Inventory Mesh API Tests Complete"
echo "=========================================="

