BEGIN;

ALTER TABLE public.users
  ADD COLUMN department text
  CONSTRAINT users_department_check
  CHECK (department IN (
    'operations', 'customer_support', 'engineering', 'finance',
    'marketing', 'hr', 'other'
  ));

COMMIT;
