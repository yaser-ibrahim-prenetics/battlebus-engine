BEGIN;

CREATE TABLE IF NOT EXISTS public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  action text NOT NULL,
  subject text NOT NULL,
  conditions jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_role_action_subject_unique
    UNIQUE (role_id, action, subject)
);

CREATE TABLE IF NOT EXISTS public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id text UNIQUE,
  email text NOT NULL UNIQUE,
  first_name text,
  last_name text,
  username text,
  avatar_url text,
  role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_status_valid
    CHECK (status IN ('active', 'inactive', 'suspended', 'pending'))
);

CREATE TABLE IF NOT EXISTS public.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  owner_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  icon text NOT NULL DEFAULT 'Command',
  color text NOT NULL DEFAULT '#6366f1',
  plan text NOT NULL DEFAULT 'standard',
  modules jsonb NOT NULL DEFAULT '["dashboard", "settings"]'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_status_valid CHECK (status IN ('active', 'archived')),
  CONSTRAINT workspaces_modules_array CHECK (jsonb_typeof(modules) = 'array')
);

CREATE TABLE IF NOT EXISTS public.workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active',
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_members_status_valid
    CHECK (status IN ('active', 'invited', 'removed')),
  CONSTRAINT workspace_members_workspace_user_unique
    UNIQUE (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.user_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  action text NOT NULL,
  subject text NOT NULL,
  inverted boolean NOT NULL DEFAULT false,
  granted_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reason text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_permissions_user_action_subject_unique
    UNIQUE (user_id, action, subject)
);

CREATE INDEX IF NOT EXISTS idx_roles_name ON public.roles (name);
CREATE INDEX IF NOT EXISTS idx_permissions_role_id
  ON public.permissions (role_id);
CREATE INDEX IF NOT EXISTS idx_permissions_action_subject
  ON public.permissions (action, subject);
CREATE INDEX IF NOT EXISTS idx_users_email_lower
  ON public.users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_auth_id ON public.users (auth_id);
