export const finishActionsSQL = `UPDATE public.fulfillment_actions
  SET status=$3, result=$4::jsonb, error_code=$5, updated_at=now()
  WHERE action_key=ANY($1::text[]) AND attempt_id=$2 AND status='pending'
  RETURNING action_key`;
