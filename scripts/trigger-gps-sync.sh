#!/bin/bash

# ============================================================================
# TRIGGER GPS SYNC MANUALLY
# ============================================================================
# Manually triggers the GPS fulfillment sync scheduler
# Usage: ./scripts/trigger-gps-sync.sh

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

INNGEST_DEV_URL="http://localhost:8288"

echo -e "${BLUE}============================================================================${NC}"
echo -e "${BLUE}Trigger GPS Sync Scheduler${NC}"
echo -e "${BLUE}============================================================================${NC}"
echo ""

# Send cron event to trigger the scheduler
echo -e "${YELLOW}Triggering GPS sync scheduler...${NC}"

# Inngest cron functions can be triggered by sending a cron event
# The function listens to cron schedule, but we can trigger it manually via dashboard
# or by sending a test event

echo -e "${YELLOW}Note: GPS sync runs on a cron schedule.${NC}"
echo -e "${YELLOW}To trigger manually:${NC}"
echo "  1. Open Inngest Dashboard: http://localhost:8288"
echo "  2. Find 'Sync GPS Fulfillments' function"
echo "  3. Click 'Trigger' or 'Run'"
echo ""
echo -e "${YELLOW}Or wait for the next scheduled run (every ${GPS_SCHEDULE_INTERVAL:-60} minutes)${NC}"
echo ""

