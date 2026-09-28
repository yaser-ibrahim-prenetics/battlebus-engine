\if :{?admin_email}
\else
  \echo 'admin_email psql variable is required'
  \quit 1
\endif

BEGIN;

INSERT INTO public.users (email, role_id, status)
SELECT lower(:'admin_email'), r.id, 'active'
FROM public.roles AS r
WHERE r.name = 'superadmin'
ON CONFLICT (email) DO UPDATE
SET role_id = EXCLUDED.role_id,
    status = 'active',
    updated_at = now();

INSERT INTO public.workspace_members (workspace_id, user_id, role_id, status)
SELECT w.id, u.id, r.id, 'active'
FROM public.workspaces AS w
JOIN public.users AS u ON lower(u.email) = lower(:'admin_email')
JOIN public.roles AS r ON r.name = 'superadmin'
WHERE w.slug = 'battle-hub'
ON CONFLICT (workspace_id, user_id) DO UPDATE
SET role_id = EXCLUDED.role_id,
    status = 'active',
    updated_at = now();

COMMIT;

SELECT u.id, u.email, r.name AS role, wm.status AS workspace_status
FROM public.users AS u
JOIN public.roles AS r ON r.id = u.role_id
JOIN public.workspace_members AS wm ON wm.user_id = u.id
JOIN public.workspaces AS w ON w.id = wm.workspace_id
WHERE lower(u.email) = lower(:'admin_email')
  AND w.slug = 'battle-hub';
