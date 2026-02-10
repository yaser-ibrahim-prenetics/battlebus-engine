#!/bin/bash
# Test GPS Product Batch Create API
# 
# This script tests the GPS product sync API using curl
# 
# Usage:
#   ./scripts/test-gps-product-sync.sh
# 
# Required Environment Variables:
#   GPS_API_KEY - Your GPS appKey
#   GPS_API_SECRET - Your GPS appSecret
#   GPS_BASE_URL - GPS API base URL (default: https://api.xlwms.com)

set -e

GPS_BASE_URL="${GPS_BASE_URL:-https://api.xlwms.com}"
GPS_API_KEY="${GPS_API_KEY:-}"
GPS_API_SECRET="${GPS_API_SECRET:-}"

echo "============================================================"
echo "GPS PRODUCT BATCH CREATE API TEST"
echo "============================================================"
echo ""

# Check credentials
if [ -z "$GPS_API_KEY" ] || [ -z "$GPS_API_SECRET" ]; then
  echo "❌ Missing GPS API credentials!"
  echo ""
  echo "Required Environment Variables:"
  echo "  GPS_API_KEY=your_app_key"
  echo "  GPS_API_SECRET=your_app_secret"
  echo ""
  echo "Optional:"
  echo "  GPS_BASE_URL=https://api.xlwms.com (default)"
  echo ""
  echo "Example:"
  echo "  GPS_API_KEY=9d093e6f60af4e5d8d01f22ee5bb9353 \\"
  echo "  GPS_API_SECRET=4cf5d93e0b97455a99f85cb5dfd5cf02 \\"
  echo "  ./scripts/test-gps-product-sync.sh"
  echo ""
  exit 1
fi

echo "📋 Configuration:"
echo "   Base URL: $GPS_BASE_URL"
echo "   API Key: ${GPS_API_KEY:0:8}..."
echo "   API Secret: ***${GPS_API_SECRET: -4}"
echo ""

# Generate timestamp
TIMESTAMP=$(date +%s)
TEST_SKU="TEST-$(date +%s)"

echo "📦 Test Product:"
echo "   SKU: $TEST_SKU"
echo "   Timestamp: $TIMESTAMP"
echo ""

# Note: This script requires Node.js/TypeScript to generate the authcode
# For a pure bash version, you'd need to implement HMAC SHA256 in bash
# which is complex. Instead, we'll use the TypeScript version.

echo "💡 Note: For full testing with authcode generation, use the TypeScript version:"
echo "   npm run test:gps-product"
echo ""
echo "Or:"
echo "   npx tsx scripts/test-gps-product-sync.ts"
echo ""
echo "This shell script is a helper to show required credentials."
echo ""

