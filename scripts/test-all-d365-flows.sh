#!/bin/bash

# ============================================================================
# TEST ALL D365 FLOWS - Command Line Testing Script
# ============================================================================
# This script tests all D365 flows one by one via webhook calls
# Usage: ./scripts/test-all-d365-flows.sh [NGROK_URL]
# Example: ./scripts/test-all-d365-flows.sh https://b397937f982d.ngrok-free.app

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get ngrok URL from argument or use default
NGROK_URL="${1:-https://b397937f982d.ngrok-free.app}"
BASE_DIR="/Users/prenetics/work/Development/battle-bus/battle-bus-inngest"

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Testing All D365 Flows${NC}"
echo -e "${BLUE}NGROK URL: ${NGROK_URL}${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""

# Helper function to generate unique IDs
generate_id() {
  echo "$(date +%s)${RANDOM}"
}

# Helper function to wait and check logs
check_logs() {
  local search_term="$1"
  local flow_name="$2"
  echo -e "${YELLOW}Waiting 5 seconds for processing...${NC}"
  sleep 5
  echo -e "${YELLOW}Checking logs for: ${search_term}${NC}"
  tail -100 "${BASE_DIR}/logs/pm2-out.log" | grep -E "${search_term}" | tail -10 || echo "No logs found"
  echo ""
}

# ============================================================================
# FLOW 1: Create New Order (Shopify → D365)
# ============================================================================
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}FLOW 1: Create New Order (Shopify → D365)${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

ORDER_ID=$(generate_id)
ORDER_NAME="#TEST-ORDER-${ORDER_ID}"

echo "Order ID: ${ORDER_ID}"
echo "Order Name: ${ORDER_NAME}"
echo ""

curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/paid" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${ORDER_ID},
    \"name\": \"${ORDER_NAME}\",
    \"email\": \"test-order-${ORDER_ID}@example.com\",
    \"financial_status\": \"paid\",
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"total_price\": \"89.00\",
    \"currency\": \"USD\",
    \"tags\": \"\",
    \"test\": false,
    \"line_items\": [
      {
        \"id\": 1,
        \"sku\": \"IM8-WK-000010\",
        \"title\": \"Welcome Kit\",
        \"quantity\": 1,
        \"price\": \"89.00\",
        \"requires_shipping\": true,
        \"gift_card\": false,
        \"grams\": 350
      }
    ],
    \"shipping_address\": {
      \"first_name\": \"Test\",
      \"last_name\": \"Order\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\"
    },
    \"billing_address\": {
      \"country_code\": \"US\"
    },
    \"customer\": {
      \"id\": 9999001,
      \"email\": \"test-order-${ORDER_ID}@example.com\",
      \"first_name\": \"Test\",
      \"last_name\": \"Order\"
    }
  }" && echo ""

check_logs "${ORDER_NAME}|D365|Created sales order|Confirmed sales order|Created prepayment" "Flow 1"

echo ""
read -p "Press Enter to continue to Flow 2..."
echo ""

# ============================================================================
# FLOW 2: STORD/HK Fulfillment → D365 Packing Slip
# ============================================================================
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}FLOW 2: STORD/HK Fulfillment → D365 Packing Slip${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

FULFILLMENT_ORDER_ID=$(generate_id)
FULFILLMENT_ORDER_NAME="#TEST-FULFILL-${FULFILLMENT_ORDER_ID}"

echo "Order ID: ${FULFILLMENT_ORDER_ID}"
echo "Order Name: ${FULFILLMENT_ORDER_NAME}"
echo ""

# First create the order
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/paid" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${FULFILLMENT_ORDER_ID},
    \"name\": \"${FULFILLMENT_ORDER_NAME}\",
    \"email\": \"test-fulfill-${FULFILLMENT_ORDER_ID}@example.com\",
    \"financial_status\": \"paid\",
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"total_price\": \"89.00\",
    \"currency\": \"USD\",
        \"line_items\": [
      {
        \"id\": 1,
        \"sku\": \"IM8-WK-000010\",
        \"title\": \"Welcome Kit\",
        \"quantity\": 1,
        \"price\": \"89.00\"
      }
    ],
    \"shipping_address\": {
      \"first_name\": \"Test\",
      \"last_name\": \"Fulfill\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\"
    },
    \"billing_address\": {
      \"country_code\": \"US\"
    }
  }" > /dev/null 2>&1

echo "Waiting 10 seconds for order to be created in D365..."
sleep 10

