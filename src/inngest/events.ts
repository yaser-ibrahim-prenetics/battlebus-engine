// ============================================================================
// IM8 BATTLE BUS - EVENT DEFINITIONS
// ============================================================================
// These events replace the old Task Table polling system.
// Each event triggers a durable Inngest function instead of creating a DB row.

export type ShopifyOrderCreatedEvent = {
  name: "shopify/order.created";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    receivedAt: string;
  };
};

export type ShopifyRefundCreatedEvent = {
  name: "shopify/refund.created";
  data: {
    shopifyOrderId: string;
    refundId: string;
    shopifyStore: string;
    refundJson: ShopifyRefundPayload;
    receivedAt: string;
    /** Set when replaying from drain-pending-actions (do not re-queue indefinitely). */
    fromDrain?: boolean;
  };
};

export type ShopifyOrderCancelledEvent = {
  name: "shopify/order.cancelled";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    cancelledAt: string;
    cancelReason: string | null;
    receivedAt: string;
  };
};

export type ShopifyOrderPaidEvent = {
  name: "shopify/order.paid";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    receivedAt: string;
    /** Remaining stages to dispatch after this one succeeds (sequenced reruns). */
    runSequence?: RunSequenceStage[];
    /** Marker so downstream knows this came from a sequenced retry. */
    fromSequencedRetry?: boolean;
  };
};

export type ShopifyOrderUpdatedEvent = {
  name: "shopify/order.updated";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    receivedAt: string;
    // Track what changed for smarter processing
    changedFields?: string[];
  };
};

export type ShopifyOrderFulfilledEvent = {
  name: "shopify/order.fulfilled";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    orderJson: ShopifyOrderPayload;
    fulfillments: ShopifyFulfillment[];
    receivedAt: string;
    /** Remaining stages to dispatch after this one succeeds (sequenced reruns). */
    runSequence?: RunSequenceStage[];
    /** Marker so downstream knows this came from a sequenced retry. */
    fromSequencedRetry?: boolean;
    /** Set when replaying a fulfillment from a backorder retry. */
    fromBackorderRetry?: boolean;
  };
};

export type GpsFulfilmentReceivedEvent = {
  name: "gps/fulfilment.received";
  data: {
    gpsOrderId: string;
    shopifyOrderId: string;
    trackingNumber: string;
    carrierCode: string;
    fulfilmentJson: GpsFulfilmentPayload;
    receivedAt: string;
  };
};

export type StordFulfilmentReceivedEvent = {
  name: "stord/fulfilment.received";
  data: {
    stordOrderId: string;
    shopifyOrderId: string;
    trackingNumber: string;
    carrierCode: string;
    fulfilmentJson: StordFulfilmentPayload;
    receivedAt: string;
  };
};

// ============================================================================
// PRODUCT & INVENTORY SYNC EVENTS
// ============================================================================

export type ShopifyProductCreatedEvent = {
  name: "shopify/product.created";
  data: {
    productId: string;
    productTitle: string;
    shopifyStore: string;
    productJson: ShopifyProductPayload;
    receivedAt: string;
  };
};

export type ShopifyProductUpdatedEvent = {
  name: "shopify/product.updated";
  data: {
    productId: string;
    productTitle: string;
    shopifyStore: string;
    productJson: ShopifyProductPayload;
    receivedAt: string;
  };
};

export type ShopifyProductDeletedEvent = {
  name: "shopify/product.deleted";
  data: {
    productId: string;
    productTitle: string;
    shopifyStore: string;
    productJson: ShopifyProductPayload;
    receivedAt: string;
  };
};

export type ShopifyInventoryUpdatedEvent = {
  name: "shopify/inventory.updated";
  data: {
    inventoryItemId: string;
    locationId: string;
    shopifyStore: string;
    inventoryJson: ShopifyInventoryLevelPayload;
    receivedAt: string;
  };
};

// ============================================================================
// ACTION EVENTS (Triggered by Battle Hub direct actions)
// ============================================================================
// These events are sent when CS/Ops users trigger actions from Battle Hub.
// They enable real-time tracking in the Live Runs panel.

