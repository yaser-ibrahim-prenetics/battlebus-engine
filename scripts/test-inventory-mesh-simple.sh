#!/bin/bash

# Simple test script for Inventory Sync Mesh API
# Make sure battle-bus-inngest is running: npm run dev (port 7000)

BATTLE_BUS_URL=${1:-"http://localhost:7000"}

echo "Testing Inventory Sync Mesh API at: $BATTLE_BUS_URL"
echo ""

# Test 1: Health check
echo "1. Health Check:"
curl -s -X GET "${BATTLE_BUS_URL}/api/inventory/sync" | jq '.' 2>/dev/null || curl -s -X GET "${BATTLE_BUS_URL}/api/inventory/sync"
echo ""
echo "---"
echo ""

# Test 2: Sync from Shopify to Dynamics
echo "2. Sync from Shopify to Dynamics:"
PAYLOAD='{
  "sku": "TEST-SKU-001",
  "inventoryItemId": "123456789",
  "locationId": "79527313640",
  "quantity": 100,
  "available": 95,
  "action": "update"
}'
echo "Payload: $PAYLOAD"
echo ""
curl -s -X POST "${BATTLE_BUS_URL}/api/inventory/sync?from=shopify&to=dynamics" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | jq '.' 2>/dev/null || curl -s -X POST "${BATTLE_BUS_URL}/api/inventory/sync?from=shopify&to=dynamics" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
echo ""
echo "---"
echo ""

# Test 3: Sync to multiple destinations
echo "3. Sync from Shopify to Dynamics and GPS:"
PAYLOAD2='{
  "sku": "TEST-SKU-002",
  "inventoryItemId": "987654321",
  "locationId": "79527313640",
  "quantity": 50,
  "action": "update"
}'
echo "Payload: $PAYLOAD2"
echo ""
curl -s -X POST "${BATTLE_BUS_URL}/api/inventory/sync?from=shopify&to=dynamics,gps" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD2" | jq '.' 2>/dev/null || curl -s -X POST "${BATTLE_BUS_URL}/api/inventory/sync?from=shopify&to=dynamics,gps" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD2"
echo ""

