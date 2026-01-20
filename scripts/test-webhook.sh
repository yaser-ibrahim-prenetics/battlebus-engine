#!/bin/bash

# ============================================================================
# Battle Bus - Test Webhook Script
# ============================================================================
# Sends test webhooks to local development server
# Usage: ./scripts/test-webhook.sh [order|refund|cancel|gps|stord]

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
ORDER_ID="${ORDER_ID:-$(date +%s)}"
ORDER_NAME="#TEST-${ORDER_ID: -4}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

echo_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

echo_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ============================================================================
# Test: Shopify Order Created
# ============================================================================
test_order() {
    echo_info "Sending Shopify order webhook..."
    echo_info "Order ID: $ORDER_ID"
    echo_info "Order Name: $ORDER_NAME"
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/webhooks/shopify" \
      -H "Content-Type: application/json" \
      -H "x-shopify-topic: orders/create" \
      -H "x-shopify-shop-domain: test-store.myshopify.com" \
      -d '{
        "id": '"$ORDER_ID"',
        "name": "'"$ORDER_NAME"'",
        "email": "test@example.com",
        "created_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
        "updated_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
        "total_price": "149.99",
        "subtotal_price": "139.99",
        "total_tax": "10.00",
        "currency": "USD",
        "financial_status": "paid",
        "fulfillment_status": null,
        "tags": "",
        "note": "Test order from Battle Bus",
        "line_items": [
          {
            "id": 1001,
            "variant_id": 2001,
            "title": "IM8 Health Test Kit",
            "quantity": 1,
            "sku": "IM8-FG-000010",
            "variant_title": null,
            "vendor": "IM8",
            "fulfillment_service": "manual",
            "product_id": 3001,
            "requires_shipping": true,
            "taxable": true,
            "gift_card": false,
            "name": "IM8 Health Test Kit",
            "price": "99.99",
            "total_discount": "0.00",
            "fulfillment_status": null,
            "properties": [],
            "tax_lines": [
              {"title": "Tax", "price": "8.00", "rate": 0.08}
            ]
          },
          {
            "id": 1002,
            "variant_id": 2002,
            "title": "IM8 Supplement Pack",
            "quantity": 2,
            "sku": "IM8-FG-000030",
            "variant_title": null,
            "vendor": "IM8",
            "fulfillment_service": "manual",
            "product_id": 3002,
            "requires_shipping": true,
            "taxable": true,
            "gift_card": false,
            "name": "IM8 Supplement Pack",
            "price": "20.00",
            "total_discount": "0.00",
            "fulfillment_status": null,
            "properties": [],
            "tax_lines": [
              {"title": "Tax", "price": "2.00", "rate": 0.08}
            ]
          }
        ],
        "shipping_address": {
          "first_name": "Test",
          "last_name": "Customer",
          "address1": "123 Test Street",
          "address2": "Apt 4B",
          "city": "New York",
          "province": "New York",
          "country": "United States",
          "zip": "10001",
          "phone": "+1-555-123-4567",
          "company": null,
          "country_code": "US",
          "province_code": "NY"
        },
        "billing_address": {
          "first_name": "Test",
          "last_name": "Customer",
          "address1": "123 Test Street",
          "address2": "Apt 4B",
          "city": "New York",
          "province": "New York",
          "country": "United States",
          "zip": "10001",
          "phone": "+1-555-123-4567",
          "company": null,
          "country_code": "US",
          "province_code": "NY"
        },
        "shipping_lines": [
          {
            "id": 4001,
            "title": "Standard Shipping",
            "price": "0.00",
            "code": "standard",
            "source": "shopify",
            "carrier_identifier": null,
            "tax_lines": []
          }
        ],
        "discount_codes": [],
        "customer": {
          "id": 5001,
          "email": "test@example.com",
          "first_name": "Test",
          "last_name": "Customer",
          "phone": "+1-555-123-4567",
          "tags": ""
        },
        "refunds": []
      }')
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo_info "✅ Webhook accepted (HTTP $HTTP_CODE)"
        echo_info "Response: $BODY"
    else
        echo_error "❌ Webhook failed (HTTP $HTTP_CODE)"
        echo_error "Response: $BODY"
        exit 1
    fi
}