CREATE INDEX IF NOT EXISTS idx_users_role_id ON public.users (role_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON public.users (status);
CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON public.workspaces (slug);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id
  ON public.workspaces (owner_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON public.workspaces (status);
CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id
  ON public.workspace_members (workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id
  ON public.workspace_members (user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_status
  ON public.workspace_members (status);
CREATE INDEX IF NOT EXISTS idx_user_permissions_user_id
  ON public.user_permissions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_expires_at
  ON public.user_permissions (expires_at);

DROP TRIGGER IF EXISTS battle_platform_roles_updated_at ON public.roles;
CREATE TRIGGER battle_platform_roles_updated_at
  BEFORE UPDATE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_permissions_updated_at ON public.permissions;
CREATE TRIGGER battle_platform_permissions_updated_at
  BEFORE UPDATE ON public.permissions
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_users_updated_at ON public.users;
CREATE TRIGGER battle_platform_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_workspaces_updated_at ON public.workspaces;
CREATE TRIGGER battle_platform_workspaces_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

DROP TRIGGER IF EXISTS battle_platform_workspace_members_updated_at ON public.workspace_members;
CREATE TRIGGER battle_platform_workspace_members_updated_at
  BEFORE UPDATE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_set_updated_at();

INSERT INTO public.roles (name, description, is_system)
VALUES
  ('superadmin', 'Full system access', true),
  ('admin', 'User, role, and workspace administration', true),
  ('developer', 'Logs, diagnostics, and testing access', true),
  ('operations', 'Order and inventory operations', true),
  ('cs', 'Customer service order access', true),
  ('viewer', 'Read-only dashboard access', true)
ON CONFLICT (name) DO UPDATE
SET description = EXCLUDED.description,
    is_system = EXCLUDED.is_system;

INSERT INTO public.permissions (role_id, action, subject)
SELECT id, 'manage', 'all' FROM public.roles WHERE name = 'superadmin'
ON CONFLICT DO NOTHING;

INSERT INTO public.permissions (role_id, action, subject)
SELECT r.id, p.action, p.subject
FROM public.roles AS r
CROSS JOIN (
  VALUES
    ('manage', 'users'),
    ('manage', 'roles'),
    ('manage', 'workspaces'),
    ('read', 'orders'),
    ('read', 'inventory'),
    ('read', 'settings')
) AS p(action, subject)
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO public.permissions (role_id, action, subject)
SELECT r.id, p.action, p.subject
FROM public.roles AS r
CROSS JOIN (
  VALUES ('read', 'all'), ('manage', 'testing'), ('manage', 'logs')
) AS p(action, subject)
WHERE r.name = 'developer'
ON CONFLICT DO NOTHING;

INSERT INTO public.permissions (role_id, action, subject)
SELECT r.id, p.action, p.subject
FROM public.roles AS r
CROSS JOIN (
  VALUES ('manage', 'orders'), ('manage', 'inventory'), ('read', 'dashboard')
) AS p(action, subject)
WHERE r.name = 'operations'
ON CONFLICT DO NOTHING;

INSERT INTO public.permissions (role_id, action, subject)
SELECT r.id, p.action, p.subject
FROM public.roles AS r
CROSS JOIN (
  VALUES ('read', 'orders'), ('update', 'orders'), ('read', 'dashboard')
) AS p(action, subject)
WHERE r.name = 'cs'
ON CONFLICT DO NOTHING;

INSERT INTO public.permissions (role_id, action, subject)
SELECT r.id, p.action, p.subject
FROM public.roles AS r
CROSS JOIN (
  VALUES ('read', 'dashboard'), ('read', 'orders')
) AS p(action, subject)
WHERE r.name = 'viewer'
ON CONFLICT DO NOTHING;

INSERT INTO public.workspaces (
  name, slug, description, icon, color, plan, modules, status
)
VALUES (
  'Battle Hub',
  'battle-hub',
  'Battle platform operations workspace',
  'Zap',
  '#f59e0b',
  'enterprise',
  '["dashboard", "orders", "inventory", "sku-management", "testing", "users", "workspaces", "flowLogs", "settings"]'::jsonb,
  'active'
)
ON CONFLICT (slug) DO UPDATE
SET modules = EXCLUDED.modules,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.battle_platform_jwt_claim(claim_name text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    CASE
      WHEN claim_name = 'sub'
        THEN NULLIF(current_setting('request.jwt.claim.sub', true), '')
      WHEN claim_name = 'email'
        THEN NULLIF(current_setting('request.jwt.claim.email', true), '')
      ELSE NULL
    END,
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> claim_name
  );
$$;

CREATE OR REPLACE FUNCTION public.battle_platform_current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id
  FROM public.users AS u
  WHERE u.status = 'active'
    AND (
      u.auth_id = public.battle_platform_jwt_claim('sub')
      OR (
        public.battle_platform_jwt_claim('email') IS NOT NULL
        AND lower(u.email) = lower(public.battle_platform_jwt_claim('email'))
      )
    )
  ORDER BY (u.auth_id = public.battle_platform_jwt_claim('sub')) DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.battle_platform_has_permission(
  requested_action text,
  requested_subject text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH active_user AS (
    SELECT u.id, u.role_id
    FROM public.users AS u
    WHERE u.id = public.battle_platform_current_user_id()
  )
  SELECT (
    EXISTS (
      SELECT 1
      FROM active_user AS au
      JOIN public.permissions AS p ON p.role_id = au.role_id
      WHERE p.action IN (requested_action, 'manage')
        AND p.subject IN (requested_subject, 'all')
    )
    OR EXISTS (
      SELECT 1
      FROM active_user AS au
      JOIN public.user_permissions AS up ON up.user_id = au.id
      WHERE up.inverted = false
        AND (up.expires_at IS NULL OR up.expires_at > now())
        AND up.action IN (requested_action, 'manage')
        AND up.subject IN (requested_subject, 'all')
    )
  )
  AND NOT EXISTS (
      SELECT 1
      FROM active_user AS au
      JOIN public.user_permissions AS up ON up.user_id = au.id
      WHERE up.inverted = true
        AND (up.expires_at IS NULL OR up.expires_at > now())
        AND up.action IN (requested_action, 'manage')
        AND up.subject IN (requested_subject, 'all')
    );
$$;

CREATE OR REPLACE FUNCTION public.battle_platform_protect_user_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.battle_platform_has_permission('manage', 'users') THEN
    RETURN NEW;
  END IF;

  IF NEW.role_id IS DISTINCT FROM OLD.role_id
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.email IS DISTINCT FROM OLD.email
  THEN
    RAISE EXCEPTION 'Only user administrators may change email, role, or status'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.auth_id IS DISTINCT FROM OLD.auth_id
    AND NEW.auth_id IS DISTINCT FROM public.battle_platform_jwt_claim('sub')
  THEN
    RAISE EXCEPTION 'A user may only link their own authenticated identity'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS battle_platform_protect_user_privileges ON public.users;
CREATE TRIGGER battle_platform_protect_user_privileges
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.battle_platform_protect_user_privileges();

REVOKE ALL ON FUNCTION public.battle_platform_jwt_claim(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.battle_platform_current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.battle_platform_has_permission(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.battle_platform_protect_user_privileges() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.battle_platform_jwt_claim(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.battle_platform_current_user_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.battle_platform_has_permission(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.battle_platform_protect_user_privileges()
  TO authenticated, service_role;

CREATE OR REPLACE VIEW public.users_with_roles
WITH (security_invoker = true)
AS
SELECT
  u.id,
  u.auth_id,
  u.email,
  u.first_name,
  u.last_name,
  u.username,
  u.avatar_url,
  u.status,
  u.last_login_at,
  u.created_at,
  u.updated_at,
  r.id AS role_id,
  r.name AS role_name,
  r.description AS role_description,
  COALESCE(
    (
      SELECT jsonb_agg(jsonb_build_object('action', p.action, 'subject', p.subject))
      FROM public.permissions AS p
      WHERE p.role_id = r.id
    ),
    '[]'::jsonb
  ) AS role_permissions,
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'action', up.action,
          'subject', up.subject,
          'inverted', up.inverted
        )
      )
      FROM public.user_permissions AS up
      WHERE up.user_id = u.id
        AND (up.expires_at IS NULL OR up.expires_at > now())
    ),
    '[]'::jsonb
  ) AS adhoc_permissions
FROM public.users AS u
LEFT JOIN public.roles AS r ON r.id = u.role_id;

CREATE OR REPLACE VIEW public.workspace_members_with_users
WITH (security_invoker = true)
AS
SELECT
  wm.id,
  wm.workspace_id,
  wm.user_id,
  wm.role_id,
  wm.status,
  wm.joined_at,
  wm.updated_at,
  u.email AS user_email,
  u.first_name AS user_first_name,
  u.last_name AS user_last_name,
  u.avatar_url AS user_avatar_url,
  r.name AS role_name
FROM public.workspace_members AS wm
JOIN public.users AS u ON u.id = wm.user_id
LEFT JOIN public.roles AS r ON r.id = wm.role_id;

DO $$
DECLARE
  table_name text;
  policy_record record;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'orders', 'order_lines', 'inventory', 'sku_mappings',
    'sku_mapping_audit_log', 'user_preferences', 'locations', 'stocks', 'products',
    'flow_logs', 'webhook_inbox', 'mission_runs', 'audit_entities', 'audit_log',
    'roles', 'permissions', 'users', 'workspaces', 'workspace_members', 'user_permissions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', table_name);

    FOR policy_record IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname <> table_name || '_service_role_all'
    LOOP
      EXECUTE format(
        'DROP POLICY %I ON public.%I',
        policy_record.policyname,
        table_name
      );
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = table_name
        AND policyname = table_name || '_service_role_all'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        table_name || '_service_role_all',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.orders,
  public.order_lines,
  public.inventory,
  public.sku_mappings,
  public.sku_mapping_audit_log,
  public.user_preferences,
  public.locations,
  public.stocks,
  public.products,
  public.roles,
  public.permissions,
  public.users,
  public.workspaces,
  public.workspace_members,
  public.user_permissions
TO authenticated;

GRANT SELECT ON public.flow_logs, public.mission_runs TO authenticated;
GRANT SELECT ON public.users_with_roles, public.workspace_members_with_users TO authenticated;

CREATE POLICY orders_registered_read ON public.orders
  FOR SELECT TO authenticated
  USING (public.battle_platform_has_permission('read', 'orders'));
CREATE POLICY orders_registered_insert ON public.orders
  FOR INSERT TO authenticated
  WITH CHECK (public.battle_platform_has_permission('create', 'orders'));
CREATE POLICY orders_registered_update ON public.orders
  FOR UPDATE TO authenticated
  USING (public.battle_platform_has_permission('update', 'orders'))
  WITH CHECK (public.battle_platform_has_permission('update', 'orders'));
CREATE POLICY orders_registered_delete ON public.orders
  FOR DELETE TO authenticated
  USING (public.battle_platform_has_permission('delete', 'orders'));

CREATE POLICY order_lines_registered_read ON public.order_lines
  FOR SELECT TO authenticated
  USING (public.battle_platform_has_permission('read', 'orders'));
CREATE POLICY order_lines_registered_write ON public.order_lines
  FOR ALL TO authenticated
  USING (public.battle_platform_has_permission('manage', 'orders'))
  WITH CHECK (public.battle_platform_has_permission('manage', 'orders'));

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'inventory', 'sku_mappings', 'sku_mapping_audit_log', 'locations', 'stocks', 'products'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.battle_platform_has_permission(''read'', ''inventory''))',
      table_name || '_registered_read',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.battle_platform_has_permission(''manage'', ''inventory'')) WITH CHECK (public.battle_platform_has_permission(''manage'', ''inventory''))',
      table_name || '_registered_write',
      table_name
    );
  END LOOP;
END
$$;

CREATE POLICY user_preferences_own_row ON public.user_preferences
  FOR ALL TO authenticated
  USING (
    user_id IN (
      public.battle_platform_jwt_claim('sub'),
      public.battle_platform_current_user_id()::text
    )
  )
  WITH CHECK (
    user_id IN (
      public.battle_platform_jwt_claim('sub'),
      public.battle_platform_current_user_id()::text
    )
  );

CREATE POLICY flow_logs_registered_read ON public.flow_logs
  FOR SELECT TO authenticated
  USING (
    public.battle_platform_has_permission('read', 'logs')
    OR public.battle_platform_has_permission('read', 'orders')
  );

CREATE POLICY mission_runs_registered_read ON public.mission_runs
  FOR SELECT TO authenticated
  USING (public.battle_platform_has_permission('read', 'testing'));

CREATE POLICY roles_registered_read ON public.roles
  FOR SELECT TO authenticated
  USING (public.battle_platform_current_user_id() IS NOT NULL);
CREATE POLICY roles_admin_write ON public.roles
  FOR ALL TO authenticated
  USING (public.battle_platform_has_permission('manage', 'roles'))
  WITH CHECK (public.battle_platform_has_permission('manage', 'roles'));

CREATE POLICY permissions_registered_read ON public.permissions
  FOR SELECT TO authenticated
  USING (public.battle_platform_current_user_id() IS NOT NULL);
CREATE POLICY permissions_admin_write ON public.permissions
  FOR ALL TO authenticated
  USING (public.battle_platform_has_permission('manage', 'roles'))
  WITH CHECK (public.battle_platform_has_permission('manage', 'roles'));

CREATE POLICY users_self_or_admin_read ON public.users
  FOR SELECT TO authenticated
  USING (
    id = public.battle_platform_current_user_id()
    OR public.battle_platform_has_permission('manage', 'users')
  );
CREATE POLICY users_admin_insert ON public.users
  FOR INSERT TO authenticated
  WITH CHECK (public.battle_platform_has_permission('manage', 'users'));
CREATE POLICY users_self_or_admin_update ON public.users
  FOR UPDATE TO authenticated
  USING (
    id = public.battle_platform_current_user_id()
    OR public.battle_platform_has_permission('manage', 'users')
  )
  WITH CHECK (
    id = public.battle_platform_current_user_id()
    OR public.battle_platform_has_permission('manage', 'users')
  );
CREATE POLICY users_admin_delete ON public.users
  FOR DELETE TO authenticated
  USING (public.battle_platform_has_permission('manage', 'users'));

CREATE POLICY workspaces_member_read ON public.workspaces
  FOR SELECT TO authenticated
  USING (
    owner_id = public.battle_platform_current_user_id()
    OR EXISTS (
      SELECT 1 FROM public.workspace_members AS wm
      WHERE wm.workspace_id = workspaces.id
        AND wm.user_id = public.battle_platform_current_user_id()
        AND wm.status = 'active'
    )
    OR public.battle_platform_has_permission('manage', 'workspaces')
  );
CREATE POLICY workspaces_admin_write ON public.workspaces
  FOR ALL TO authenticated
  USING (public.battle_platform_has_permission('manage', 'workspaces'))
  WITH CHECK (public.battle_platform_has_permission('manage', 'workspaces'));

CREATE POLICY workspace_members_self_or_admin_read ON public.workspace_members
  FOR SELECT TO authenticated
  USING (
    user_id = public.battle_platform_current_user_id()
    OR public.battle_platform_has_permission('manage', 'workspaces')
  );
CREATE POLICY workspace_members_admin_write ON public.workspace_members
  FOR ALL TO authenticated
  USING (public.battle_platform_has_permission('manage', 'workspaces'))
  WITH CHECK (public.battle_platform_has_permission('manage', 'workspaces'));

CREATE POLICY user_permissions_self_or_admin_read ON public.user_permissions
  FOR SELECT TO authenticated
  USING (
    user_id = public.battle_platform_current_user_id()
    OR public.battle_platform_has_permission('manage', 'users')
  );
CREATE POLICY user_permissions_admin_write ON public.user_permissions
  FOR ALL TO authenticated
  USING (public.battle_platform_has_permission('manage', 'users'))
  WITH CHECK (public.battle_platform_has_permission('manage', 'users'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'users'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'workspaces'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.workspaces;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'workspace_members'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.workspace_members;
    END IF;
  END IF;
END
$$;

COMMIT;
