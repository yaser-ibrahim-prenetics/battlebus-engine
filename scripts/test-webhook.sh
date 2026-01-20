#!/bin/bash
# Test the Shopify webhook endpoint directly
# Usage: ./scripts/test-webhook.sh

echo "🚌 Battle Bus - Testing Shopify Webhook Endpoint"
echo ""

ORDER_ID="TEST-$(date +%s)"
ORDER_NAME="#TEST-$RANDOM"

echo "Sending test order: $ORDER_NAME"
echo ""

curl -X POST http://localhost:3000/api/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "x-shopify-topic: orders/create" \
  -H "x-shopify-shop-domain: test-store.myshopify.com" \
  -d '{
    "id": '"$(date +%s)"',
    "name": "'"$ORDER_NAME"'",
    "email": "test@example.com",
    "created_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "updated_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
    "total_price": "99.00",
    "subtotal_price": "89.00",
    "total_tax": "10.00",
    "currency": "USD",
    "financial_status": "paid",
    "fulfillment_status": null,
    "line_items": [{
      "id": 1,
      "variant_id": 1,
      "title": "IM8 Test Product",
      "quantity": 1,
      "sku": "IM8-FG-000010",
      "variant_title": null,
      "vendor": "IM8",
      "fulfillment_service": "manual",
      "product_id": 1,
      "requires_shipping": true,
      "taxable": true,
      "gift_card": false,
      "name": "IM8 Test Product",
      "price": "89.00",
      "total_discount": "0.00",
      "fulfillment_status": null,
      "properties": [],
      "tax_lines": []
    }],
    "shipping_address": {
      "first_name": "Test",
      "last_name": "User",
      "address1": "123 Test Street",
      "address2": null,
      "city": "Los Angeles",
      "province": "California",
      "country": "United States",
      "zip": "90001",
      "phone": "+1234567890",
      "company": null,
      "country_code": "US",
      "province_code": "CA"
    },
    "billing_address": null,
    "shipping_lines": [{
      "id": 1,
      "title": "Standard Shipping",
      "price": "10.00",
      "code": "standard",
      "source": "shopify",
      "carrier_identifier": null,
      "tax_lines": []
    }],
    "discount_codes": [],
    "note": "Test order",
    "tags": "testing",
    "customer": {
      "id": 1,
      "email": "test@example.com",
      "first_name": "Test",
      "last_name": "User",
      "phone": null,
      "tags": ""
    },
    "refunds": []
  }'

echo ""
echo ""
echo "✅ Check the Next.js console for webhook logs"
echo "📺 Open http://localhost:8288 to see the Inngest function run"
