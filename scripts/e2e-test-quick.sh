#!/bin/bash

# Quick E2E Test Script for Battle Bus Integrations
# Usage: ./e2e-test-quick.sh [test-number]
# Run without arguments to see all available tests

BATTLE_BUS_URL=${BATTLE_BUS_URL:-"http://localhost:7000"}
SHOPIFY_SHOP=${SHOPIFY_SHOP:-"im8-store.myshopify.com"}

echo "=========================================="
echo "Battle Bus E2E Quick Tests"
echo "Battle Bus URL: $BATTLE_BUS_URL"
echo "=========================================="
echo ""

# Test 1: Health Check
test_health() {
  echo "Test 1: Health Check"
  curl -s "$BATTLE_BUS_URL/api/inventory/sync" | jq '.' || echo "Failed"
  echo ""
}

# Test 2: Inventory Sync Mesh
test_inventory_sync() {
  echo "Test 2: Inventory Sync Mesh (Shopify → Dynamics)"
  curl -s -X POST "$BATTLE_BUS_URL/api/inventory/sync?from=shopify&to=dynamics" \
    -H "Content-Type: application/json" \
    -d '{
      "sku": "E2E-TEST-001",
      "inventoryItemId": "123456789",
      "locationId": "79527313640",
      "quantity": 100,
      "action": "update"
    }' | jq '.'
  echo ""
}

# Test 3: Order Details API
test_order_details() {
  echo "Test 3: Order Details API"
  if [ -z "$1" ]; then
    echo "Usage: test_order_details <orderName>"
    return
  fi
  curl -s -X POST "$BATTLE_BUS_URL/api/shopify/order-details" \
    -H "Content-Type: application/json" \
    -d "{\"orderName\": \"$1\"}" | jq '.'
  echo ""
}

# Test 4: Cancel Order
test_cancel_order() {
  echo "Test 4: Cancel Order"
  if [ -z "$1" ]; then
    echo "Usage: test_cancel_order <orderName>"
    return
  fi
  curl -s -X POST "$BATTLE_BUS_URL/api/actions/cancel" \
    -H "Content-Type: application/json" \
    -d "{
      \"orderName\": \"$1\",
      \"reason\": \"e2e_test\",
      \"email\": false,
      \"refund\": false
    }" | jq '.'
  echo ""
}

# Test 5: Refund Order
test_refund_order() {
  echo "Test 5: Refund Order"
  if [ -z "$1" ]; then
    echo "Usage: test_refund_order <orderName> [amount]"
    return
  fi
  AMOUNT=${2:-"50.00"}
  curl -s -X POST "$BATTLE_BUS_URL/api/actions/refund" \
    -H "Content-Type: application/json" \
    -d "{
      \"orderName\": \"$1\",
      \"amount\": $AMOUNT,
      \"reason\": \"e2e_test\",
      \"restock\": false,
      \"notify\": false
    }" | jq '.'
  echo ""
}

# Test 6: Fulfill Order
test_fulfill_order() {
  echo "Test 6: Fulfill Order (Manual)"
  if [ -z "$1" ]; then
    echo "Usage: test_fulfill_order <orderName> [fulfillmentOrderId]"
    return
  fi
  FULFILLMENT_ORDER_ID=${2:-""}
  curl -s -X POST "$BATTLE_BUS_URL/api/actions/fulfillment" \
    -H "Content-Type: application/json" \
    -d "{
      \"orderName\": \"$1\",
      \"fulfillmentType\": \"manual\",
      \"trackingNumber\": \"E2E-TEST-$(date +%s)\",
      \"carrier\": \"UPS\",
      \"fulfillmentOrderId\": \"$FULFILLMENT_ORDER_ID\",
      \"notifyCustomer\": false
    }" | jq '.'
  echo ""
}

# Test 7: Shopify Webhook Simulation
test_webhook() {
  echo "Test 7: Shopify Webhook Simulation"
  TOPIC=${1:-"orders/create"}
  echo "Topic: $TOPIC"
  echo "Note: If Inngest dev server is not running, webhook will still return success but events will be queued."
  echo ""
  RESPONSE=$(curl -s -X POST "$BATTLE_BUS_URL/api/webhooks/shopify" \
    -H "Content-Type: application/json" \
    -H "x-shopify-topic: $TOPIC" \
    -H "x-shopify-shop-domain: $SHOPIFY_SHOP" \
    -H "x-shopify-webhook-id: e2e-test-$(date +%s)" \
    -H "x-shopify-api-version: 2024-01" \
    -d '{
      "id": 999999999,
      "name": "IM8-E2E-TEST",
      "email": "e2e@test.com",
      "financial_status": "paid",
      "total_price": "100.00"
    }')
  
  echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"
  
  # Check if Inngest error is mentioned
  if echo "$RESPONSE" | grep -q "Inngest"; then
    echo ""
    echo "⚠️  Note: Inngest may not be running. Start it with: npm run dev:inngest"
    echo "   Webhook was received successfully, but events may be queued."
  fi
  echo ""
}

# Main menu
if [ -z "$1" ]; then
  echo "Available Tests:"
  echo "  1) Health Check"
  echo "  2) Inventory Sync Mesh"
  echo "  3) Order Details API (requires orderName)"
  echo "  4) Cancel Order (requires orderName)"
  echo "  5) Refund Order (requires orderName, optional amount)"
  echo "  6) Fulfill Order (requires orderName, optional fulfillmentOrderId)"
  echo "  7) Shopify Webhook (optional topic)"
  echo ""
  echo "Usage:"
  echo "  ./e2e-test-quick.sh 1                    # Run test 1"
  echo "  ./e2e-test-quick.sh 3 IM8-12345          # Run test 3 with orderName"
  echo "  ./e2e-test-quick.sh 7 orders/paid        # Run test 7 with topic"
  echo ""
  echo "Environment Variables:"
  echo "  BATTLE_BUS_URL=$BATTLE_BUS_URL"
  echo "  SHOPIFY_SHOP=$SHOPIFY_SHOP"
  exit 0
fi

# Run selected test
case "$1" in
  1) test_health ;;
  2) test_inventory_sync ;;
  3) test_order_details "$2" ;;
  4) test_cancel_order "$2" ;;
  5) test_refund_order "$2" "$3" ;;
  6) test_fulfill_order "$2" "$3" ;;
  7) test_webhook "$2" ;;
  *)
    echo "Invalid test number: $1"
    echo "Run without arguments to see available tests"
    exit 1
    ;;
esac

echo "=========================================="
echo "Test Complete"
echo "=========================================="

