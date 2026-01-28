import { NextRequest, NextResponse } from 'next/server';
import { inngest } from '@/inngest/client';
import { verifyWebhookSignature } from '@/lib/clients/gps';
import { isGpsIndividualFulfilmentPayload } from '@/lib/types/gps';
import { extractGpsFulfilmentData } from '@/lib/helpers/warehouse';

/**
 * POST - Process GPS Individual 
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get('x-signature');
    const timestamp = request.headers.get('x-timestamp');

    // Verify webhook signature (optional - skip if headers not present)
    if (signature && timestamp) {
      if (!verifyWebhookSignature(body, signature, timestamp)) {
        console.error('Invalid signature');
        return NextResponse.json(
          { success: false, error: 'Invalid signature' },
          { status: 401 }
        );
      }
    }

    // Parse payload
    const payload = JSON.parse(body);

    // Validate payload structure
    if (!isGpsIndividualFulfilmentPayload(payload)) {
      console.error('Invalid payload structure:', JSON.stringify(payload).slice(0, 500));
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid payload structure. Expected { type: \'individual\', warehouse: string, orderData: {...} }',
        },
        { status: 400 },
      );
    }

    // Extract key data for logging
    const extracted = extractGpsFulfilmentData(payload);

    console.log(
      `Received fulfilment: ` +
      `GPS Order: ${extracted.gpsOrderNo}, ` +
      `Shopify: ${extracted.shopifyOrderName}, ` +
      `Tracking: ${extracted.trackingNumber}, ` +
      `Warehouse: ${payload.warehouse}`
    );

    // Trigger Inngest event
    const result = await inngest.send({
      id: `gps-individual-${extracted.gpsOrderNo}-${extracted.trackingNumber}`,
      name: 'gps/individual.fulfilment',
      data: {
        gpsOrderNo: extracted.gpsOrderNo,
        shopifyOrderName: extracted.shopifyOrderName,
        trackingNumber: extracted.trackingNumber,
        warehouse: payload.warehouse,
        fulfilmentPayload: payload,
        receivedAt: new Date().toISOString(),
      },
    });
    console.log(`Triggered Inngest event: ${result.ids?.[0] || 'unknown'}`);

    return NextResponse.json(
      {
        success: true,
        message: 'GPS individual fulfilment received',
        data: {
          gpsOrderNo: extracted.gpsOrderNo,
          shopifyOrderName: extracted.shopifyOrderName,
          trackingNumber: extracted.trackingNumber,
          warehouse: payload.warehouse,
          eventId: result.ids?.[0],
        },
      },
      { status: 200 },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error processing webhook:', errorMessage);

    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
        message: errorMessage,
      },
      { status: 500 },
    );
  }
}

/**
 * GET - Health check endpoint
 */
export async function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      endpoint: '/api/webhooks/gps/individual',
      description: 'GPS Individual Fulfilment Webhook Handler',
    },
    { status: 200 },
  );
}
