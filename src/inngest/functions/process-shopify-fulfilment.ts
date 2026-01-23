// ============================================================================
// INNGEST FUNCTION: Process STORD Fulfilment
// ============================================================================
// Handles fulfilment notifications from STORD warehouse

import fs from 'fs/promises';
import path from 'path';
import { inngest } from "../client";
import * as dynamics from "@/lib/clients/dynamics";
import * as shopify from "@/lib/clients/shopify";

// Carrier code mapping for STORD
const CARRIER_MAPPING: Record<string, string> = {
  usps: "USPS",
  ups: "UPS",
  fedex: "FedEx",
  dhl: "DHL",
  ontrac: "OnTrac",
  lasership: "LaserShip",
};

export const processShopifyFulfillment = inngest.createFunction(
  { 
    id: 'shopify-fulfillment-processor',
    name: 'Process Shopify Order Fulfillment'
  },
  { event: 'shopify/orders.fulfilled' },
  async ({ event, step }) => {
    const { orderId, detail } = event.data;

    // Step 1: Get Latest Order Data
    const orderData = await step.run('get-latest-order', async () => {
      return await shopify.getLatestShopifyOrder(orderId);
    });

    // Step 2: Find Existing Sales Order
    const salesOrder = await step.run('find-sales-order', async () => {
      // Read the mock file
      const mockPath = path.join(process.cwd(), 'mocks/salesorder/salesorder.json');
      const fileContent = await fs.readFile(mockPath, 'utf-8');
      const salesOrders = JSON.parse(fileContent);
      
      // Find the matching order
      return salesOrders.find((order: any) => order.shopifyOrderId === orderId.toString());
    });

    if (!salesOrder) {
      return { 
        status: 'processed', 
        message: 'Sales order not found' 
      };
    }

    // Step 3: Get Fulfillment Orders
    const fulfillmentOrders = await step.run('get-fulfillment-orders', async () => {
      return await shopify.getFulfillmentOrders(orderId.toString());
    });

    // Step 4: Extract Delivery Address
    const deliveryAddress = await step.run('extract-delivery-address', async () => {
      const fulfillment = detail.body.fulfillments?.[0];
      if (!fulfillment) {
        throw new Error('No fulfillment data found');
      }
      
      return {
        name: fulfillment.destination?.name || detail.body.shipping_address?.name,
        address1: fulfillment.destination?.address1 || detail.body.shipping_address?.address1,
        address2: fulfillment.destination?.address2 || detail.body.shipping_address?.address2,
        city: fulfillment.destination?.city || detail.body.shipping_address?.city,
        province: fulfillment.destination?.province || detail.body.shipping_address?.province,
        country: fulfillment.destination?.country || detail.body.shipping_address?.country,
        zip: fulfillment.destination?.zip || detail.body.shipping_address?.zip,
        phone: fulfillment.destination?.phone || detail.body.shipping_address?.phone,
      };
    });

    // Step 5: Update Dynamics Delivery Address
    await step.run('update-dynamics-delivery-address', async () => {
      await dynamics.updateDynamicDeliveryAddress({
        method: 'POST',
        body: {
          SalesOrderNumber: salesOrder.dynamicSalesOrderNumber,
          DeliveryName: deliveryAddress.name,
          DeliveryAddress: deliveryAddress.address1,
          DeliveryAddress2: deliveryAddress.address2,
          DeliveryCity: deliveryAddress.city,
          DeliveryState: deliveryAddress.province,
          DeliveryCountry: deliveryAddress.country,
          DeliveryZipCode: deliveryAddress.zip,
          DeliveryPhone: deliveryAddress.phone,
        }
      });
      
      // Update status in database
      await updateSalesOrderEntity(salesOrder.salesorderId, {
        deliveryAddressUpdated: true,
      });
    });

    // Step 6: Create Fulfillment Records
    const fulfillmentRecords = await step.run('create-fulfillment-records', async () => {
      const records = [];
      
      for (const fulfillment of detail.body.fulfillments || []) {
        // Check if fulfillment already exists
        const existingFulfillment = await manager
          .createQueryBuilder(Fulfilment, 'f')
          .where('f.shopifyFulfillmentId = :fulfillmentId', { 
            fulfillmentId: fulfillment.id.toString() 
          })
          .getOne();
        
        if (existingFulfillment) {
          continue; // Skip if already exists
        }
        
        // Create fulfillment record
        const record = await manager.save(Fulfilment, {
          salesorderId: salesOrder.salesorderId,
          shopifyFulfillmentId: fulfillment.id.toString(),
          trackingNumber: fulfillment.tracking_number,
          trackingUrl: fulfillment.tracking_url,
          trackingCompany: fulfillment.tracking_company,
          status: fulfillment.status,
          createdAt: new Date(fulfillment.created_at),
        });
        
        records.push(record);
      }
      
      return records;
    });

    return {
      status: 'processed',
      salesOrderId: salesOrder.salesorderId,
      fulfillmentRecordsCreated: fulfillmentRecords.length,
    };
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function mapStordItemsToShopifyLineItems(
  stordItems: { sku: string; quantity: number }[],
  shopifyLineItems: shopify.ShopifyFulfillmentOrderLineItem[]
): { id: number; quantity: number }[] {
  return shopifyLineItems.map((item) => ({
    id: item.id,
    quantity: item.fulfillable_quantity,
  }));
}

function getTrackingUrl(carrierCode: string, trackingNumber: string): string {
  const carrier = carrierCode.toLowerCase();
  const urls: Record<string, string> = {
    usps: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
    ups: `https://www.ups.com/track?tracknum=${trackingNumber}`,
    fedex: `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`,
    dhl: `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
    ontrac: `https://www.ontrac.com/tracking/?number=${trackingNumber}`,
    lasership: `https://www.lasership.com/track/${trackingNumber}`,
  };

  return urls[carrier] || `https://track.aftership.com/${trackingNumber}`;
}
function updateSalesOrderEntity(salesorderId: any, arg1: { deliveryAddressUpdated: boolean; }) {
  throw new Error('Function not implemented.');
}

