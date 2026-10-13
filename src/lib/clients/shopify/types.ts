// Types
export interface ShopifyOrder {
  id: number;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  total_refunded?: string;
  currency: string;
  /** Customer-facing checkout currency when it differs from shop `currency`. */
  presentment_currency?: string;
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
  fulfillments?: ShopifyFulfillment[];
  /** Present on many API responses; used for FX / refund rate extraction. */
  transactions?: ShopifyTransaction[];
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
  currency?: string;
  payment_id?: string;
  receipt?: {
    gift_card_last_characters?: string;
    metadata?: {
      order_id?: string;
    };
  };
}

export interface ShopifyFulfillmentOrder {
  id: number;
  order_id: number;
  status: string;
  assigned_location_id: number | null;
  assigned_location?: {
    id: number;
    name: string;
    address1: string;
    city: string;
    province: string;
    country: string;
    zip: string;
  };
  delivery_method?: {
    method_type: string;
  };
  line_items: ShopifyFulfillmentOrderLineItem[];
}

export interface ShopifyFulfillmentOrderLineItem {
  id: number;
  shop_id: number;
  fulfillment_order_id: number;
  quantity: number;
  line_item_id: number;
  inventory_item_id: number;
  fulfillable_quantity: number;
  variant_id: number;
}

export interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status: string;
  tracking_number: string;
  tracking_company: string;
  tracking_url: string;
  receipt?: {
    gift_cards?: Array<{
      line_item_id: number | string;
      masked_code: string;
    }>;
  };
}

export interface ShopifyFraudAnalysis {
  id: number;
  order_id: number;
  checkout_id: number | null;
  source: string;
  score: string;
  recommendation: string;
  display: boolean;
  cause_cancel: boolean;
  message: string;
  merchant_message: string;
}

