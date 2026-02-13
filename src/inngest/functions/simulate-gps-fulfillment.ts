// ============================================================================
// SIMULATE GPS FULFILLMENT
// ============================================================================
// Marks recent GPS orders as fulfilled for testing purposes
// This allows testing the fulfillment flow without waiting for real GPS shipping

import { inngest } from "../client";
import { config } from "@/lib/config";
import * as shopify from "@/lib/clients/shopify";
import * as dynamics from "@/lib/clients/dynamics";
import { gpsSimulationStore, type SimulatedFulfillment } from "@/lib/stores/gps-simulation";
import { getGpsWarehouseFromLocation } from "@/lib/utils/validation";
import { RETRY_CONFIGS } from "@/lib/utils/constants";

export const simulateGpsFulfillment = inngest.createFunction(
  {
    id: "simulate-gps-fulfillment",
    name: "Simulate GPS Fulfillment",
    retries: RETRY_CONFIGS.DEFAULT,
  },
  { event: "gps/simulate.fulfillment" },
  async ({ event, step }: { event: any; step: any }) => {
    const { minutesAgo = 5, orderNames = [] } = event.data;

    if (!config.features.enableGpsFulfillmentSimulation) {
      return {
        status: "disabled",
        message: "GPS fulfillment simulation is not enabled. Set ENABLE_GPS_FULFILLMENT_SIMULATION=true",
      };
    }

    // 1. Get recent orders from Shopify
    const recentOrders = await step.run("get-recent-orders", async () => {
      if (orderNames.length > 0) {
        // If specific orders provided, search by name
        const orders = await Promise.all(
          orderNames.map(async (name: string) => {
            try {
              // Search by order name (e.g., #D365-GPS-123456)
              const foundOrders = await shopify.searchOrdersByName(name);
              return foundOrders[0] || null; // Return first match
            } catch (error) {
              console.warn(`[Simulation] Could not fetch order ${name}: ${error}`);
              return null;
            }
          })
        );
        return orders.filter((o): o is shopify.ShopifyOrder => o !== null);
      }

      // Otherwise, get unfulfilled orders created in last N minutes
      const cutoffTime = new Date(Date.now() - minutesAgo * 60 * 1000);
      const unfulfilledOrders = await shopify.getUnfulfilledOrders(100);
      
      return unfulfilledOrders.filter((order) => {
        const createdAt = new Date(order.created_at);
        return createdAt >= cutoffTime;
      });
    });

    if (recentOrders.length === 0) {
      return {
        status: "no_orders",
        message: `No orders found in the last ${minutesAgo} minutes`,
      };
    }

    // 2. Identify GPS orders and mark them as fulfilled
    const fulfillments: SimulatedFulfillment[] = [];

    for (const order of recentOrders) {
      await step.run(`process-order-${order.id}`, async () => {
        try {
          // Get fulfillment orders to determine warehouse
          const fulfillmentOrders = await shopify.getFulfillmentOrders(order.id);
          
          let warehouse: "GPS Warehouse" | "GPS UK Warehouse" | null = null;

          for (const fo of fulfillmentOrders) {
            if (fo.status !== "open" && fo.status !== "in_progress") continue;
            
            // assigned_location_id is the direct property, assigned_location.location_id is nested
            const locationId = fo.assigned_location_id || (fo.assigned_location ? fo.assigned_location.location_id : null);
            const detectedWarehouse = getGpsWarehouseFromLocation(locationId || "");
            
            if (detectedWarehouse) {
              warehouse = detectedWarehouse;
              break;
            }
          }

          // Get D365 order number by looking up using order name
          let thirdOrderNo: string | undefined;
          if (config.features.enableDynamicsSync) {
            try {
              const d365Order = await dynamics.getSalesOrderByShopifyId(order.name);
              if (d365Order?.SalesOrderNumber) {
                thirdOrderNo = d365Order.SalesOrderNumber;
              }
            } catch (error) {
              console.warn(`[Simulation] Could not fetch D365 order for ${order.name}: ${error}`);
            }
          }
          
          if (warehouse) {
            // Generate mock tracking data
            const trackingNumber = `SIM-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;
            const carriers = ["FEDEX", "UPS", "USPS"];
            const carrier = carriers[Math.floor(Math.random() * carriers.length)];

            const fulfillment: SimulatedFulfillment = {
              platformOrderNo: order.name,
              thirdOrderNo: thirdOrderNo,
              trackingNumber,
              carrier,
              outboundTime: new Date().toISOString(),
              warehouse,
            };

            fulfillments.push(fulfillment);
            console.log(`[Simulation] Marking ${order.name} as fulfilled (${warehouse})`);
          } else {
            console.log(`[Simulation] Skipping ${order.name} - not a GPS order`);
          }
        } catch (error) {
          console.error(`[Simulation] Error processing order ${order.name}: ${error}`);
        }
      });
    }

    // 3. Mark all fulfillments in the store
    await step.run("mark-fulfilled", async () => {
      gpsSimulationStore.markMultipleFulfilled(fulfillments);
      return { count: fulfillments.length };
    });

    return {
      status: "success",
      marked: fulfillments.length,
      orders: fulfillments.map((f) => ({
        orderName: f.platformOrderNo,
        warehouse: f.warehouse,
        trackingNumber: f.trackingNumber,
        carrier: f.carrier,
      })),
      message: `Marked ${fulfillments.length} orders as fulfilled. Scheduler will pick them up on next run.`,
    };
  }
);

