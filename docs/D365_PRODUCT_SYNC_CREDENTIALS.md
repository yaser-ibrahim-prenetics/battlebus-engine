# Dynamics 365 Product Sync API - Credentials & Testing Guide

## Required Credentials

To use the Dynamics 365 ReleasedProductsV2 OData API, you need Azure AD (Entra ID) app registration credentials:

### Environment Variables

```bash
D365_BASE_URL=https://p-uat.sandbox.operations.dynamics.com  # Your D365 environment URL
D365_TENANT_ID=your_azure_tenant_id                          # Azure AD tenant ID (GUID)
D365_CLIENT_ID=your_azure_app_client_id                      # Azure AD app registration client ID (GUID)
D365_CLIENT_SECRET=your_azure_app_client_secret              # Azure AD app registration client secret
D365_DATA_AREA_ID=U001                                       # D365 company/legal entity ID
```

### Optional Environment Variables

```bash
D365_SCOPE=${D365_BASE_URL}/.default  # Defaults to ${D365_BASE_URL}/.default
```

### Where to Get Credentials

1. **Azure Portal** (https://portal.azure.com)
   - Navigate to **Azure Active Directory** (or **Microsoft Entra ID**)
   - Go to **App registrations**
   - Find or create your app registration

2. **Get Tenant ID**:
   - Azure AD → Overview → **Tenant ID** (GUID format)

3. **Get Client ID**:
   - App Registration → Overview → **Application (client) ID** (GUID format)

4. **Create Client Secret**:
   - App Registration → **Certificates & secrets**
   - Click **New client secret**
   - Copy the **Value** (you can only see it once!)
   - Note the expiration date

5. **Configure API Permissions**:
   - App Registration → **API permissions**
   - Add permission → **Dynamics ERP API** (or your D365 API)
   - Select **Delegated permissions** or **Application permissions** as needed
   - **Grant admin consent** (required for application permissions)

6. **Get Data Area ID**:
   - Log in to D365
   - Go to **Organization administration** → **Organizations**
   - Find your company → **Legal entity ID** (e.g., "U001", "H007")

## Authentication Method

Dynamics 365 uses **OAuth2 Client Credentials Flow**:

1. **Request Access Token**:

   ```
   POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=client_credentials
   client_id={clientId}
   client_secret={clientSecret}
   scope={baseUrl}/.default
   ```

2. **Use Bearer Token**:

   ```
   Authorization: Bearer {access_token}
   ```

3. **Token Expiration**:
   - Tokens typically expire in 3600 seconds (1 hour)
   - Implementation automatically refreshes tokens

## Testing the API

### Option 1: Using the Test Script

Run the provided test script:

```bash
cd inngest
npm run test:d365-product
```

Or directly:

```bash
npx tsx scripts/test-d365-product-sync.ts
```

This will:

- ✅ Check if credentials are configured
- ✅ Authenticate with Azure AD
- ✅ Check if test product exists
- ✅ Create or update the product
- ✅ Display the response

### Option 2: Manual cURL Test

```bash
# Set your credentials
export D365_TENANT_ID="your_tenant_id"
export D365_CLIENT_ID="your_client_id"
export D365_CLIENT_SECRET="your_client_secret"
export D365_BASE_URL="https://p-uat.sandbox.operations.dynamics.com"
export D365_DATA_AREA_ID="U001"

# Step 1: Get access token
TOKEN_RESPONSE=$(curl -X POST \
  "https://login.microsoftonline.com/${D365_TENANT_ID}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=${D365_CLIENT_ID}" \
  -d "client_secret=${D365_CLIENT_SECRET}" \
  -d "scope=${D365_BASE_URL}/.default")

ACCESS_TOKEN=$(echo $TOKEN_RESPONSE | jq -r '.access_token')

# Step 2: Check if product exists
curl -X GET \
  "${D365_BASE_URL}/data/ReleasedProductsV2?\$filter=ItemNumber eq 'TEST-123' and dataAreaId eq '${D365_DATA_AREA_ID}'" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "OData-MaxVersion: 4.0" \
  -H "OData-Version: 4.0"

# Step 3: Create product
curl -X POST \
  "${D365_BASE_URL}/data/ReleasedProductsV2" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "OData-MaxVersion: 4.0" \
  -H "OData-Version: 4.0" \
  -d '{
    "ItemNumber": "TEST-123",
    "ProductName": "Test Product",
    "dataAreaId": "'${D365_DATA_AREA_ID}'",
    "ProductType": "Item"
  }'
```

### Option 3: Test via D365 Web Client

1. Log in to D365
2. Navigate to **Product information management** → **Products** → **Released products**
3. Search for your test product by Item number
4. Verify product was created/updated

## API Endpoint Details

### Endpoint

```
GET/POST/PATCH https://{baseUrl}/data/ReleasedProductsV2
```

### Check if Product Exists

```
GET /data/ReleasedProductsV2?$filter=ItemNumber eq '{sku}' and dataAreaId eq '{dataAreaId}'&$top=1
```

### Create Product

```
POST /data/ReleasedProductsV2
Content-Type: application/json
Authorization: Bearer {access_token}

{
  "ItemNumber": "PROD-123",
  "ProductDescription": "Product Name",  // Note: Use ProductDescription, not ProductName
  "dataAreaId": "U001",
  "ProductSearchName": "BARCODE-123",     // Optional: barcode
  "NetWeight": 0.5                        // Optional: weight in kg
}
```

### Update Product

```
PATCH /data/ReleasedProductsV2(ItemNumber='PROD-123',dataAreaId='U001')
Content-Type: application/json
Authorization: Bearer {access_token}
If-Match: *

{
  "ProductDescription": "Updated Product Name",  // Note: Use ProductDescription, not ProductName
  "ProductSearchName": "NEW-BARCODE",
  "NetWeight": 1.0
}
```

### Response Format

```json
{
  "@odata.context": "https://...",
  "value": [
    {
      "ItemNumber": "PROD-123",
      "ProductName": "Product Name",
      "dataAreaId": "U001"
    }
  ]
}
```

## Common Error Codes

| HTTP Status | Description           | Solution                                               |
| ----------- | --------------------- | ------------------------------------------------------ |
| 401         | Unauthorized          | Check access token, ensure it's not expired            |
| 403         | Forbidden             | Check API permissions in Azure AD, grant admin consent |
| 404         | Not Found             | Check D365_BASE_URL is correct                         |
| 400         | Bad Request           | Check request body format, required fields             |
| 409         | Conflict              | Product may already exist with different data          |
| 500         | Internal Server Error | D365 server error, check D365 status                   |

### Azure AD Authentication Errors

| Error           | Description              | Solution                            |
| --------------- | ------------------------ | ----------------------------------- |
| `AADSTS7000215` | Invalid client secret    | Check D365_CLIENT_SECRET is correct |
| `AADSTS700016`  | Application not found    | Check D365_CLIENT_ID is correct     |
| `AADSTS90002`   | Tenant not found         | Check D365_TENANT_ID is correct     |
| `AADSTS65005`   | Insufficient permissions | Grant API permissions in Azure AD   |

## Required Product Fields

### Mandatory Fields:

- `ItemNumber` - Product SKU (string, max 20 chars)
- `ProductDescription` - Product name/description (string) - **Note**: `ReleasedProductsV2` uses `ProductDescription`, not `ProductName`
- `dataAreaId` - Legal entity ID (string, e.g., "U001", "H007")

### Optional Fields:

- `ProductSearchName` - Barcode/Search name (string)
- `NetWeight` - Weight in kg (decimal)
- `ProductColorId` - Color ID (string)
- `ProductSizeId` - Size ID (string)
- `ProductStyleId` - Style ID (string)

**Important Note**: `ReleasedProductsV2` does not support `ProductName`. Use `ProductDescription` instead. The older `ReleasedProducts` endpoint may support `ProductName`, but `ReleasedProductsV2` is the recommended endpoint for new implementations.

## OData Query Options

### Filter Products

```
/data/ReleasedProductsV2?$filter=ItemNumber eq 'PROD-123' and dataAreaId eq 'U001'
```

### Select Specific Fields

```
/data/ReleasedProductsV2?$select=ItemNumber,ProductDescription,NetWeight
```

### Top N Results

```
/data/ReleasedProductsV2?$top=10
```

### Order By

```
/data/ReleasedProductsV2?$orderby=ProductDescription asc
```

## Testing Checklist

- [ ] D365_TENANT_ID is set in environment
- [ ] D365_CLIENT_ID is set in environment
- [ ] D365_CLIENT_SECRET is set in environment
- [ ] D365_BASE_URL is correct
- [ ] D365_DATA_AREA_ID matches your company
- [ ] Azure AD app has API permissions granted
- [ ] Admin consent granted for API permissions
- [ ] Test script runs without errors
- [ ] Authentication succeeds
- [ ] Product appears in D365
- [ ] Product can be used in sales orders

## Troubleshooting

### "401 Unauthorized" or "403 Forbidden"

- **Check API Permissions**: Azure Portal → App Registration → API permissions
- **Grant Admin Consent**: Click "Grant admin consent" button
- **Verify Scope**: Ensure scope is `${D365_BASE_URL}/.default`
- **Check Token**: Verify access token is valid and not expired

### "Application not found" (AADSTS700016)

- Verify D365_CLIENT_ID matches Azure AD app registration
- Check app registration exists in correct tenant

### "Invalid client secret" (AADSTS7000215)

- Verify D365_CLIENT_SECRET matches the secret in Azure AD
- Check if secret has expired (create new secret if needed)
- Ensure you copied the **Value**, not the Secret ID

### "Product not found" (404)

- Check D365_BASE_URL is correct for your environment
- Verify dataAreaId matches your company
- Ensure product exists in D365 (check via web client)

### "Bad Request" (400)

- Check required fields are present (ItemNumber, ProductName, dataAreaId)
- Verify field names match D365 OData schema exactly
- Check data types (strings vs numbers)

### Product Created But Not Visible

- Products may need to be **released** in D365
- Check **Product information management** → **Products** → **Released products**
- Verify you're looking in the correct company (dataAreaId)

## Azure AD App Registration Setup

### Step-by-Step Guide

1. **Create App Registration**:
   - Azure Portal → Azure AD → App registrations → New registration
   - Name: "Battle Bus D365 Integration"
   - Supported account types: Single tenant
   - Register

2. **Configure API Permissions**:
   - App Registration → API permissions → Add a permission
   - Select **Dynamics ERP API** (or your D365 API)
   - Choose **Application permissions**
   - Select required permissions (e.g., `Finance.ReadWrite.All`)
   - **Grant admin consent**

3. **Create Client Secret**:
   - App Registration → Certificates & secrets
   - New client secret
   - Description: "Battle Bus Integration"
   - Expires: 24 months (or as needed)
   - Add → **Copy the Value immediately**

4. **Configure D365**:
   - D365 → System administration → System administration → Azure Active Directory applications
   - Register your app's Client ID
   - Grant necessary D365 permissions

## Security Best Practices

- ✅ Store secrets in environment variables, never in code
- ✅ Use Azure Key Vault for production secrets
- ✅ Rotate client secrets regularly
- ✅ Use least-privilege permissions
- ✅ Monitor API access logs in Azure AD
- ✅ Set appropriate secret expiration dates
