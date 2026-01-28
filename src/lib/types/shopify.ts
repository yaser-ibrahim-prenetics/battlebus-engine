export interface IMoneySet {
  amount: string;
  currency_code: string;
}

export interface IPriceSet {
  shop_money: IMoneySet;
  presentment_money: IMoneySet;
}

export interface IAddress {
  first_name: string;
  address1: string;
  phone: string | null;
  city: string;
  zip: string | null;
  province: string;
  country: string;
  last_name: string;
  address2: string | null;
  company: string | null;
  latitude: number;
  longitude: number;
  name: string;
  country_code: string;
  province_code: string;
}

export interface IClientDetails {
  accept_language: string | null;
  browser_height: number | null;
  browser_ip: string;
  browser_width: number | null;
  session_hash: string | null;
  user_agent: string | null;
}

export interface IDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface ITaxLine {
  price: string;
  rate: number;
  title: string;
  price_set: IPriceSet;
}

export interface ILineItem {
  id: number;
  variant_id: number;
  title: string;
  quantity: number;
  sku: string;
  variant_title: string;
  vendor: string;
  fulfillment_service: string;
  product_id: number;
  requires_shipping: boolean;
  taxable: boolean;
  gift_card: boolean;
  name: string;
  variant_inventory_management: string;
  price: string;
  price_set: IPriceSet;
  tax_lines: ITaxLine[];
  total_discount: string;
  total_discount_set: IPriceSet;
}

export interface IShopifyOrder {
  id: number;
  admin_graphql_api_id: string;
  app_id: number | null;
  browser_ip: string;
  buyer_accepts_marketing: boolean;
  cancel_reason: string | null;
  cancelled_at: string | null;
  cart_token: string;
  checkout_id: number;
  checkout_token: string;
  client_details: IClientDetails;
  closed_at: string | null;
  confirmation_number: string | null;
  confirmed: boolean;
  contact_email: string;
  created_at: string;
  currency: string;
  current_subtotal_price: string;
  current_subtotal_price_set: IPriceSet;
  current_total_discounts: string;
  current_total_discounts_set: IPriceSet;
  current_total_price: string;
  current_total_price_set: IPriceSet;
  current_total_tax: string;
  current_total_tax_set: IPriceSet;
  customer_locale: string | null;
  device_id: string | null;
  discount_codes: IDiscountCode[];
  duties_included: boolean;
  email: string;
  estimated_taxes: boolean;
  financial_status: string;
  fulfillment_status: string | null;
  landing_site: string;
  location_id: number | null;
  name: string;
  note: string | null;
  number: number;
  order_number: number;
  order_status_url: string;
  payment_gateway_names: string[];
  phone: string | null;
  presentment_currency: string;
  processed_at: string;
  reference: string | null;
  referring_site: string;
  shipping_address: IAddress;
  billing_address: IAddress;
  line_items: ILineItem[];
  tax_lines: ITaxLine[];
  tags: string;
  note_attributes: any[]; // Can be typed more specifically if structure is known
  total_discounts: string;
  total_discounts_set: IPriceSet;
  total_line_items_price: string;
  total_line_items_price_set: IPriceSet;
  total_price: string;
  total_price_set: IPriceSet;
  total_tax: string;
  total_tax_set: IPriceSet;
  total_weight: number;
  updated_at: string;
}

export interface IFulfillmentOrderDestination {
  id: number;
  address1: string;
  address2: string;
  city: string;
  company: string | null;
  country: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  province: string;
  zip: string | null;
}

export interface IFulfillmentOrderLineItem {
  id: number;
  shop_id: number;
  fulfillment_order_id: number;
  quantity: number;
  line_item_id: number;
  inventory_item_id: number;
  fulfillable_quantity: number;
  variant_id: number;
}

export interface IAssignedLocation {
  address1: string | null;
  address2: string | null;
  city: string | null;
  country_code: string;
  location_id: number;
  name: string;
  phone: string | null;
  province: string | null;
  zip: string | null;
}

export interface IShopifyFulfillmentOrder {
  id: number;
  created_at: string;
  updated_at: string;
  shop_id: number;
  order_id: number;
  assigned_location_id: number;
  request_status: string;
  status: string;
  fulfill_at: string | null;
  fulfill_by: string | null;
  supported_actions: string[];
  destination: IFulfillmentOrderDestination;
  line_items: IFulfillmentOrderLineItem[];
  international_duties: any | null;
  fulfillment_holds: any[];
  delivery_method: any | null;
  assigned_location: IAssignedLocation;
  merchant_requests: any[];
}

export interface IFulfillmentOrdersResponse {
  fulfillment_orders: IShopifyFulfillmentOrder[];
}

// Utility types for specific use cases
export type FulfillmentOrderStatus = 
  | 'open'
  | 'in_progress'
  | 'cancelled'
  | 'incomplete'
  | 'closed'
  | 'scheduled';

export type FulfillmentOrderRequestStatus = 
  | 'unsubmitted'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'cancellation_requested'
  | 'cancellation_accepted'
  | 'cancellation_rejected'
  | 'closed';

export type FulfillmentOrderSupportedAction = 
  | 'create_fulfillment'
  | 'request_fulfillment'
  | 'cancel_fulfillment_order'
  | 'request_cancellation'
  | 'mark_as_open'
  | 'release_hold'
  | 'move'
  | 'external';

// Utility types for specific use cases
export type OrderFinancialStatus = 
  | 'pending'
  | 'authorized'
  | 'partially_paid'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'voided';

export type OrderFulfillmentStatus = 
  | null
  | 'fulfilled'
  | 'partial'
  | 'restocked';
