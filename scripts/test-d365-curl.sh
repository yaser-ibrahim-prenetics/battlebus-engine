#!/bin/bash

# ============================================================================
# DIRECT D365 API TEST VIA CURL
# ============================================================================
# Tests D365 API calls directly using curl to bypass any code issues
# Usage: ./scripts/test-d365-curl.sh

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# D365 Config (from config.ts)
TENANT_ID="fdea3f0c-62d4-40b7-bb83-017d9e8f6bd7"
CLIENT_ID="740f1eb2-8f38-4c57-8150-81836a399a8e"
CLIENT_SECRET="dEP8Q~WmFC9TWibaH3~rETToqmZDeh666zYEqcA3"
BASE_URL="https://p-uat.sandbox.operations.dynamics.com"
SCOPE="${BASE_URL}/.default"
DATA_AREA_ID="U001"

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Direct D365 API Test via cURL${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""

# ============================================================================
# STEP 1: Authenticate
# ============================================================================
echo -e "${GREEN}Step 1: Authenticating to D365...${NC}"

AUTH_RESPONSE=$(curl -s -X POST \
  "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "scope=${SCOPE}")

echo "Response: ${AUTH_RESPONSE}" | head -c 200
echo ""

# Extract token
ACCESS_TOKEN=$(echo "$AUTH_RESPONSE" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

if [ -z "$ACCESS_TOKEN" ]; then
  echo -e "${RED}❌ Authentication failed!${NC}"
  echo "Full response:"
  echo "$AUTH_RESPONSE"
  exit 1
fi

echo -e "${GREEN}✅ Authentication successful!${NC}"
echo "Token: ${ACCESS_TOKEN:0:50}..."
echo ""

# ============================================================================
# STEP 2: Check if order exists
# ============================================================================
echo -e "${GREEN}Step 2: Checking if test order exists...${NC}"

TEST_ORDER_ID="176942987116267"
FILTER="dataAreaId eq '${DATA_AREA_ID}' and THK_ShopifyReference eq '${TEST_ORDER_ID}'"
ENCODED_FILTER=$(echo "$FILTER" | jq -sRr @uri)

CHECK_URL="${BASE_URL}/data/SalesOrderHeadersV3?\$filter=${ENCODED_FILTER}"

echo "URL: ${CHECK_URL}"
echo ""

CHECK_RESPONSE=$(curl -s -X GET \
  "${CHECK_URL}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json")

echo "Response: ${CHECK_RESPONSE}" | head -c 500
echo ""
echo ""

# Check if order exists
ORDER_COUNT=$(echo "$CHECK_RESPONSE" | jq -r '.value | length' 2>/dev/null || echo "0")

if [ "$ORDER_COUNT" = "0" ] || [ -z "$ORDER_COUNT" ]; then
  echo -e "${YELLOW}⚠️  No existing order found (expected)${NC}"
  EXISTING_ORDER=""
else
  echo -e "${GREEN}✅ Found existing order!${NC}"
  EXISTING_ORDER=$(echo "$CHECK_RESPONSE" | jq -r '.value[0].SalesOrderNumber' 2>/dev/null || echo "")
  echo "Sales Order Number: ${EXISTING_ORDER}"
fi
echo ""

# ============================================================================
# STEP 3: Create Test Order
# ============================================================================
echo -e "${GREEN}Step 3: Creating test order in D365...${NC}"

# Generate test order data
ORDER_ID=$(date +%s)${RANDOM}
ORDER_NAME="#CURL-TEST-${ORDER_ID}"

# Create order header payload
# Using correct values from warehouse-config.json for GPS Warehouse (US)
# Format: ~{dimensionValue}~{project}~~{orderingCustomerAccountNumber}
ORDERING_CUSTOMER_ACCOUNT="U001-C000000006"
LEDGER_DIMENSION="~Consumer - Nutrition~P1201~~${ORDERING_CUSTOMER_ACCOUNT}"

ORDER_PAYLOAD=$(cat <<EOF
{
  "SalesOrderPoolId": "D2C",
  "DefaultShippingSiteId": "Prenetics",
  "CurrencyCode": "USD",
  "OrderingCustomerAccountNumber": "${ORDERING_CUSTOMER_ACCOUNT}",
  "DefaultLedgerDimensionDisplayValue": "${LEDGER_DIMENSION}",
  "dataAreaId": "${DATA_AREA_ID}",
  "CustomersOrderReference": "${ORDER_NAME}",
  "THK_ShopifyReference": "${ORDER_ID}",
  "THK_ShopifyCustName": "Curl Test User",
  "THK_ShopifyCustomerEmail": "curl-test-${ORDER_ID}@example.com",
  "THK_BillingName": "123 Test St",
  "THK_BillingAddressCountryRegionId": "USA",
  "THK_BillingAddressZipCode": "90001",
  "THK_BillingAddressStreet": "123 Test St",
  "THK_BillingAddressCity": "Los Angeles",
  "THK_ShopifyCustomerPhonenum": "+1-555-111-2222",
  "THK_Comments": "Direct curl test",
  "DeliveryAddressName": "Curl Test",
  "DeliveryAddressDescription": "123 Test St",
  "DeliveryAddressCountryRegionId": "USA",
  "DeliveryAddressZipCode": "90001",
  "DeliveryAddressStreet": "123 Test St",
  "DeliveryAddressCity": "Los Angeles"
}
EOF
)

echo "Creating order: ${ORDER_NAME}"
echo "Payload: ${ORDER_PAYLOAD}" | head -c 300
echo ""
echo ""

CREATE_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST \
  "${BASE_URL}/data/SalesOrderHeadersV3" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${ORDER_PAYLOAD}")

HTTP_STATUS=$(echo "$CREATE_RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
CREATE_BODY=$(echo "$CREATE_RESPONSE" | sed '/HTTP_STATUS:/d')

echo "HTTP Status: ${HTTP_STATUS}"
echo "Response:"
echo "$CREATE_BODY" | head -c 500
echo ""
echo ""

if [ "$HTTP_STATUS" = "201" ] || [ "$HTTP_STATUS" = "200" ]; then
  SALES_ORDER_NUMBER=$(echo "$CREATE_BODY" | jq -r '.SalesOrderNumber' 2>/dev/null || echo "")
  if [ -n "$SALES_ORDER_NUMBER" ] && [ "$SALES_ORDER_NUMBER" != "null" ]; then
    echo -e "${GREEN}✅ Order created successfully!${NC}"
    echo "Sales Order Number: ${SALES_ORDER_NUMBER}"
    echo ""
    
    # ============================================================================
    # STEP 4: Create Order Line
    # ============================================================================
    echo -e "${GREEN}Step 4: Creating order line...${NC}"
    
    LINE_PAYLOAD=$(cat <<EOF
{
  "dataAreaId": "${DATA_AREA_ID}",
  "CurrencyCode": "USD",
  "SalesOrderNumber": "${SALES_ORDER_NUMBER}",
  "ItemNumber": "IM8-FG-000010",
  "OrderedSalesQuantity": 1,
  "SalesPrice": 89.00,
  "LineDiscountAmount": 0,
  "THK_DiscountType": "",
  "THK_PromotionCode": ""
}
EOF
)
    
    LINE_RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST \
      "${BASE_URL}/data/SalesOrderLines" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${LINE_PAYLOAD}")
    
    LINE_HTTP_STATUS=$(echo "$LINE_RESPONSE" | grep "HTTP_STATUS:" | cut -d: -f2)
    LINE_BODY=$(echo "$LINE_RESPONSE" | sed '/HTTP_STATUS:/d')
    
    echo "HTTP Status: ${LINE_HTTP_STATUS}"
    echo "Response:"
    echo "$LINE_BODY" | head -c 300
    echo ""
    
    if [ "$LINE_HTTP_STATUS" = "201" ] || [ "$LINE_HTTP_STATUS" = "200" ]; then
      INVENTORY_LOT_ID=$(echo "$LINE_BODY" | jq -r '.InventoryLotId' 2>/dev/null || echo "")
      echo -e "${GREEN}✅ Order line created!${NC}"
      echo "Inventory Lot ID: ${INVENTORY_LOT_ID}"
    else
      echo -e "${RED}❌ Failed to create order line${NC}"
      echo "Response: ${LINE_BODY}"
    fi
    
  else
    echo -e "${YELLOW}⚠️  Order created but no SalesOrderNumber in response${NC}"
  fi
else
  echo -e "${RED}❌ Failed to create order${NC}"
  echo "Full response:"
  echo "$CREATE_BODY"
fi

echo ""
echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Test Complete${NC}"
echo -e "${BLUE}============================================================================${NC}"

