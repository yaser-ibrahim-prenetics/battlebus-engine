export const readAliasesSQL = `SELECT action_name FROM public.fulfillment_action_aliases
  WHERE provider=$1 AND scope=$2 AND source_order_id=$3 AND alias_name=ANY($4::text[])`;
export const bindAliasSQL = `INSERT INTO public.fulfillment_action_aliases
  (provider, scope, source_order_id, alias_name, action_name)
  VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`;
