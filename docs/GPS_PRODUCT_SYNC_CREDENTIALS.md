# GPS Product Sync API - Credentials & Testing Guide

## Required Credentials

To use the GPS Product Batch Create API (`/openapi/v1/product/batchCreate`), you need the following credentials:

### Environment Variables

#### For GPS Warehouse (US):
```bash
GPS_BASE_URL=https://api.xlwms.com
GPS_API_KEY=your_app_key_here
GPS_API_SECRET=your_app_secret_here
```

#### For GPS UK Warehouse:
```bash
GPS_UK_BASE_URL=https://api.xlwms.com  # Optional, defaults to GPS_BASE_URL
GPS_UK_API_KEY=your_uk_app_key_here
GPS_UK_API_SECRET=your_uk_app_secret_here
```

### Where to Get Credentials

1. **Log in to GPS OMS Portal** (https://oms.xlwms.com or your GPS portal URL)
2. **Navigate to API Information** section
3. **Copy your `appKey` and `appSecret`**
   - These are 32-character strings
   - Keep them secure - they provide full API access

### Credential Format

- **appKey**: 32-character hexadecimal string (e.g., `9d093e6f60af4e5d8d01f22ee5bb9353`)
- **appSecret**: 32-character hexadecimal string (e.g., `4cf5d93e0b97455a99f85cb5dfd5cf02`)
- **baseUrl**: `https://api.xlwms.com` (production) or your GPS API endpoint

## Authentication Method

GPS uses **HMAC SHA256** signature authentication:

1. **Sort data keys** alphabetically (case-insensitive)
2. **Concatenate**: `appKey + JSON.stringify(sortedData) + reqTime`
3. **Generate HMAC SHA256**: `HmacSHA256(concatenatedString, appSecret)`
4. **Append authcode** to URL as query parameter: `?authcode=<generated_hash>`

The implementation in `src/lib/clients/gps.ts` handles this automatically.

## Testing the API

### Option 1: Using the Test Script

Run the provided test script:

```bash
cd inngest
npm run tsx scripts/test-gps-product-sync.ts
```

Or directly:
```bash
tsx scripts/test-gps-product-sync.ts
```

This will:
- ✅ Check if credentials are configured
- ✅ Create a test product with unique SKU
- ✅ Call the GPS API
- ✅ Display the response

### Option 2: Manual cURL Test

```bash
# Set your credentials
export GPS_API_KEY="your_app_key"
export GPS_API_SECRET="your_app_secret"
export GPS_BASE_URL="https://api.xlwms.com"

# Generate timestamp
TIMESTAMP=$(date +%s)

# Create test product payload
PAYLOAD='{
  "appKey": "'$GPS_API_KEY'",
  "reqTime": "'$TIMESTAMP'",
  "data": [{
    "sku": "TEST-'$TIMESTAMP'",
    "productCode": "TEST-BARCODE-'$TIMESTAMP'",
    "productName": "Test Product",
    "length": "10",
    "width": "10",
    "height": "5",
    "weight": "0.5",
    "declareNameCn": "测试产品",
    "declareNameEn": "Test Product",
    "declarePrice": "10.00",
    "currencyCode": "USD",
    "countryOfOriginName": "CN",
    "dangerousCargo": "1"
  }]
}'

# Note: You need to generate authcode using the GPS algorithm
# For now, use the test script which handles this automatically
```

### Option 3: Test via GPS OMS Portal

1. Log in to GPS OMS Portal
2. Navigate to **API Information** → **Development Signing Tool** (开发验签工具)
3. Enter your test payload
4. Generate authcode and test the API

## API Endpoint Details

### Endpoint
```
POST /openapi/v1/product/batchCreate?authcode=<generated_authcode>
```

### Request Body
```json
{
  "appKey": "your_app_key",
  "reqTime": "1649745757",
  "data": [
    {
      "sku": "PROD-123",
      "productCode": "BARCODE-123",
      "productName": "Product Name",
      "length": "10",
      "width": "10",
      "height": "5",
      "weight": "0.5",
      "declareNameCn": "产品中文名",
      "declareNameEn": "Product English Name",
      "declarePrice": "10.00",
      "currencyCode": "USD",
      "countryOfOriginName": "CN",
      "dangerousCargo": "1"
    }
  ]
}
```

### Response
```json
{
  "code": 200,
  "msg": "操作成功",
  "data": [
    {
      "sku": "PROD-123",
      "success": true,
      "message": ""
    }
  ]
}
```

## Common Error Codes

| Code | Description | Solution |
|------|-------------|----------|
| 100001 | authcode is empty | Check authcode generation |
| 100002 | Request timeout | Timestamp must be within 5 minutes |
| 100004 | Timestamp is empty | Ensure reqTime is set |
| 100005 | appKey is empty | Set GPS_API_KEY |
| 100006 | appSecret is empty | Set GPS_API_SECRET |
| 100007 | authcode verification failed | Check API secret matches |
| 100008 | Missing parameters | Check all required fields |
| 100010 | No API permission | Contact GPS support to enable API access |

## Required Product Fields

### Mandatory Fields:
- `sku` - Product SKU (alphanumeric, max 100 chars)
- `productCode` - EAN/UPC barcode (max 50 chars)
- `productName` - Product name (max 255 chars)
- `length` - Length in cm (0.001~99999.999)
- `width` - Width in cm (0.001~99999.999)
- `height` - Height in cm (0.001~99999.999)
- `weight` - Weight in kg (0.001~99999.999)
- `declareNameCn` - Chinese declaration name (max 255 chars)
- `declareNameEn` - English declaration name (max 255 chars)
- `declarePrice` - Declaration price (BigDecimal)
- `currencyCode` - Currency code (fixed: "USD")
- `countryOfOriginName` - Country code (e.g., "CN", "US")
- `dangerousCargo` - Dangerous goods type (1-8, default: 1)

### Optional Fields:
- `productAliasName` - Product alias (max 255 chars)
- `productDescription` - Product description (max 255 chars)
- `imageUrl` - Product image URL
- `sizeUnit` - Size unit (default: "cm")
- `weightUnit` - Weight unit (default: "kg")
- `customhouseCode` - Customs code (max 10 chars)
- `otherCodeList` - Other barcodes (max 20 items)
- `fnskuList` - FNSKU list (max 20 items)

## Batch Limits

- **Maximum products per batch**: 200
- **Request timeout**: 5 minutes (reqTime must be within 5 minutes of server time)

## Testing Checklist

- [ ] GPS_API_KEY is set in environment
- [ ] GPS_API_SECRET is set in environment
- [ ] GPS_BASE_URL is correct (https://api.xlwms.com)
- [ ] Test script runs without errors
- [ ] API returns code 200
- [ ] Product appears in GPS OMS portal
- [ ] Product can be used in outbound orders

## Troubleshooting

### "authcode verification failed" (100007)
- Verify GPS_API_SECRET matches the one in GPS OMS portal
- Check that authcode generation algorithm matches GPS requirements
- Ensure timestamp is current (within 5 minutes)

### "No API permission" (100010)
- Contact GPS support to enable API access for your account
- Verify your account has product creation permissions

### "Missing parameters" (100008)
- Check all required fields are present
- Verify field names match GPS API documentation exactly
- Ensure numeric fields are strings (e.g., "10" not 10)

### Product not appearing in GPS
- Check GPS OMS portal for product approval status
- Products may need manual approval before use
- Verify product was created successfully (check response.data[].success)

