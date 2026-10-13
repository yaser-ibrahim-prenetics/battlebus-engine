import { quoteIdentifier } from "@/lib/db/database";

export function buildUpsertOrderLinesQuery(columns: string[], rowCount: number): string {
  const tuples = Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * columns.length;
    return `(${columns.map((__, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  });
  const updates = columns
    .filter((column) => !["shopify_order_id", "shopify_line_item_id"].includes(column))
    .map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`)
    .join(", ");

  return `INSERT INTO public.order_lines (${columns.map(quoteIdentifier).join(", ")})
     VALUES ${tuples.join(", ")}
     ON CONFLICT (shopify_order_id, shopify_line_item_id)
     DO UPDATE SET ${updates}`;
}

export const orderLineQueries = {
  updateLotId: `UPDATE public.order_lines SET dynamics_inventory_lot_id = $3
       WHERE shopify_order_id = $1 AND shopify_line_item_id = $2`,

  findByOrderName: `SELECT * FROM public.order_lines WHERE shopify_order_name = ANY($1::text[])`,

  findByOrderId: `SELECT * FROM public.order_lines WHERE shopify_order_id = $1`,

  markServiceLinesFulfilled: `UPDATE public.order_lines
       SET is_fulfilled_to_dynamics = true, fulfilled_at = now()
       WHERE shopify_order_id = $1 AND shopify_line_item_id = ANY($2::text[])`,
} as const;