# ============================================================================
# Test: Shopify Order Paid
# ============================================================================
test_order_paid() {
    echo_info "Sending Shopify order paid webhook..."
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/webhooks/shopify" \
      -H "Content-Type: application/json" \
      -H "x-shopify-topic: orders/paid" \
      -H "x-shopify-shop-domain: test-store.myshopify.com" \
      -d '{
        "id": '"$ORDER_ID"',
        "name": "'"$ORDER_NAME"'",
        "email": "test@example.com",
        "financial_status": "paid",
        "line_items": [],
        "shipping_address": {"country_code": "US"},
        "customer": {"id": 1, "email": "test@example.com"}
      }')
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo_info "✅ Order paid webhook accepted"
    else
        echo_error "❌ Webhook failed (HTTP $HTTP_CODE)"
    fi
}

# ============================================================================
# Test: Shopify Refund Created
# ============================================================================
test_refund() {
    echo_info "Sending Shopify refund webhook..."
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/webhooks/shopify" \
      -H "Content-Type: application/json" \
      -H "x-shopify-topic: refunds/create" \
      -H "x-shopify-shop-domain: test-store.myshopify.com" \
      -d '{
        "id": '"$(date +%s)"',
        "order_id": '"$ORDER_ID"',
        "created_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
        "refund_line_items": [
          {
            "id": 1,
            "quantity": 1,
            "line_item_id": 1001,
            "subtotal": "99.99",
            "total_tax": "8.00"
          }
        ],
        "transactions": [
          {
            "id": 1,
            "kind": "refund",
            "gateway": "shopify_payments",
            "status": "success",
            "amount": "107.99"
          }
        ]
      }')
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo_info "✅ Refund webhook accepted"
    else
        echo_error "❌ Webhook failed (HTTP $HTTP_CODE)"
    fi
}

# ============================================================================
# Test: Shopify Order Cancelled
# ============================================================================
test_cancel() {
    echo_info "Sending Shopify order cancellation webhook..."
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/webhooks/shopify" \
      -H "Content-Type: application/json" \
      -H "x-shopify-topic: orders/cancelled" \
      -H "x-shopify-shop-domain: test-store.myshopify.com" \
      -d '{
        "id": '"$ORDER_ID"',
        "name": "'"$ORDER_NAME"'",
        "email": "test@example.com",
        "cancelled_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
        "cancel_reason": "customer",
        "financial_status": "refunded",
        "line_items": [],
        "shipping_address": {"country_code": "US"},
        "customer": {"id": 1, "email": "test@example.com"}
      }')
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo_info "✅ Cancellation webhook accepted"
    else
        echo_error "❌ Webhook failed (HTTP $HTTP_CODE)"
    fi
}

# ============================================================================
# Test: GPS Fulfilment Webhook
# ============================================================================
test_gps() {
    echo_info "Sending GPS fulfilment webhook..."
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/webhooks/gps" \
      -H "Content-Type: application/json" \
      -H "x-gps-signature: test-signature" \
      -H "x-gps-timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      -d '{
        "orderId": "GPS-'"$ORDER_ID"'",
        "orderNumber": "'"$ORDER_NAME"'",
        "trackingNumber": "1Z999AA10123456784",
        "carrierCode": "UPS",
        "shippedDate": "'"$(date +%Y-%m-%d)"'",
        "items": [
          {"sku": "IM8-FG-000010", "quantity": 1},
          {"sku": "IM8-FG-000030", "quantity": 2}
        ]
      }')
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo_info "✅ GPS fulfilment webhook accepted"
    else
        echo_error "❌ Webhook failed (HTTP $HTTP_CODE)"
    fi
}

