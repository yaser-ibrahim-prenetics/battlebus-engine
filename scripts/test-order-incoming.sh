#!/bin/bash
# ============================================================================
# TEST ORDER INCOMING
# ============================================================================
# Tests order creation flow: Shopify webhook → Battle Bus → D365/GPS
# Simulates a Shopify order.create webhook

set -e

BATTLE_BUS_URL="${BATTLE_BUS_URL:-http://localhost:7000}"
SHOPIFY_WEBHOOK_SECRET="${SHOPIFY_IM8_WEBHOOK_SECRET:-95729db9968a6f279abb9e64a04db8ffea61682940db7314aa208f9a8749e8f0}"

echo "============================================================================"
echo "TEST ORDER INCOMING"
echo "============================================================================"
echo "Battle Bus URL: $BATTLE_BUS_URL"
echo ""

# Generate HMAC signature
generate_signature() {
  local payload="$1"
  echo -n "$payload" | openssl dgst -sha256 -hmac "$SHOPIFY_WEBHOOK_SECRET" | sed 's/^.* //'
}

# Sample order payload (minimal required fields)
ORDER_PAYLOAD=$(cat <<EOF
{
  "id": 6652098052264,
  "name": "IM8-TEST-$(date +%s)",
  "email": "test@example.com",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%S%z)",
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%S%z)",
  "number": 12345,
  "note": "Test order from script",
  "token": "test-token-$(date +%s)",
  "gateway": "test",
  "test": false,
  "total_price": "99.99",
  "subtotal_price": "89.99",
  "total_weight": 500,
  "total_tax": "10.00",
  "currency": "USD",
  "financial_status": "paid",
  "confirmed": true,
  "total_discounts": "0.00",
  "buyer_accepts_marketing": false,
  "name": "IM8-TEST-$(date +%s)",
  "referring_site": "",
  "landing_site": "",
  "cancelled_at": null,
  "cancel_reason": null,
  "total_line_items_price": "89.99",
  "total_price_usd": "99.99",
  "checkout_token": null,
  "reference": null,
  "user_id": null,
  "location_id": "79527313640",
  "source_identifier": null,
  "source_url": null,
  "processed_at": "$(date -u +%Y-%m-%dT%H:%M:%S%z)",
  "device_id": null,
  "phone": null,
  "customer_locale": null,
  "app_id": 123456,
  "browser_ip": "127.0.0.1",
  "landing_site_ref": null,
  "order_number": 12345,
  "discount_codes": [],
  "note_attributes": [],
  "payment_gateway_names": ["test"],
  "processing_method": "",
  "checkout_id": null,
  "source_name": "web",
  "fulfillment_status": null,
  "order_status_url": "https://example.com/orders/test/status",
  "tags": "",
  "contact_email": "test@example.com",
  "order_adjustments": [],
  "discount_applications": [],
  "duties": [],
  "fulfillments": [],
  "line_items": [
    {
      "id": 15716246618279,
      "variant_id": 46166911778983,
      "title": "Test Product",
      "name": "Test Product - Default Title",
      "sku": "TEST-SKU-001",
      "vendor": "Test Vendor",
      "product_id": 123456789,
      "requires_shipping": true,
      "taxable": true,
      "gift_card": false,
      "name": "Test Product - Default Title",
      "variant_inventory_management": "shopify",
      "properties": [],
      "product_exists": true,
      "fulfillable_quantity": 1,
      "grams": 500,
      "price": "89.99",
      "total_discount": "0.00",
      "fulfillment_status": null,
      "price_set": {
        "shop_money": {
          "amount": "89.99",
          "currency_code": "USD"
        },
        "presentment_money": {
          "amount": "89.99",
          "currency_code": "USD"
        }
      },
      "total_discount_set": {
        "shop_money": {
          "amount": "0.00",
          "currency_code": "USD"
        },
        "presentment_money": {
          "amount": "0.00",
          "currency_code": "USD"
        }
      },
      "discount_allocations": [],
      "duties": [],
      "admin_graphql_api_id": "gid://shopify/LineItem/15716246618279",
      "tax_lines": [
        {
          "title": "Tax",
          "price": "10.00",
          "rate": 0.1
        }
      ]
    }
  ],
  "shipping_address": {
    "first_name": "John",
    "address1": "123 Test St",
    "phone": "555-1234",
    "city": "New York",
    "zip": "10001",
    "province": "NY",
    "country": "United States",
    "last_name": "Doe",
    "address2": "",
    "company": null,
    "latitude": 40.7128,
    "longitude": -74.0060,
    "name": "John Doe",
    "country_code": "US",
    "province_code": "NY"
  },
  "billing_address": {
    "first_name": "John",
    "address1": "123 Test St",
    "phone": "555-1234",
    "city": "New York",
    "zip": "10001",
    "province": "NY",
    "country": "United States",
    "last_name": "Doe",
    "address2": "",
    "company": null,
    "latitude": 40.7128,
    "longitude": -74.0060,
    "name": "John Doe",
    "country_code": "US",
    "province_code": "NY"
  },
  "customer": {
    "id": 789012345,
    "email": "test@example.com",
    "accepts_marketing": false,
    "created_at": "$(date -u +%Y-%m-%dT%H:%M:%S%z)",
    "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%S%z)",
    "first_name": "John",
    "last_name": "Doe",
    "orders_count": 1,
    "state": "enabled",
    "total_spent": "99.99",
    "last_order_id": 6652098052264,
    "note": null,
    "verified_email": true,
    "multipass_identifier": null,
    "tax_exempt": false,
    "phone": null,
    "tags": "",
    "last_order_name": "IM8-TEST-$(date +%s)",
    "currency": "USD",
    "accepts_marketing_updated_at": "$(date -u +%Y-%m-%dT%H:%M:%S%z)",
    "marketing_opt_in_level": null,
    "tax_exemptions": [],
    "admin_graphql_api_id": "gid://shopify/Customer/789012345",
    "default_address": {
      "first_name": "John",
      "last_name": "Doe",
      "company": null,
      "address1": "123 Test St",
      "address2": "",
      "city": "New York",
      "province": "NY",
      "country": "United States",
      "zip": "10001",
      "phone": "555-1234",
      "name": "John Doe",
      "province_code": "NY",
      "country_code": "US",
      "country_name": "United States",
      "default": true
    }
  },
  "shipping_lines": [
    {
      "id": 123456789,
      "title": "Standard Shipping",
      "price": "10.00",
      "code": "standard",
      "source": "shopify",
      "phone": null,
      "requested_fulfillment_service_id": null,
      "delivery_category": null,
      "carrier_identifier": null,
      "discounted_price": "10.00",
      "price_set": {
        "shop_money": {
          "amount": "10.00",
          "currency_code": "USD"
        },
        "presentment_money": {
          "amount": "10.00",
          "currency_code": "USD"
        }
      },
      "discounted_price_set": {
        "shop_money": {
          "amount": "10.00",
          "currency_code": "USD"
        },
        "presentment_money": {
          "amount": "10.00",
          "currency_code": "USD"
        }
      },
      "tax_lines": []
    }
  ],
  "tax_lines": [
    {
      "title": "Tax",
      "price": "10.00",
      "rate": 0.1
    }
  ],
  "refunds": [],
  "payment_terms": null
}
EOF
)

# Generate signature
SIGNATURE=$(generate_signature "$ORDER_PAYLOAD")

echo "📤 Sending order.create webhook..."
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "$BATTLE_BUS_URL/api/webhooks/shopify" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Shop-Domain: testing-im8store.myshopify.com" \
  -H "X-Shopify-Topic: orders/create" \
  -H "X-Shopify-Hmac-Sha256: $SIGNATURE" \
  -d "$ORDER_PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "Response Code: $HTTP_CODE"
echo "Response Body:"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_CODE" -eq 200 ] || [ "$HTTP_CODE" -eq 201 ]; then
  echo "✅ Order webhook sent successfully!"
  echo ""
  echo "Next steps:"
  echo "1. Check Inngest dashboard for order processing"
  echo "2. Verify order in D365 (if Dynamics sync enabled)"
  echo "3. Verify GPS order creation (if GPS sync enabled)"
else
  echo "❌ Order webhook failed with status $HTTP_CODE"
  exit 1
fi

