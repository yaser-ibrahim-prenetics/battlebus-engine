#!/bin/bash

# Test D365 Order Lookup
# This script queries D365 directly to check if an order exists

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
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

echo -e "${GREEN}============================================================================${NC}"
echo -e "${GREEN}D365 Order Lookup Test${NC}"
echo -e "${GREEN}============================================================================${NC}"
echo ""
echo -e "${YELLOW}Looking for order: ${SHOPIFY_ORDER_NAME}${NC}"
echo -e "${YELLOW}Data Area: ${D365_DATA_AREA_ID}${NC}"
echo ""

# Step 1: Get Auth Token
echo -e "${YELLOW}Step 1: Authenticating to D365...${NC}"
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

echo -e "${GREEN}✅ Authentication successful${NC}"
echo ""

# Step 2: Query for order
echo -e "${YELLOW}Step 2: Querying D365 for order...${NC}"
FILTER="dataAreaId eq '${D365_DATA_AREA_ID}' and THK_ShopifyReference eq '${SHOPIFY_ORDER_NAME}'"
URL="${D365_BASE_URL}/data/SalesOrderHeadersV3?\$filter=${FILTER}"
ENCODED_URL="${D365_BASE_URL}/data/SalesOrderHeadersV3?\$filter=$(echo "$FILTER" | jq -sRr @uri)"

echo -e "${YELLOW}Query: ${FILTER}${NC}"
echo -e "${YELLOW}URL: ${ENCODED_URL}${NC}"
echo ""

RESPONSE=$(curl -s -X GET "$ENCODED_URL" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json")

echo -e "${YELLOW}Response:${NC}"
echo "$RESPONSE" | jq .

echo ""
ORDERS_COUNT=$(echo "$RESPONSE" | jq '.value | length')

if [ "$ORDERS_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✅ Found ${ORDERS_COUNT} order(s)${NC}"
  echo ""
  echo "$RESPONSE" | jq '.value[] | {SalesOrderNumber, THK_ShopifyReference, dataAreaId, OrderStatus}'
else
  echo -e "${RED}❌ No orders found${NC}"
  echo ""
  echo -e "${YELLOW}Trying without dataAreaId filter...${NC}"
  FILTER2="THK_ShopifyReference eq '${SHOPIFY_ORDER_NAME}'"
  ENCODED_URL2="${D365_BASE_URL}/data/SalesOrderHeadersV3?\$filter=$(echo "$FILTER2" | jq -sRr @uri)"
  RESPONSE2=$(curl -s -X GET "$ENCODED_URL2" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json")
  
  COUNT2=$(echo "$RESPONSE2" | jq '.value | length')
  if [ "$COUNT2" -gt 0 ]; then
    echo -e "${GREEN}✅ Found ${COUNT2} order(s) without dataAreaId filter${NC}"
    echo "$RESPONSE2" | jq '.value[] | {SalesOrderNumber, THK_ShopifyReference, dataAreaId, OrderStatus}'
  else
    echo -e "${RED}❌ Still no orders found${NC}"
  fi
fi

echo ""
echo -e "${GREEN}============================================================================${NC}"

