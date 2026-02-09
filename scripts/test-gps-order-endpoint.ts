/**
 * Test GPS OMS API Order endpoint (known working)
 * to confirm credentials are valid
 */

import crypto from "crypto";

const API_KEY = "ac24ea540f0c4a0681814a5bfd0eb644";
const API_SECRET = "8e3bf78a75c54a01a621879790446a35";
const BASE_URL = "https://api.xlwms.com";

function generateAuthCode(
  appKey: string,
  appSecret: string,
  timestamp: string,
  data: Record<string, unknown>
): string {
  const dataStr = JSON.stringify(data);
  const signStr = `${appKey}${timestamp}${dataStr}${appSecret}`;
  return crypto.createHmac("sha256", appSecret).update(signStr).digest("hex");
}

async function main() {
  console.log("Testing GPS Order Detail endpoint (known working)...\n");

  const timestamp = Math.floor(Date.now() / 1000).toString();
  
  // Test with outboundOrder/detail which is used in spock-store
  const data = {
    outboundOrderNoList: ["TEST-ORDER-123"]
  };

  const authCode = generateAuthCode(API_KEY, API_SECRET, timestamp, data);

  const requestBody = {
    appKey: API_KEY,
    data,
    reqTime: timestamp,
  };

  const url = `${BASE_URL}/openapi/v1/outboundOrder/detail?authcode=${authCode}`;

  console.log("URL:", url);
  console.log("Request Body:", JSON.stringify(requestBody, null, 2));
  console.log();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const body = await response.json();
    console.log("Response Status:", response.status);
    console.log("Response Body:", JSON.stringify(body, null, 2));

    if (body.code === 0) {
      console.log("\n✅ Order endpoint is working! Credentials are valid.");
    } else if (body.code === 11008) {
      console.log("\n❌ No permission for this endpoint either.");
    } else {
      console.log("\n⚠️  Got response but might have different issue:", body.msg);
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

main().catch(console.error);