# ============================================================================
# Test: STORD Fulfilment Webhook
# ============================================================================
test_stord() {
    echo_info "Sending STORD fulfilment webhook..."
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/webhooks/stord" \
      -H "Content-Type: application/json" \
      -H "x-stord-api-key: test-api-key" \
      -d '{
        "orderId": "STORD-'"$ORDER_ID"'",
        "orderNumber": "'"$ORDER_NAME"'",
        "trackingNumber": "794644790132",
        "carrier": "FEDEX",
        "shippedAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
        "lineItems": [
          {"sku": "IM8-FG-000010", "quantity": 1}
        ]
      }')
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo_info "✅ STORD fulfilment webhook accepted"
    else
        echo_error "❌ Webhook failed (HTTP $HTTP_CODE)"
    fi
}

# ============================================================================
# Test: UK Order (GPS UK Warehouse)
# ============================================================================
test_uk_order() {
    echo_info "Sending UK order webhook (should route to GPS UK)..."
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/webhooks/shopify" \
      -H "Content-Type: application/json" \
      -H "x-shopify-topic: orders/create" \
      -H "x-shopify-shop-domain: test-store.myshopify.com" \
      -d '{
        "id": '"$ORDER_ID"'1,
        "name": "'"$ORDER_NAME"'-UK",
        "email": "uk-test@example.com",
        "total_price": "99.99",
        "currency": "GBP",
        "financial_status": "paid",
        "line_items": [
          {
            "id": 1,
            "sku": "IM8-FG-000010",
            "quantity": 1,
            "price": "99.99",
            "requires_shipping": true,
            "gift_card": false,
            "total_discount": "0.00"
          }
        ],
        "shipping_address": {
          "first_name": "UK",
          "last_name": "Customer",
          "address1": "10 Downing Street",
          "city": "London",
          "country": "United Kingdom",
          "zip": "SW1A 2AA",
          "country_code": "GB",
          "province_code": ""
        },
        "shipping_lines": [],
        "customer": {"id": 1, "email": "uk-test@example.com"}
      }')
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo_info "✅ UK order webhook accepted"
    else
        echo_error "❌ Webhook failed (HTTP $HTTP_CODE)"
    fi
}

# ============================================================================
# Run All Tests
# ============================================================================
test_all() {
    echo_info "Running all webhook tests..."
    echo ""
    
    test_order
    echo ""
    sleep 1
    
    test_refund
    echo ""
    sleep 1
    
    test_cancel
    echo ""
    sleep 1
    
    test_gps
    echo ""
    sleep 1
    
    test_stord
    echo ""
    sleep 1
    
    test_uk_order
    echo ""
    
    echo_info "All tests complete!"
    echo_info "Check Inngest UI at http://localhost:8288 for function runs"
}

# ============================================================================
# Main
# ============================================================================
case "${1:-order}" in
    order)
        test_order
        ;;
    paid)
        test_order_paid
        ;;
    refund)
        test_refund
        ;;
    cancel)
        test_cancel
        ;;
    gps)
        test_gps
        ;;
    stord)
        test_stord
        ;;
    uk)
        test_uk_order
        ;;
    all)
        test_all
        ;;
    *)
        echo "Usage: $0 [order|paid|refund|cancel|gps|stord|uk|all]"
        echo ""
        echo "Commands:"
        echo "  order   - Send Shopify order created webhook (default)"
        echo "  paid    - Send Shopify order paid webhook"
        echo "  refund  - Send Shopify refund webhook"
        echo "  cancel  - Send Shopify order cancelled webhook"
        echo "  gps     - Send GPS fulfilment webhook"
        echo "  stord   - Send STORD fulfilment webhook"
        echo "  uk      - Send UK order (routes to GPS UK)"
        echo "  all     - Run all tests"
        echo ""
        echo "Environment variables:"
        echo "  BASE_URL  - Server URL (default: http://localhost:3000)"
        echo "  ORDER_ID  - Order ID to use (default: timestamp)"
        exit 1
        ;;
esac

echo ""
echo_info "View function runs at: http://localhost:8288"
