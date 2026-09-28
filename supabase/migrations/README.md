# Legacy Supabase migration location

Battle Bus database migrations moved to `db/migrations` in Release 1 and are
run exclusively with `golang-migrate`. Do not add SQL migration files here or
run `supabase db push` for this repository; doing so would create a second,
conflicting migration history.
