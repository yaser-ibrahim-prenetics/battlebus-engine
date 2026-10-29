export const createCommandSQL = `INSERT INTO public.recovery_commands
  (id,request_hash,actor_id,actor_email,reason,operation,parameters) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
  ON CONFLICT(id) DO NOTHING`;
export const readCommandSQL = `SELECT * FROM public.recovery_commands WHERE id=$1`;
export const queuedCommandsSQL = `SELECT id FROM public.recovery_commands WHERE status='queued' ORDER BY created_at LIMIT 20`;
export const recentCommandsSQL = `SELECT id,actor_email,reason,operation,status,result,error_code,created_at,completed_at FROM public.recovery_commands ORDER BY created_at DESC LIMIT 50`;
export const finishCommandSQL = `UPDATE public.recovery_commands SET status=$2,result=$3::jsonb,error_code=$4,completed_at=now()
  WHERE id=$1 AND status='queued' RETURNING id`;
export const replayInboxSQL = `SELECT id,status,dead_lettered_at FROM public.webhook_inbox WHERE id=$1`;
