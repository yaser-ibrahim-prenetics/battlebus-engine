#!/bin/bash

# ============================================================================
# Battle Bus - Test CS Platform Integration
# ============================================================================
# Sends a test order to battle-bus and verifies it reaches battle-hub (CS Platform)
# Usage: ./scripts/test-cs-platform-order.sh [local|production]

set -e

ENV="${1:-local}"
BASE_URL="${BASE_URL:-http://localhost:3000}"
CS_PLATFORM_URL="${CS_PLATFORM_URL:-https://battle-hub-three.vercel.app}"

if [ "$ENV" = "production" ]; then
  BASE_URL="${PROD_URL:-https://battle-bus-inngest.vercel.app}"
fi

ORDER_ID="${ORDER_ID:-$(date +%s)}"
ORDER_NAME="#TEST-CS-${ORDER_ID: -6}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

echo_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# ============================================================================
# Test: Send Order to Battle Bus
# ============================================================================
test_order_to_battle_bus() {
    echo_step "1. Sending test order to Battle Bus..."
    echo_info "   Order ID: $ORDER_ID"
    echo_info "   Order Name: $ORDER_NAME"
    echo_info "   Battle Bus URL: $BASE_URL"
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/webhooks/shopify" \
      -H "Content-Type: application/json" \
      -H "x-shopify-topic: orders/create" \
      -H "x-shopify-shop-domain: test-store.myshopify.com" \
      -d '{
        "id": '"$ORDER_ID"',
        "name": "'"$ORDER_NAME"'",
        "email": "cs-test@example.com",
        "created_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
        "updated_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
        "total_price": "149.99",
        "subtotal_price": "139.99",
        "total_tax": "10.00",
        "currency": "USD",
        "financial_status": "paid",
        "fulfillment_status": null,
        "tags": "cs-platform-test",
        "note": "Test order for CS Platform integration",
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
          }
        ],
        "shipping_address": {
          "first_name": "CS",
          "last_name": "Test",
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
          "first_name": "CS",
          "last_name": "Test",
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
          "email": "cs-test@example.com",
          "first_name": "CS",
          "last_name": "Test",
          "phone": "+1-555-123-4567",
          "tags": ""
        },
        "refunds": []
      }')
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo_info "   ✅ Order accepted by Battle Bus (HTTP $HTTP_CODE)"
        echo_info "   Response: $BODY"
        return 0
    else
        echo_error "   ❌ Order rejected by Battle Bus (HTTP $HTTP_CODE)"
        echo_error "   Response: $BODY"
        return 1
    fi
}

# ============================================================================
# Test: Verify Order in Battle Hub (CS Platform)
# ============================================================================
test_order_in_battle_hub() {
    echo_step "2. Checking if order reached Battle Hub (CS Platform)..."
    echo_info "   CS Platform URL: $CS_PLATFORM_URL"
    echo_info "   Order Name: $ORDER_NAME"
    
    # Wait a bit for the webhook to be processed
    echo_info "   Waiting 3 seconds for webhook processing..."
    sleep 3
    
    # Note: This assumes Battle Hub has an API endpoint to check orders
    # If not available, we'll just log that the webhook was sent
    echo_warn "   ⚠️  Manual verification needed:"
    echo_warn "      - Check Battle Hub Firestore for order: $ORDER_NAME"
    echo_warn "      - Check Battle Bus logs for CS Platform webhook success"
    echo_warn "      - Verify HMAC signature was validated"
    
    return 0
}

# ============================================================================
# Test: Check Inngest Function Status
# ============================================================================
test_inngest_status() {
    echo_step "3. Checking Inngest function status..."
    
    if [ "$ENV" = "local" ]; then
        echo_info "   View function runs at: http://localhost:8288"
        echo_info "   Search for order: $ORDER_NAME"
    else
        echo_info "   View function runs at: https://app.inngest.com"
        echo_info "   Search for order: $ORDER_NAME"
    fi
    
    return 0
}

# ============================================================================
# Main
# ============================================================================
main() {
    echo ""
    echo "=========================================="
    echo "  Battle Bus → Battle Hub Integration Test"
    echo "=========================================="
    echo ""
    echo_info "Environment: $ENV"
    echo_info "Battle Bus URL: $BASE_URL"
    echo_info "CS Platform URL: $CS_PLATFORM_URL"
    echo ""
    
    # Step 1: Send order to Battle Bus
    if ! test_order_to_battle_bus; then
        echo_error "Failed to send order to Battle Bus"
        exit 1
    fi
    
    echo ""
    
    # Step 2: Verify order in Battle Hub
    test_order_in_battle_hub
    
    echo ""
    
    # Step 3: Check Inngest status
    test_inngest_status
    
    echo ""
    echo "=========================================="
    echo_info "Test complete!"
    echo ""
    echo_info "Next steps:"
    echo_info "  1. Check Inngest dashboard for function execution"
    echo_info "  2. Verify CS Platform webhook was sent (check logs)"
    echo_info "  3. Check Battle Hub Firestore for order: $ORDER_NAME"
    echo_info "  4. Verify HMAC signature validation"
    echo ""
}

main