export type ActionOrderCancelEvent = {
  name: "action/order.cancel";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    reason: string;
    email: boolean;
    refund: boolean;
    cancelledAt: string;
    source: "battle-hub";
  };
};

export type ActionOrderRefundEvent = {
  name: "action/order.refund";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    refundId?: string;
    amount: string | number;
    reason: string;
    restock: boolean;
    refundedAt: string;
    source: "battle-hub";
  };
};

export type ActionOrderFulfillEvent = {
  name: "action/order.fulfill";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    fulfillmentId?: string;
    fulfillmentType: string;
    platform: string;
    trackingNumber: string;
    carrier: string;
    fulfilledAt: string;
    source: "battle-hub";
  };
};

// ============================================================================
// SUBSCRIPTION / RENEWAL EVENTS
// ============================================================================

export type SubscriptionRenewalEvent = {
  name: "shopify/subscription.renewed";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    subscriptionContractId: string;
    orderJson: ShopifyOrderPayload;
    receivedAt: string;
  };
};

// ============================================================================
// BACKORDER EVENTS
// ============================================================================

export type BackorderCreatedEvent = {
  name: "backorder/created";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    d365OrderNumber: string;
    warehouse: string;
    errorMessage: string;
    errorType: "out_of_stock" | "unmaintained_product" | "gps_error" | "inventory_insufficient";
    failedSkus: string[];
    retryCount: number;
    maxRetries: number;
    createdAt: string;
    /** Original flow that raised the backorder (e.g. shopify/order.paid, shopify/order.fulfilled). */
    sourceEventName?: string;
    /** High-level stage where failure happened (order_creation, fulfillment). */
    failureStage?: "order_creation" | "fulfillment";
    /** Primary system that failed for this backorder. */
    failureSystem?: "d365" | "gps";
    /**
     * Retry strategy consumed by process-backorder:
     * - gps_outbound: retry GPS outbound order creation
     * - fulfillment_replay: replay shopify/order.fulfilled pipeline
     */
    retryMode?: "gps_outbound" | "fulfillment_replay";
    /** Hub Backorders sub-queue tag used for route segmentation and replay policy. */
    backorderQueue?: "sync" | "fulfilment";
  };
};

export type BackorderResolvedEvent = {
  name: "backorder/resolved";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    resolvedAt: string;
    resolution: "fulfilled" | "cancelled" | "manual";
  };
};

export type BackorderRetryEvent = {
  name: "backorder/retry";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    d365OrderNumber: string;
    warehouse: string;
    retryCount: number;
    triggeredBy: "auto" | "manual" | "manual_bulk";
    sourceEventName?: string;
    failureStage?: "order_creation" | "fulfillment";
    failureSystem?: "d365" | "gps";
    retryMode?: "gps_outbound" | "fulfillment_replay";
    /** Hub Backorders sub-queue — stored in order state via CS platform update. */
    backorderQueue?: "sync" | "fulfilment";
    /**
     * Optional ordered list of pipeline stages to run when an order needs
     * multiple Inngest runs back-to-back (e.g. order_creation → fulfillment_replay).
     * The first stage is dispatched immediately; subsequent stages are forwarded
     * via event.data.runSequence and dispatched at the end of each successful
     * upstream run.
     */
    runSequence?: RunSequenceStage[];
  };
};

/**
 * A single pipeline stage in a sequenced rerun. Stages are persisted to
 * `orders.state.runSequence` for UI tracking and propagated through events
 * so each handler can dispatch the next stage on success.
 */
export type RunSequenceStage = {
  /** Stable id used by the Hub UI to dedupe and track stage progress. */
  id: string;
  /** Logical pipeline stage. */
  stage: "order_creation" | "fulfillment_replay" | "gps_outbound";
  /** Inngest event to dispatch for this stage. */
  eventName: "shopify/order.paid" | "shopify/order.fulfilled" | "backorder/retry";
  /** Lifecycle status surfaced in the Hub UI. */
  status?: "pending" | "in_progress" | "completed" | "failed" | "skipped";
  /** ISO timestamps populated as the stage moves through its lifecycle. */
  dispatchedAt?: string;
  completedAt?: string;
  /** Inngest run id that handled this stage (when known). */
  runId?: string;
  /** Last error message if the stage failed. */
  error?: string;
};

