// ============================================================================
// GPS FULFILLMENT SIMULATION STORE
// ============================================================================
// In-memory store for simulated GPS fulfillments during testing
// Orders marked here will be returned as fulfilled by getOutboundOrdersDetails

interface SimulatedFulfillment {
  platformOrderNo: string;
  thirdOrderNo?: string;
  trackingNumber: string;
  carrier: string;
  outboundTime: string;
  warehouse: "GPS Warehouse" | "GPS UK Warehouse";
}

class GpsSimulationStore {
  private fulfillments: Map<string, SimulatedFulfillment> = new Map();

  /**
   * Mark an order as simulated fulfilled
   */
  markFulfilled(fulfillment: SimulatedFulfillment): void {
    this.fulfillments.set(fulfillment.platformOrderNo, fulfillment);
    console.log(`[GPS Simulation] Marked ${fulfillment.platformOrderNo} as fulfilled`);
  }

  /**
   * Mark multiple orders as fulfilled
   */
  markMultipleFulfilled(fulfillments: SimulatedFulfillment[]): void {
    fulfillments.forEach((f) => this.markFulfilled(f));
  }

  /**
   * Get simulated fulfillment for an order
   */
  getFulfillment(platformOrderNo: string): SimulatedFulfillment | undefined {
    return this.fulfillments.get(platformOrderNo);
  }

  /**
   * Get all simulated fulfillments for a list of order names
   */
  getFulfillments(orderNames: string[]): SimulatedFulfillment[] {
    return orderNames
      .map((name) => this.getFulfillment(name))
      .filter((f): f is SimulatedFulfillment => f !== undefined);
  }

  /**
   * Clear all simulated fulfillments
   */
  clear(): void {
    this.fulfillments.clear();
    console.log(`[GPS Simulation] Cleared all simulated fulfillments`);
  }

  /**
   * Get count of simulated fulfillments
   */
  getCount(): number {
    return this.fulfillments.size;
  }

  /**
   * List all simulated fulfillments
   */
  listAll(): SimulatedFulfillment[] {
    return Array.from(this.fulfillments.values());
  }
}

// Singleton instance
export const gpsSimulationStore = new GpsSimulationStore();
export type { SimulatedFulfillment };

