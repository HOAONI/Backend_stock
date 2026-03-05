export const RBAC_MODULE_CODES = [
  'analysis',
  'history',
  'stocks',
  'backtest',
  'system_config',
  'user_settings',
  'broker_account',
  'trading_account',
  'admin_user',
  'admin_role',
  'admin_log',
  'auth',
] as const;

export type RbacModuleCode = (typeof RBAC_MODULE_CODES)[number];
export type RbacAction = 'read' | 'write';

export interface ModulePermission {
  canRead: boolean;
  canWrite: boolean;
}

export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function resolveRbacAction(method: string): RbacAction {
  return READ_METHODS.has(String(method ?? '').toUpperCase()) ? 'read' : 'write';
}

export function resolveModuleCode(pathname: string): RbacModuleCode | null {
  const path = String(pathname ?? '');
  if (!path.startsWith('/api/v1/')) {
    return null;
  }

  if (path.startsWith('/api/v1/analysis')) return 'analysis';
  if (path.startsWith('/api/v1/history')) return 'history';
  if (path.startsWith('/api/v1/stocks')) return 'stocks';
  if (path.startsWith('/api/v1/backtest')) return 'backtest';
  if (path.startsWith('/api/v1/system')) return 'system_config';
  if (path.startsWith('/api/v1/users/me/settings')) return 'user_settings';
  if (path.startsWith('/api/v1/users/me/simulation-account')) return 'broker_account';
  if (path.startsWith('/api/v1/users/me/trading')) return 'trading_account';
  if (path.startsWith('/api/v1/admin/users')) return 'admin_user';
  if (path.startsWith('/api/v1/admin/roles')) return 'admin_role';
  if (path.startsWith('/api/v1/admin/logs')) return 'admin_log';
  if (path.startsWith('/api/v1/auth')) return 'auth';

  return null;
}

export const BUILTIN_ROLE_CODES = {
  superAdmin: 'super_admin',
  analyst: 'analyst',
  operator: 'operator',
} as const;

export const BUILTIN_ROLE_PERMISSIONS: Record<string, Partial<Record<RbacModuleCode, ModulePermission>>> = {
  [BUILTIN_ROLE_CODES.superAdmin]: Object.fromEntries(
    RBAC_MODULE_CODES.map((moduleCode) => [moduleCode, { canRead: true, canWrite: true }]),
  ) as Partial<Record<RbacModuleCode, ModulePermission>>,
  [BUILTIN_ROLE_CODES.analyst]: {
    analysis: { canRead: true, canWrite: true },
    backtest: { canRead: true, canWrite: true },
    history: { canRead: true, canWrite: false },
    stocks: { canRead: true, canWrite: false },
    user_settings: { canRead: true, canWrite: true },
    broker_account: { canRead: true, canWrite: true },
    trading_account: { canRead: true, canWrite: true },
    admin_log: { canRead: true, canWrite: false },
    auth: { canRead: true, canWrite: true },
  },
  [BUILTIN_ROLE_CODES.operator]: {
    system_config: { canRead: true, canWrite: true },
    user_settings: { canRead: true, canWrite: true },
    broker_account: { canRead: true, canWrite: true },
    trading_account: { canRead: true, canWrite: true },
    analysis: { canRead: true, canWrite: false },
    history: { canRead: true, canWrite: false },
    stocks: { canRead: true, canWrite: false },
    backtest: { canRead: true, canWrite: false },
    admin_log: { canRead: true, canWrite: false },
    auth: { canRead: true, canWrite: true },
  },
};

export function normalizeRoleCode(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeUsername(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}
