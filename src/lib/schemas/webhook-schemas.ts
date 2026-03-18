import { z } from "zod";

// ============================================================================
// SHOPIFY ORDER WEBHOOK
// ============================================================================

export const shopifyOrderWebhookSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    email: z.string().optional().nullable(),
    line_items: z
      .array(
        z.object({
          id: z.number(),
          sku: z.string().optional().nullable(),
          quantity: z.number(),
          price: z.string(),
          title: z.string().optional().nullable(),
        })
      )
      .min(1),
    shipping_address: z
      .object({
        country_code: z.string(),
      })
      .optional()
      .nullable(),
    tags: z.string().optional().nullable(),
    financial_status: z.string().optional().nullable(),
    fulfillment_status: z.string().optional().nullable(),
  })
  .passthrough();

// ============================================================================
// GPS WEBHOOK
// ============================================================================

export const gpsWebhookSchema = z
  .object({
    orderNumber: z.string().optional(),
    orderId: z.union([z.string(), z.number()]).optional(),
    trackingNumber: z.string().optional(),
  })
  .passthrough();

// ============================================================================
// STORD WEBHOOK
// ============================================================================

export const stordWebhookSchema = z
  .object({
    orderId: z.string().optional(),
    id: z.string().optional(),
    trackingNumber: z.string().optional(),
    externalOrderId: z.string().optional(),
  })
  .passthrough();

// ============================================================================
// HUB ORDER WEBHOOK
// ============================================================================

export const hubOrderWebhookSchema = z.object({
  event: z.string(),
  data: z
    .object({
      orderId: z.union([z.string(), z.number()]).optional(),
      shopifyOrderName: z.string().optional(),
      shopifyOrderId: z.union([z.string(), z.number()]).optional(),
    })
    .passthrough(),
});

// ============================================================================
// VALIDATION HELPER
// ============================================================================

export function validateWebhookSchema<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  };
}