# Now send fulfillment
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/fulfilled" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${FULFILLMENT_ORDER_ID},
    \"name\": \"${FULFILLMENT_ORDER_NAME}\",
    \"fulfillments\": [
      {
        \"id\": 1001,
        \"status\": \"success\",
        \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
        \"tracking_number\": \"TEST-TRACK-${FULFILLMENT_ORDER_ID}\",
        \"tracking_company\": \"FedEx\",
        \"location_id\": \"99999999999\",
        \"line_items\": [
          {
            \"id\": 1,
            \"sku\": \"IM8-WK-000010\",
            \"quantity\": 1
          }
        ]
      }
    ],
    \"line_items\": [
      {
        \"id\": 1,
        \"sku\": \"IM8-WK-000010\",
        \"quantity\": 1
      }
    ]
  }" && echo ""

check_logs "${FULFILLMENT_ORDER_NAME}|Creating fulfilment|Created fulfilment" "Flow 2"

echo ""
read -p "Press Enter to continue to Flow 3..."
echo ""

# ============================================================================
# FLOW 3: GPS Fulfillment (Cron - Manual Trigger Info)
# ============================================================================
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}FLOW 3: GPS Fulfillment → Shopify + D365 (Cron Polling)${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

echo -e "${YELLOW}This flow runs via cron job. To test:${NC}"
echo "1. Open Inngest Dev UI: http://localhost:8288"
echo "2. Find function: 'Sync GPS Fulfillments' (cron-gps-sync)"
echo "3. Click 'Trigger' to run manually"
echo "4. Or wait for cron to run automatically"
echo ""
echo -e "${YELLOW}Alternatively, check logs for GPS sync results:${NC}"
tail -50 "${BASE_DIR}/logs/pm2-out.log" | grep -E "GPS Sync|GPS.*fulfilled" | tail -5 || echo "No GPS sync logs found"
echo ""

read -p "Press Enter to continue to Flow 4..."
echo ""

# ============================================================================
# FLOW 4: Extensiv Fulfillment → Shopify + D365
# ============================================================================
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}FLOW 4: Extensiv Fulfillment → Shopify + D365${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

EXTENSIV_ORDER_ID=$(generate_id)
EXTENSIV_ORDER_NAME="#TEST-EXTENSIV-${EXTENSIV_ORDER_ID}"

echo "Order ID: ${EXTENSIV_ORDER_ID}"
echo "Order Name: ${EXTENSIV_ORDER_NAME}"
echo ""

curl -k -X POST "${NGROK_URL}/api/webhooks/extensiv" \
  -H "Content-Type: application/json" \
  -d "{
    \"tplId\": \"test-tpl-${EXTENSIV_ORDER_ID}\",
    \"wmsEventId\": \"wms-event-${EXTENSIV_ORDER_ID}\",
    \"dateTime\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"eventType\": \"OrderConfirm\",
    \"resource\": {
      \"rel\": \"order\",
      \"href\": \"/orders/${EXTENSIV_ORDER_ID}\",
      \"body\": {
        \"referenceNum\": \"${EXTENSIV_ORDER_NAME}\",
        \"readOnly\": {
          \"orderId\": ${EXTENSIV_ORDER_ID},
          \"customerIdentifier\": { \"id\": 53, \"name\": \"Test Customer\" },
          \"facilityIdentifier\": { \"id\": 2, \"name\": \"Charlotte Warehouse\" },
          \"createdByIdentifier\": { \"id\": 1, \"name\": \"System\" }
        },
        \"routingInfo\": {
          \"carrier\": \"FedEx\",
          \"mode\": \"Ground\",
          \"trackingNumber\": \"EXT-TRACK-${EXTENSIV_ORDER_ID}\"
        }
      }
    }
  }" && echo ""

check_logs "${EXTENSIV_ORDER_NAME}|Extensiv|Creating fulfilment|Created fulfilment" "Flow 4"

echo ""
read -p "Press Enter to continue to Flow 5..."
echo ""

# ============================================================================
# FLOW 5: Order Cancellation → D365 Return Order
# ============================================================================
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}FLOW 5: Order Cancellation → D365 Return Order${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

CANCEL_ORDER_ID=$(generate_id)
CANCEL_ORDER_NAME="#TEST-CANCEL-${CANCEL_ORDER_ID}"

echo "Order ID: ${CANCEL_ORDER_ID}"
echo "Order Name: ${CANCEL_ORDER_NAME}"
echo ""

# First create the order
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/paid" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${CANCEL_ORDER_ID},
    \"name\": \"${CANCEL_ORDER_NAME}\",
    \"email\": \"test-cancel-${CANCEL_ORDER_ID}@example.com\",
    \"financial_status\": \"paid\",
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"total_price\": \"89.00\",
    \"currency\": \"USD\",
        \"line_items\": [
      {
        \"id\": 1,
        \"sku\": \"IM8-WK-000010\",
        \"title\": \"Welcome Kit\",
        \"quantity\": 1,
        \"price\": \"89.00\"
      }
    ],
    \"shipping_address\": {
      \"first_name\": \"Test\",
      \"last_name\": \"Cancel\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\"
    },
    \"billing_address\": {
      \"country_code\": \"US\"
    }
  }" > /dev/null 2>&1

