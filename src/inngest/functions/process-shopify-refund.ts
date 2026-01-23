import fs from 'fs/promises';
import path from 'path';
import { inngest } from "../client";
import { config } from "@/lib/config";
import * as dynamics from "@/lib/clients/dynamics";
import { getLatestShopifyOrder } from "@/lib/clients/shopify";
import { calculateRefundAmounts, createReturnOrderEntity, createReturnOrderLineEntity, extractRefundDetails, mapRefundLineItems, updateReturnOrderEntity, updateReturnOrderLineEntity } from '@/lib/transformers/refund';

export const processShopifyRefund = inngest.createFunction(
  {
    id: "process-shopify-refund",
    name: "Process Shopify Refund",
    idempotency: "event.data.refundId",
    retries: 5,
    throttle: {
      limit: 5,
      period: "1s",
      key: "event.data.shopifyStore",
    },
    concurrency: [
      {
        limit: 1,
        key: "event.data.shopifyOrderId",
      },
    ],
    rateLimit: {
      key: "event.data.shopifyOrderId",
      limit: 3,
      period: "24h",
    },
  },
  { event: 'shopify/refunds.create' },
  async ({ event, step }) => {
    const { orderId, refundId, detail } = event.data;

    // Step 1: Get Latest Order Data
    const orderData = await step.run('get-latest-order', async () => {
      return await getLatestShopifyOrder(orderId);
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
      throw new Error(`Sales order not found for Shopify order ${orderId}`);
    }

    // Step 3: Extract and Map Refund Details
    const refundData = await step.run('process-refund-details', async () => {
      const refundDetails = extractRefundDetails(detail.body);
      const mappedItems = mapRefundLineItems(refundDetails, salesOrder);
      const amounts = calculateRefundAmounts(mappedItems);
      
      return { refundDetails, mappedItems, amounts };
    });

    // Step 4: Check for Existing Return Order
    const existingReturn = await step.run('check-existing-return', async () => {
      // Read the mock file
      const mockPath = path.join(process.cwd(), 'mocks/returnorder/returnorder.json');
      const fileContent = await fs.readFile(mockPath, 'utf-8');
      const returnOrders = JSON.parse(fileContent);
      
      // Find the matching order
      return returnOrders.find((order: any) => order.id === orderId.toString());
    });

    if (existingReturn) {
      return { status: 'processed', message: 'Return order already exists', returnOrderId: existingReturn.returnorderId };
    }

    // Step 5: Create Return Order Record
    const returnOrder = await step.run('create-return-order', async () => {
      return await createReturnOrderEntity({
        salesOrderId: salesOrder.salesorderId,
        shopifyRefundId: refundId.toString(),
        refundAmount: refundData.amounts.total,
        refundReason: refundData.refundDetails.note,
      });
    });

    // Step 6: Create Return Order Lines
    const returnOrderLines = await step.run('create-return-order-lines', async () => {
      const lines = [];
      for (const item of refundData.mappedItems) {
        const line = await createReturnOrderLineEntity({
          returnOrderId: returnOrder.returnorderId,
          salesOrderLineId: item.salesOrderLineId,
          quantity: item.refundQuantity,
          amount: item.refundAmount,
        });
        lines.push(line);
      }
      
      return lines;
    });

    // Step 7: Create Dynamics Return Order Header
    const dynamicsReturnOrder = await step.run('create-dynamics-return-header', async () => {
      const response = await dynamics.createSalesOrderHeadersV3ForReturn({
        method: 'POST',
        body: {
          SalesOrderNumber: salesOrder.dynamicSalesOrderNumber,
          ReturnReason: refundData.refundDetails.note,
          TotalAmount: refundData.amounts.total,
        }
      });
      
      // Update return order with Dynamics number
      await updateReturnOrderEntity(returnOrder.returnorderId, {
        dynamicsReturnOrderNumber: response.ReturnOrderNumber,
      });

      return response;
    });

    // Step 8: Create Dynamics Return Order Lines
    await step.run('create-dynamics-return-lines', async () => {
      for (const line of returnOrderLines) {
        const response = dynamics.createDynamicsReturnLines({
          method: 'POST',
          body: {
            ReturnOrderNumber: dynamicsReturnOrder.ReturnOrderNumber,
            ItemNumber: line.itemNumber,
            Quantity: line.quantity,
            Amount: line.amount,
          }
        });
        
        // Update line with inventory lot ID
        await updateReturnOrderLineEntity(line.returnorderlineId, {
          dynamicsInventoryLotId: response.InventoryLotId,
        });
      }
    });

    // Step 9: Confirm Dynamics Return Order
    await step.run('confirm-dynamics-return', async () => {
      await dynamics.confirmDynamicsReturn({
        method: 'POST',
        body: {
          ReturnOrderNumber: dynamicsReturnOrder.ReturnOrderNumber,
        }
      });
      
      // Update confirmation status
      await updateReturnOrderEntity(returnOrder.returnorderId, {
        dynamicsConfirmed: true,
      });
    });

    // Step 10: Process Refund Payment
    await step.run('process-refund-payment', async () => {
      await dynamics.processRefundPayment({
        method: 'POST',
        body: {
          ReturnOrderNumber: dynamicsReturnOrder.ReturnOrderNumber,
          RefundAmount: refundData.amounts.total,
          PaymentMethod: refundData.refundDetails.paymentMethod,
        }
      });
      
      // Update refund status
      await updateReturnOrderEntity(returnOrder.returnorderId, {
        refundProcessed: true,
      });
    });

    // Step 11: Send Notification
    await step.run('send-notification', async () => {
      await sendSlackNotification({
        channel: 'refunds',
        message: `✅ Refund processed: Order ${salesOrder.shopifySalesOrderName}, Amount: $${refundData.amounts.total}`,
      });
    });

    return {
      status: 'processed',
      returnOrderId: returnOrder.returnorderId,
      dynamicsReturnOrderNumber: dynamicsReturnOrder.ReturnOrderNumber,
      refundAmount: refundData.amounts.total,
    };
  }
);
