#!/bin/bash

# Comprehensive D365 Order Check Script
# Checks order by multiple methods

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Load env vars
BASE_DIR="/Users/prenetics/work/Development/battle-bus/battle-bus-inngest"
source "${BASE_DIR}/.env.local" 2>/dev/null || true

# Config
D365_BASE_URL=${D365_BASE_URL:-"https://p-uat.sandbox.operations.dynamics.com"}
D365_TENANT_ID=${D365_TENANT_ID:-"fdea3f0c-62d4-40b7-bb83-017d9e8f6bd7"}
D365_CLIENT_ID=${D365_CLIENT_ID:-"740f1eb2-8f38-4c57-8150-81836a399a8e"}
D365_CLIENT_SECRET=${D365_CLIENT_SECRET:-"dEP8Q~WmFC9TWibaH3~rETToqmZDeh666zYEqcA3"}
D365_DATA_AREA_ID=${D365_DATA_AREA_ID:-"U001"}
D365_SCOPE=${D365_SCOPE:-"${D365_BASE_URL}/.default"}

SHOPIFY_ORDER_NAME=${1:-"IM8-14931"}
SALES_ORDER_NUMBER=${2:-""}

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}D365 Order Check - Comprehensive${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${YELLOW}Shopify Order Name: ${SHOPIFY_ORDER_NAME}${NC}"
if [ -n "$SALES_ORDER_NUMBER" ]; then
  echo -e "${YELLOW}Sales Order Number: ${SALES_ORDER_NUMBER}${NC}"
fi
echo -e "${YELLOW}Data Area: ${D365_DATA_AREA_ID}${NC}"
echo ""

# Step 1: Get Auth Token
echo -e "${YELLOW}Step 1: Authenticating...${NC}"
TOKEN_RESPONSE=$(curl -s -X POST "https://login.microsoftonline.com/${D365_TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=${D365_CLIENT_ID}" \
  -d "client_secret=${D365_CLIENT_SECRET}" \
  -d "scope=${D365_SCOPE}" \
  -d "grant_type=client_credentials")

TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')

if [ "$TOKEN" == "null" ] || [ -z "$TOKEN" ]; then
  echo -e "${RED}❌ Authentication failed${NC}"
  echo "$TOKEN_RESPONSE" | jq .
  exit 1
fi

echo -e "${GREEN}✅ Authenticated${NC}"
echo ""

# Step 2: Check by THK_ShopifyReference
echo -e "${YELLOW}Step 2: Checking by THK_ShopifyReference...${NC}"
FILTER1="dataAreaId eq '${D365_DATA_AREA_ID}' and THK_ShopifyReference eq '${SHOPIFY_ORDER_NAME}'"
URL1="${D365_BASE_URL}/data/SalesOrderHeadersV3?\$filter=$(echo "$FILTER1" | jq -sRr @uri)"
RESPONSE1=$(curl -s -X GET "$URL1" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json")

COUNT1=$(echo "$RESPONSE1" | jq '.value | length')
if [ "$COUNT1" -gt 0 ]; then
  echo -e "${GREEN}✅ Found ${COUNT1} order(s) by THK_ShopifyReference${NC}"
  echo "$RESPONSE1" | jq '.value[] | {SalesOrderNumber, THK_ShopifyReference, OrderStatus, CreatedDateTime, dataAreaId}'
else
  echo -e "${RED}❌ No orders found by THK_ShopifyReference${NC}"
fi
echo ""

# Step 3: Check by SalesOrderNumber if provided
if [ -n "$SALES_ORDER_NUMBER" ]; then
  echo -e "${YELLOW}Step 3: Checking by SalesOrderNumber...${NC}"
  FILTER2="SalesOrderNumber eq '${SALES_ORDER_NUMBER}'"
  URL2="${D365_BASE_URL}/data/SalesOrderHeadersV3?\$filter=$(echo "$FILTER2" | jq -sRr @uri)"
  RESPONSE2=$(curl -s -X GET "$URL2" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json")
  
  COUNT2=$(echo "$RESPONSE2" | jq '.value | length')
  if [ "$COUNT2" -gt 0 ]; then
    echo -e "${GREEN}✅ Found order by SalesOrderNumber${NC}"
    echo "$RESPONSE2" | jq '.value[] | {SalesOrderNumber, THK_ShopifyReference, OrderStatus, CreatedDateTime, dataAreaId}'
  else
    echo -e "${RED}❌ No order found by SalesOrderNumber${NC}"
  fi
  echo ""
fi

# Step 4: Check by CustomersOrderReference
echo -e "${YELLOW}Step 4: Checking by CustomersOrderReference...${NC}"
FILTER3="dataAreaId eq '${D365_DATA_AREA_ID}' and CustomersOrderReference eq '${SHOPIFY_ORDER_NAME}'"
URL3="${D365_BASE_URL}/data/SalesOrderHeadersV3?\$filter=$(echo "$FILTER3" | jq -sRr @uri)"
RESPONSE3=$(curl -s -X GET "$URL3" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json")

COUNT3=$(echo "$RESPONSE3" | jq '.value | length')
if [ "$COUNT3" -gt 0 ]; then
  echo -e "${GREEN}✅ Found ${COUNT3} order(s) by CustomersOrderReference${NC}"
  echo "$RESPONSE3" | jq '.value[] | {SalesOrderNumber, CustomersOrderReference, THK_ShopifyReference, OrderStatus, CreatedDateTime}'
else
  echo -e "${RED}❌ No orders found by CustomersOrderReference${NC}"
fi
echo ""

# Step 5: Check recent orders (last 10)
echo -e "${YELLOW}Step 5: Checking recent orders (last 10)...${NC}"
FILTER4="dataAreaId eq '${D365_DATA_AREA_ID}'"
URL4="${D365_BASE_URL}/data/SalesOrderHeadersV3?\$filter=$(echo "$FILTER4" | jq -sRr @uri)&\$top=10&\$orderby=CreatedDateTime desc"
RESPONSE4=$(curl -s -X GET "$URL4" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json")

COUNT4=$(echo "$RESPONSE4" | jq '.value | length')
if [ "$COUNT4" -gt 0 ]; then
  echo -e "${GREEN}✅ Found ${COUNT4} recent order(s)${NC}"
  echo "$RESPONSE4" | jq '.value[] | {SalesOrderNumber, THK_ShopifyReference, CustomersOrderReference, OrderStatus, CreatedDateTime}' | head -50
else
  echo -e "${RED}❌ No recent orders found${NC}"
fi
echo ""

# Step 6: Check all data areas
echo -e "${YELLOW}Step 6: Checking without dataAreaId filter...${NC}"
FILTER5="THK_ShopifyReference eq '${SHOPIFY_ORDER_NAME}'"
URL5="${D365_BASE_URL}/data/SalesOrderHeadersV3?\$filter=$(echo "$FILTER5" | jq -sRr @uri)"
RESPONSE5=$(curl -s -X GET "$URL5" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json")

COUNT5=$(echo "$RESPONSE5" | jq '.value | length')
if [ "$COUNT5" -gt 0 ]; then
  echo -e "${GREEN}✅ Found ${COUNT5} order(s) across all data areas${NC}"
  echo "$RESPONSE5" | jq '.value[] | {SalesOrderNumber, THK_ShopifyReference, OrderStatus, dataAreaId, CreatedDateTime}'
else
  echo -e "${RED}❌ No orders found across all data areas${NC}"
fi
echo ""

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}How to Check in Dynamics UI:${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${YELLOW}1. Open Dynamics 365:${NC}"
echo "   ${D365_BASE_URL}"
echo ""
echo -e "${YELLOW}2. Navigate to:${NC}"
echo "   Sales and Marketing > Sales Orders"
echo "   OR"
echo "   Sales > Sales Orders"
echo ""
echo -e "${YELLOW}3. Search for:${NC}"
       echo "   - Sales Order Number: ${SALES_ORDER_NUMBER:-'U001-SO-210035'}"
echo "   - Customer Reference: ${SHOPIFY_ORDER_NAME}"
echo "   - Shopify Reference: ${SHOPIFY_ORDER_NAME}"
echo ""
echo -e "${YELLOW}4. Check Order Status:${NC}"
echo "   - Draft (not queryable via API)"
echo "   - Open Order"
echo "   - Confirmed"
echo "   - Invoiced"
echo ""
echo -e "${BLUE}============================================================================${NC}"

