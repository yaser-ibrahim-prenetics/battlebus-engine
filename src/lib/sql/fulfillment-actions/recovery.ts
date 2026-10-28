export const uncertainAttemptsSQL = `SELECT DISTINCT attempt_id FROM public.fulfillment_actions
  WHERE provider='dynamics' AND status IN ('pending','uncertain')
    AND updated_at < now() - interval '5 minutes' AND recovery_context IS NOT NULL
  ORDER BY attempt_id LIMIT $1`;
export const readAttemptSQL = `SELECT action_key, provider, scope, source_order_id, source_line_id,
  action_name, attempt_id, request_hash, recovery_context, status,
  updated_at < now() - interval '5 minutes' AS settled
  FROM public.fulfillment_actions WHERE attempt_id=$1 ORDER BY action_key`;
export const lockAttemptSQL = `${readAttemptSQL} FOR UPDATE`;
export const claimEvidenceSQL = `INSERT INTO public.fulfillment_evidence_claims
  (provider, scope, document_id, attempt_id, evidence) VALUES ($1,$2,$3,$4,$5::jsonb)
  ON CONFLICT (provider,scope,document_id) DO NOTHING RETURNING attempt_id`;
export const resolveAttemptSQL = `UPDATE public.fulfillment_actions
  SET status='succeeded', result=$2::jsonb, error_code=NULL, updated_at=now()
  WHERE attempt_id=$1 AND status IN ('pending','uncertain') RETURNING action_key`;
export const competingAttemptsSQL = `SELECT DISTINCT a.attempt_id FROM public.fulfillment_actions a
  WHERE a.provider=$1 AND a.scope=$2 AND a.source_order_id=$3
    AND a.source_line_id=ANY($4::text[]) AND a.attempt_id<>$5
    AND a.action_name LIKE 'shipment:%' AND a.status IN ('pending','uncertain','succeeded')
    AND NOT EXISTS (SELECT 1 FROM public.fulfillment_evidence_claims e
      WHERE e.attempt_id=a.attempt_id AND e.provider=a.provider AND e.scope=a.scope
        AND e.document_id<>$6)`;