// ============================================================================
// INVENTORY MESH EVENTS (Centralized inventory sync routing)
// ============================================================================

export type InventorySyncEvent = {
  name: "inventory/sync";
  data: {
    source: string;
    destination: string;
    payload: {
      sku?: string;
      inventoryItemId?: string;
      variantId?: string;
      productId?: string;
      quantity?: number;
      available?: number;
      reserved?: number;
      committed?: number;
      locationId?: string | number;
      warehouseId?: string;
      warehouseName?: string;
      dataAreaId?: string;
      productTitle?: string;
      variantTitle?: string;
      barcode?: string;
      price?: string | number;
      weight?: number;
      weightUnit?: string;
      action?: "create" | "update" | "delete" | "adjust";
      source?: string;
      destination?: string;
      timestamp?: string;
      reason?: string;
    };
  };
};

// ============================================================================
// INVENTORY FULL SYNC (from Battle Hub)
// ============================================================================

export type InventoryFullSyncRequestedEvent = {
  name: "inventory/sync.requested";
  data: {
    syncId: string;
    steps: ("gps" | "d365" | "shopify")[];
    skus?: string[];
    dryRun?: boolean;
    requestedAt: string;
    requestedBy: string;
  };
};

// ============================================================================
// ORDER LIFECYCLE EVENTS
// ============================================================================

export type OrderLifecycleReadyEvent = {
  name: "order/lifecycle.ready";
  data: {
    shopifyOrderId: string;
    shopifyOrderName: string;
    shopifyStore: string;
    d365OrderNumber: string;
    warehouseName: string;
    dataAreaId: string;
  };
};

// Union type for all events
export type BattleBusEvents =
  | ShopifyOrderCreatedEvent
  | ShopifyRefundCreatedEvent
  | ShopifyOrderCancelledEvent
  | ShopifyOrderPaidEvent
  | ShopifyOrderUpdatedEvent
  | ShopifyOrderFulfilledEvent
  | ShopifyProductCreatedEvent
  | ShopifyProductUpdatedEvent
  | ShopifyProductDeletedEvent
  | ShopifyInventoryUpdatedEvent
  | GpsFulfilmentReceivedEvent
  | StordFulfilmentReceivedEvent
  | ActionOrderCancelEvent
  | ActionOrderRefundEvent
  | ActionOrderFulfillEvent
  | InventorySyncEvent
  | InventoryFullSyncRequestedEvent
  | SubscriptionRenewalEvent
  | BackorderCreatedEvent
  | BackorderResolvedEvent
  | BackorderRetryEvent
  | OrderLifecycleReadyEvent;

// ============================================================================
// PAYLOAD TYPES (Simplified - extend as needed from spock-store types)
// ============================================================================

export interface ShopifyOrderPayload {
  id: number;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  /** When present, prefer summing these for service tax line (matches spock-store calculateTax) */
  tax_lines?: ShopifyTaxLine[];
  currency: string;
  financial_status: string;
  fulfillment_status: string | null;
  line_items: ShopifyLineItem[];
  shipping_address: ShopifyAddress | null;
  billing_address: ShopifyAddress | null;
  shipping_lines: ShopifyShippingLine[];
  discount_codes: ShopifyDiscountCode[];
  note: string | null;
  tags: string;
  customer: ShopifyCustomer | null;
  refunds: ShopifyRefund[];
  cancel_reason: keyof typeof CancelReasonEnum | null;
  // Subscription / app metadata
  source_name: string | null; // 'subscription_contract' for Skio/Prive renewals
  app_id: number | null; // Shopify app ID that created the order
  note_attributes: { name: string; value: string }[]; // e.g. subscription contract ID from Skio
}

