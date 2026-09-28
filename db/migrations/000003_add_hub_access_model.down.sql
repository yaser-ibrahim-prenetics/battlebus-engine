BEGIN;

DROP VIEW IF EXISTS public.workspace_members_with_users;
DROP VIEW IF EXISTS public.users_with_roles;

DROP POLICY IF EXISTS orders_registered_read ON public.orders;
DROP POLICY IF EXISTS orders_registered_insert ON public.orders;
DROP POLICY IF EXISTS orders_registered_update ON public.orders;
DROP POLICY IF EXISTS orders_registered_delete ON public.orders;
DROP POLICY IF EXISTS order_lines_registered_read ON public.order_lines;
DROP POLICY IF EXISTS order_lines_registered_write ON public.order_lines;
DROP POLICY IF EXISTS inventory_registered_read ON public.inventory;
DROP POLICY IF EXISTS inventory_registered_write ON public.inventory;
DROP POLICY IF EXISTS sku_mappings_registered_read ON public.sku_mappings;
DROP POLICY IF EXISTS sku_mappings_registered_write ON public.sku_mappings;
DROP POLICY IF EXISTS sku_mapping_audit_log_registered_read ON public.sku_mapping_audit_log;
DROP POLICY IF EXISTS sku_mapping_audit_log_registered_write ON public.sku_mapping_audit_log;
DROP POLICY IF EXISTS locations_registered_read ON public.locations;
DROP POLICY IF EXISTS locations_registered_write ON public.locations;
DROP POLICY IF EXISTS stocks_registered_read ON public.stocks;
DROP POLICY IF EXISTS stocks_registered_write ON public.stocks;
DROP POLICY IF EXISTS products_registered_read ON public.products;
DROP POLICY IF EXISTS products_registered_write ON public.products;
DROP POLICY IF EXISTS user_preferences_own_row ON public.user_preferences;
DROP POLICY IF EXISTS flow_logs_registered_read ON public.flow_logs;
DROP POLICY IF EXISTS mission_runs_registered_read ON public.mission_runs;
DROP POLICY IF EXISTS roles_registered_read ON public.roles;
DROP POLICY IF EXISTS roles_admin_write ON public.roles;
DROP POLICY IF EXISTS permissions_registered_read ON public.permissions;
DROP POLICY IF EXISTS permissions_admin_write ON public.permissions;
DROP POLICY IF EXISTS users_self_or_admin_read ON public.users;
DROP POLICY IF EXISTS users_admin_insert ON public.users;
DROP POLICY IF EXISTS users_self_or_admin_update ON public.users;
DROP POLICY IF EXISTS users_admin_delete ON public.users;
DROP POLICY IF EXISTS workspaces_member_read ON public.workspaces;
DROP POLICY IF EXISTS workspaces_admin_write ON public.workspaces;
DROP POLICY IF EXISTS workspace_members_self_or_admin_read ON public.workspace_members;
DROP POLICY IF EXISTS workspace_members_admin_write ON public.workspace_members;
DROP POLICY IF EXISTS user_permissions_self_or_admin_read ON public.user_permissions;
DROP POLICY IF EXISTS user_permissions_admin_write ON public.user_permissions;

REVOKE ALL ON
  public.orders,
  public.order_lines,
  public.inventory,
  public.sku_mappings,
  public.sku_mapping_audit_log,
  public.user_preferences,
  public.locations,
  public.stocks,
  public.products,
  public.flow_logs,
  public.mission_runs
FROM authenticated;

DROP TABLE IF EXISTS public.user_permissions;
DROP TABLE IF EXISTS public.workspace_members;
DROP TABLE IF EXISTS public.workspaces;
DROP TABLE IF EXISTS public.users;
DROP TABLE IF EXISTS public.permissions;
DROP TABLE IF EXISTS public.roles;

DROP FUNCTION IF EXISTS public.battle_platform_protect_user_privileges();
DROP FUNCTION IF EXISTS public.battle_platform_has_permission(text, text);
DROP FUNCTION IF EXISTS public.battle_platform_current_user_id();
DROP FUNCTION IF EXISTS public.battle_platform_jwt_claim(text);

COMMIT;
