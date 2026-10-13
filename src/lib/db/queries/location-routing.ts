export const locationRoutingQueries = {
  listActive: `SELECT * FROM public.locations WHERE active = true ORDER BY name ASC`,

  findByShopifyLocationId: `SELECT id FROM public.locations WHERE shopify_location_id = $1 LIMIT 1`,

  update: `UPDATE public.locations
         SET name = $2, address_line1 = $3, address_line2 = $4, city = $5,
             province = $6, country = $7, zip = $8, phone = $9, active = $10,
             fulfillment_service_id = $11, updated_at = now()
         WHERE shopify_location_id = $1`,

  insert: `INSERT INTO public.locations (
           id, shopify_location_id, name, warehouse_name, dynamics_data_area_id,
           country_data_area_mapping, address_line1, address_line2, city, province,
           country, zip, phone, active, fulfillment_service_id
         ) VALUES ($1, $1, $2, $3, $4, '[]'::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,

  deactivate: `UPDATE public.locations SET active = false, updated_at = now() WHERE shopify_location_id = $1`,
} as const;
