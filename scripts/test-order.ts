/**
 * Test script to send a mock Shopify order event to Inngest
 *
 * Usage:
 *   npx tsx scripts/test-order.ts
 *
 * Prerequisites:
 *   1. Next.js server running: npm run dev
 *   2. Inngest dev server running: npx inngest-cli@latest dev
 */

const TEST_ORDER = {
  name: "shopify/order.created",
  data: {
    shopifyOrderId: "TEST-" + Date.now(),
    shopifyOrderName: "#TEST-" + Math.floor(Math.random() * 10000),
    shopifyStore: "im8",
    orderJson: {
      id: Date.now(),
      name: "#TEST-" + Math.floor(Math.random() * 10000),
      email: "test@example.com",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      total_price: "99.00",
      subtotal_price: "89.00",
      total_tax: "10.00",
      currency: "USD",
      financial_status: "paid",
      fulfillment_status: null,
      line_items: [
        {
          id: 1,
          variant_id: 1,
          title: "IM8 Test Product",
          quantity: 1,
          sku: "IM8-FG-000010",
          variant_title: null,
          vendor: "IM8",
          fulfillment_service: "manual",
          product_id: 1,
          requires_shipping: true,
          taxable: true,
          gift_card: false,
          name: "IM8 Test Product",
          price: "89.00",
          total_discount: "0.00",
          fulfillment_status: null,
          properties: [],
          tax_lines: [],
        },
      ],
      shipping_address: {
        first_name: "Test",
        last_name: "User",
        address1: "123 Test Street",
        address2: null,
        city: "Los Angeles",
        province: "California",
        country: "United States",
        zip: "90001",
        phone: "+1234567890",
        company: null,
        country_code: "US",
        province_code: "CA",
      },
      billing_address: {
        first_name: "Test",
        last_name: "User",
        address1: "123 Test Street",
        address2: null,
        city: "Los Angeles",
        province: "California",
        country: "United States",
        zip: "90001",
        phone: "+1234567890",
        company: null,
        country_code: "US",
        province_code: "CA",
      },
      shipping_lines: [
        {
          id: 1,
          title: "Standard Shipping",
          price: "10.00",
          code: "standard",
          source: "shopify",
          carrier_identifier: null,
          tax_lines: [],
        },
      ],
      discount_codes: [],
      note: "Test order from Battle Bus",
      tags: "testing",
      customer: {
        id: 1,
        email: "test@example.com",
        first_name: "Test",
        last_name: "User",
        phone: "+1234567890",
        tags: "",
      },
      refunds: [],
    },
    receivedAt: new Date().toISOString(),
  },
};

async function sendTestEvent() {
  console.log("🚌 Battle Bus - Sending test order event...\n");
  console.log(`Order ID: ${TEST_ORDER.data.shopifyOrderId}`);
  console.log(`Order Name: ${TEST_ORDER.data.shopifyOrderName}\n`);

  try {
    // Send directly to Inngest Dev Server
    const response = await fetch("http://localhost:8288/e/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(TEST_ORDER),
    });

    if (response.ok) {
      console.log("✅ Event sent successfully!");
      console.log("\n📺 Open http://localhost:8288 to see the function run");
    } else {
      const text = await response.text();
      console.log("❌ Failed to send event:", response.status, text);

      // Try alternative endpoint
      console.log("\n🔄 Trying alternative method...");
      const altResponse = await fetch("http://localhost:8288/v1/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify([TEST_ORDER]),
      });

      if (altResponse.ok) {
        console.log("✅ Event sent via alternative endpoint!");
        console.log("\n📺 Open http://localhost:8288 to see the function run");
      } else {
        console.log("❌ Alternative also failed:", await altResponse.text());
      }
    }
  } catch (error) {
    console.error("❌ Error sending event:", error);
    console.log("\n💡 Make sure:");
    console.log("   1. Next.js is running: npm run dev");
    console.log("   2. Inngest Dev Server is running: npx inngest-cli@latest dev");
  }
}

sendTestEvent();
