export const cutoverEvidenceQueries = {
  insert: `INSERT INTO public.cutover_evidence (
    id, case_id, workflow_id, mode, provenance, source_reference, captured_at, input_hash,
    spock_revision, bus_revision, status, differences, spock_hash, bus_hash, started_at, completed_at
  ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::timestamptz,$16::timestamptz)
  ON CONFLICT (id) DO NOTHING`,
  summary: `SELECT workflow_id, mode,
    count(DISTINCT input_hash) FILTER (WHERE status = 'matched'
      AND recorded_at >= now() - CASE WHEN mode = 'shadow' THEN interval '8 days' ELSE interval '24 hours' END)::int AS samples,
    count(*) FILTER (WHERE status <> 'matched')::int AS failures,
    count(DISTINCT input_hash) FILTER (WHERE status = 'matched' AND provenance = 'production'
      AND recorded_at >= now() - CASE WHEN mode = 'shadow' THEN interval '8 days' ELSE interval '24 hours' END)::int AS production_samples,
    count(DISTINCT (recorded_at AT TIME ZONE 'UTC')::date)
      FILTER (WHERE status = 'matched' AND provenance = 'production'
        AND (recorded_at AT TIME ZONE 'UTC')::date >= (now() AT TIME ZONE 'UTC')::date - 7
        AND (recorded_at AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE 'UTC')::date)::int AS shadow_days,
    max(recorded_at)::text AS latest_at
    FROM public.cutover_evidence
    WHERE spock_revision = $1 AND bus_revision = $2
    GROUP BY workflow_id, mode`,
  recent: `SELECT id, workflow_id, mode, provenance, status, differences, input_hash,
    spock_revision, bus_revision, recorded_at
    FROM public.cutover_evidence
    WHERE spock_revision = $1 AND bus_revision = $2
    ORDER BY recorded_at DESC LIMIT 50`,
} as const;

