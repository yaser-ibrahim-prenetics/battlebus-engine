BEGIN;

ALTER TABLE public.users DROP COLUMN department;

COMMIT;