export interface ShopifyLineItem {
  id: number;
  variant_id: number | null;
  title: string;
  quantity: number;
  sku: string;
  variant_title: string | null;
  vendor: string | null;
  fulfillment_service: string;
  product_id: number | null;
  requires_shipping: boolean;
  taxable: boolean;
  gift_card: boolean;
  name: string;
  price: string;
  total_discount: string;
  fulfillment_status: string | null;
  properties: { name: string; value: string }[];
  tax_lines: ShopifyTaxLine[];
}

export interface ShopifyAddress {
  first_name: string;
  last_name: string;
  address1: string;
  address2: string | null;
  city: string;
  province: string;
  country: string;
  zip: string;
  phone: string | null;
  company: string | null;
  country_code: string;
  province_code: string;
}

export interface ShopifyShippingLine {
  id: number;
  title: string;
  price: string;
  /** Post-discount line total (Shopify); used for LineDiscountAmount on D365 service line, spock parity */
  discounted_price?: string;
  code: string;
  source: string;
  carrier_identifier: string | null;
  tax_lines: ShopifyTaxLine[];
}

export interface ShopifyTaxLine {
  title: string;
  price: string;
  rate: number;
}

export interface ShopifyDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface ShopifyCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  tags: string;
}

export interface ShopifyRefund {
  id: number;
  created_at: string;
  refund_line_items: ShopifyRefundLineItem[];
  transactions: ShopifyTransaction[];
}

export interface ShopifyRefundLineItem {
  id: number;
  quantity: number;
  line_item_id: number;
  line_item: ShopifyLineItem;
  subtotal: string;
  total_tax: string;
}

export interface ShopifyTransaction {
  id: number;
  kind: string;
  gateway: string;
  status: string;
  amount: string;
  /** Presentment / payment currency for the transaction (e.g. "USD", "HKD"). */
  currency?: string;
  /**
   * Gateway receipt payload. For Stripe-backed refunds, `balance_transaction.exchange_rate`
   * carries the authoritative FX rate actually applied to the refund.
   */
  receipt?: {
    balance_transaction?: {
      exchange_rate?: number | string;
    } | null;
  } | null;
}

export interface ShopifyRefundPayload {
  id: number;
  order_id: number;
  created_at: string;
  refund_line_items: ShopifyRefundLineItem[];
  transactions: ShopifyTransaction[];
}

export interface GpsFulfilmentPayload {
  orderId: string;
  orderNumber: string;
  trackingNumber: string;
  carrierCode: string;
  shippedDate: string;
  items: {
    sku: string;
    quantity: number;
  }[];
}

export interface StordFulfilmentPayload {
  orderId: string;
  orderNumber: string;
  trackingNumber: string;
  carrier: string;
  shippedAt: string;
  lineItems: {
    sku: string;
    quantity: number;
  }[];
}

export interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status: string;
  created_at: string;
  updated_at: string;
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_numbers: string[];
  tracking_url: string | null;
  tracking_urls: string[];
  location_id: number | null;
  line_items: ShopifyFulfillmentLineItem[];
}

export interface ShopifyFulfillmentLineItem {
  id: number;
  variant_id: number;
  title: string;
  quantity: number;
  sku: string;
  name: string;
  price: string;
  fulfillment_status: string;
}

export enum CancelReasonEnum {
  customer = "The customer canceled the order",
  fraud = "The order was fraudulent",
  inventory = "Items in the order were not in inventory",
  declined = "The payment was declined",
  other = "Other reason",
}

// ============================================================================
// PRODUCT & INVENTORY PAYLOAD TYPES
// ============================================================================

export interface ShopifyProductPayload {
  id: number;
  title: string;
  body_html: string | null;
  vendor: string;
  product_type: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  status: string;
  tags: string;
  handle: string;
  variants: ShopifyVariantPayload[];
  images: { id: number; src: string; position: number }[];
}

export interface ShopifyVariantPayload {
  id: number;
  product_id: number;
  title: string;
  price: string;
  sku: string;
  position: number;
  inventory_item_id: number;
  inventory_quantity: number;
  weight: number;
  weight_unit: string;
  barcode: string | null;
  requires_shipping: boolean;
  taxable: boolean;
}

export interface ShopifyInventoryLevelPayload {
  inventory_item_id: number;
  location_id: number;
  available: number | null;
  updated_at: string;
}
