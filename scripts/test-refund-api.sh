#!/bin/bash

# Test script for refund API
# Usage: ./scripts/test-refund-api.sh <orderName> <lineItemId> [restockType]

set -e

BATTLE_BUS_URL="${BATTLE_BUS_URL:-https://battle-bus.vercel.app}"
ORDER_NAME="${1:-IM8-14937}"
LINE_ITEM_ID="${2:-16255787958504}"
RESTOCK_TYPE="${3:-cancel}"

echo "Testing Refund API"
echo "=================="
echo "Order Name: $ORDER_NAME"
echo "Line Item ID: $LINE_ITEM_ID"
echo "Restock Type: $RESTOCK_TYPE"
echo "Battle Bus URL: $BATTLE_BUS_URL"
echo ""

PAYLOAD=$(cat <<EOF
{
  "orderName": "$ORDER_NAME",
  "refundLineItems": [
    {
      "lineItemId": $LINE_ITEM_ID,
      "quantity": 1,
      "restockType": "$RESTOCK_TYPE"
    }
  ],
  "restock": true,
  "notify": true,
  "platform": "shopify",
  "reason": "test",
  "note": "test refund"
}
EOF
)

echo "Payload:"
echo "$PAYLOAD" | jq .
echo ""
echo "Sending request..."
echo ""

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$BATTLE_BUS_URL/api/actions/refund")

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS:/d')

echo "Response Status: $HTTP_STATUS"
echo "Response Body:"
echo "$BODY" | jq . 2>/dev/null || echo "$BODY"

if [ "$HTTP_STATUS" = "200" ]; then
  echo ""
  echo "✅ Refund created successfully!"
else
  echo ""
  echo "❌ Refund failed with status $HTTP_STATUS"
  exit 1
fi

