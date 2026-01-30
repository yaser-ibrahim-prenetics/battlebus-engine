#!/bin/bash

# ============================================================================
# SIMULATE GPS FULFILLMENT
# ============================================================================
# Marks recent GPS orders as fulfilled for testing
# Usage: ./scripts/simulate-gps-fulfillment.sh [minutes_ago] [order_names...]
# Example: ./scripts/simulate-gps-fulfillment.sh 5
# Example: ./scripts/simulate-gps-fulfillment.sh 0 "#D365-GPS-123" "#D365-GPS-456"

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

MINUTES_AGO="${1:-5}"
BASE_DIR="/Users/prenetics/work/Development/battle-bus/battle-bus-inngest"

# Get ngrok URL
NGROK_URL=$(cd "${BASE_DIR}" && ./scripts/get-ngrok-urls.sh 2>/dev/null | grep "App Tunnel" | grep -o "https://[a-z0-9-]*\.ngrok-free\.app" | head -1)
if [ -z "$NGROK_URL" ]; then
  NGROK_URL="https://b397937f982d.ngrok-free.app"
  echo -e "${YELLOW}⚠️  Could not auto-detect ngrok URL, using default: ${NGROK_URL}${NC}"
fi

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Simulate GPS Fulfillment${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${GREEN}Minutes ago: ${MINUTES_AGO}${NC}"
echo -e "${GREEN}NGROK URL: ${NGROK_URL}${NC}"
echo ""

# Build order names array if provided
ORDER_NAMES_JSON="[]"
if [ $# -gt 1 ]; then
  shift # Remove minutes_ago
  ORDER_NAMES=("$@")
  ORDER_NAMES_JSON=$(printf '%s\n' "${ORDER_NAMES[@]}" | jq -R . | jq -s .)
  echo -e "${GREEN}Specific orders: ${ORDER_NAMES[*]}${NC}"
  echo ""
fi

# Send event to Inngest Dev Server
echo -e "${YELLOW}Sending simulate fulfillment event to Inngest...${NC}"

EVENT_PAYLOAD=$(cat <<EOF
{
  "name": "gps/simulate.fulfillment",
  "data": {
    "minutesAgo": ${MINUTES_AGO},
    "orderNames": ${ORDER_NAMES_JSON}
  }
}
EOF
)

# Try Inngest Dev Server endpoint
INNGEST_DEV_URL="http://localhost:8288"

curl -s -X POST "${INNGEST_DEV_URL}/e/test" \
  -H "Content-Type: application/json" \
  -d "${EVENT_PAYLOAD}" > /dev/null 2>&1 && echo -e "${GREEN}✅ Event sent to Inngest Dev Server${NC}" || {
  echo -e "${YELLOW}⚠️  Could not send to Inngest Dev Server, trying alternative...${NC}"
  curl -s -X POST "${INNGEST_DEV_URL}/v1/events" \
    -H "Content-Type: application/json" \
    -d "[${EVENT_PAYLOAD}]" > /dev/null 2>&1 && echo -e "${GREEN}✅ Event sent via alternative endpoint${NC}" || {
    echo -e "${RED}❌ Could not send event. Make sure Inngest Dev Server is running on ${INNGEST_DEV_URL}${NC}"
    echo -e "${YELLOW}You can also trigger this manually via Inngest dashboard:${NC}"
    echo "  1. Open http://localhost:8288"
    echo "  2. Go to 'Events' tab"
    echo "  3. Click 'Send Event'"
    echo "  4. Use event name: gps/simulate.fulfillment"
    echo "  5. Use data: ${EVENT_PAYLOAD}"
  }
}
echo ""

echo ""
echo -e "${YELLOW}Waiting 10 seconds for processing...${NC}"
sleep 10

echo ""
echo -e "${GREEN}Checking logs...${NC}"
echo ""

# Check for simulation activity
tail -500 "${BASE_DIR}/logs/pm2-out.log" | grep -E "Simulation|simulate.*fulfillment|Marking.*fulfilled|GPS.*SIMULATION" | tail -30

echo ""
echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Next Steps${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""
echo -e "${YELLOW}The scheduler will pick up these orders on the next cron run.${NC}"
echo -e "${YELLOW}To trigger scheduler manually, you can:${NC}"
echo "  1. Wait for the next scheduled run (every ${GPS_SCHEDULE_INTERVAL:-60} minutes)"
echo "  2. Or trigger it manually via Inngest dashboard"
echo ""
echo -e "${YELLOW}To see all simulation logs:${NC}"
echo "tail -1000 ${BASE_DIR}/logs/pm2-out.log | grep -E 'Simulation|SIMULATION'"
echo ""