echo "Waiting 10 seconds for order to be created in D365..."
sleep 10

# Now send cancellation
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/cancelled" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${CANCEL_ORDER_ID},
    \"name\": \"${CANCEL_ORDER_NAME}\",
    \"cancel_reason\": \"customer\",
    \"cancelled_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"line_items\": [
      {
        \"id\": 1,
        \"sku\": \"IM8-WK-000010\",
        \"quantity\": 1,
        \"price\": \"89.00\"
      }
    ],
    \"shipping_address\": {
      \"first_name\": \"Test\",
      \"last_name\": \"Cancel\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\"
    },
    \"customer\": {
      \"id\": 9999002,
      \"email\": \"test-cancel-${CANCEL_ORDER_ID}@example.com\",
      \"first_name\": \"Test\",
      \"last_name\": \"Cancel\"
    }
  }" && echo ""

check_logs "${CANCEL_ORDER_NAME}|Creating return sales order|Created return sales order|Return Order" "Flow 5"

echo ""
read -p "Press Enter to continue to Flow 7..."
echo ""

# ============================================================================
# FLOW 7: Refund → D365 Return Order
# ============================================================================
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}FLOW 7: Refund → D365 Return Order${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

REFUND_ORDER_ID=$(generate_id)
REFUND_ORDER_NAME="#TEST-REFUND-${REFUND_ORDER_ID}"

echo "Order ID: ${REFUND_ORDER_ID}"
echo "Order Name: ${REFUND_ORDER_NAME}"
echo ""

# First create the order
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/paid" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${REFUND_ORDER_ID},
    \"name\": \"${REFUND_ORDER_NAME}\",
    \"email\": \"test-refund-${REFUND_ORDER_ID}@example.com\",
    \"financial_status\": \"paid\",
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"total_price\": \"89.00\",
    \"currency\": \"USD\",
        \"line_items\": [
      {
        \"id\": 1,
        \"sku\": \"IM8-WK-000010\",
        \"title\": \"Welcome Kit\",
        \"quantity\": 1,
        \"price\": \"89.00\"
      }
    ],
    \"shipping_address\": {
      \"first_name\": \"Test\",
      \"last_name\": \"Refund\",
      \"address1\": \"123 Test St\",
      \"city\": \"Los Angeles\",
      \"province_code\": \"CA\",
      \"country_code\": \"US\",
      \"zip\": \"90001\"
    },
    \"billing_address\": {
      \"country_code\": \"US\"
    }
  }" > /dev/null 2>&1

echo "Waiting 10 seconds for order to be created in D365..."
sleep 10

# Now send refund
REFUND_ID=$(generate_id)
curl -k -X POST "${NGROK_URL}/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: refunds/create" \
  -H "x-shopify-hmac-sha256: test" \
  -H "x-shopify-shop-domain: im8health.myshopify.com" \
  -d "{
    \"id\": ${REFUND_ID},
    \"order_id\": ${REFUND_ORDER_ID},
    \"created_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
    \"note\": \"Test refund\",
    \"refund_line_items\": [
      {
        \"id\": 1,
        \"line_item_id\": 1,
        \"quantity\": 1,
        \"subtotal\": \"89.00\",
        \"total_tax\": \"0.00\"
      }
    ],
    \"transactions\": [
      {
        \"id\": ${REFUND_ID},
        \"amount\": \"89.00\",
        \"kind\": \"refund\"
      }
    ],
    \"order_adjustments\": []
  }" && echo ""

check_logs "${REFUND_ORDER_NAME}|Creating return sales order|Created return sales order|Refund" "Flow 7"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ All Flows Tested!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}To view all logs:${NC}"
echo "tail -200 ${BASE_DIR}/logs/pm2-out.log | grep -E 'D365|Created|Confirmed|Return'"
echo ""
echo -e "${YELLOW}To check Inngest function runs:${NC}"
echo "Open: http://localhost:8288"
echo ""

