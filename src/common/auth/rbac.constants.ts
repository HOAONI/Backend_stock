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

const LEGACY_ROLE_CODE_ALIASES = {
  super_admin: 'admin',
  analyst: 'user',
  operator: 'user',
} as const;

export const BUILTIN_ROLE_CODES = {
  admin: 'admin',
  user: 'user',
} as const;

export const BUILTIN_ROLE_PERMISSIONS: Record<string, Partial<Record<RbacModuleCode, ModulePermission>>> = {
  [BUILTIN_ROLE_CODES.admin]: Object.fromEntries(
    RBAC_MODULE_CODES
      .filter((moduleCode) => moduleCode !== 'admin_role')
      .map((moduleCode) => [moduleCode, { canRead: true, canWrite: true }]),
  ) as Partial<Record<RbacModuleCode, ModulePermission>>,
  [BUILTIN_ROLE_CODES.user]: {
    analysis: { canRead: true, canWrite: true },
    backtest: { canRead: true, canWrite: true },
    history: { canRead: true, canWrite: false },
    stocks: { canRead: true, canWrite: false },
    user_settings: { canRead: true, canWrite: true },
    broker_account: { canRead: true, canWrite: true },
    trading_account: { canRead: true, canWrite: true },
    auth: { canRead: true, canWrite: true },
  },
};

export function normalizeRoleCode(value: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  return LEGACY_ROLE_CODE_ALIASES[normalized as keyof typeof LEGACY_ROLE_CODE_ALIASES] ?? normalized;
}

export function resolveStoredRoleCodes(roleCode: string): string[] {
  const normalized = normalizeRoleCode(roleCode);
  if (!normalized) {
    return [];
  }

  if (normalized === BUILTIN_ROLE_CODES.admin) {
    return ['admin', 'super_admin'];
  }
  if (normalized === BUILTIN_ROLE_CODES.user) {
    return ['user', 'analyst', 'operator'];
  }

  return [normalized];
}

export function resolveBuiltinRoleName(roleCode: string): string | null {
  const normalized = normalizeRoleCode(roleCode);
  if (normalized === BUILTIN_ROLE_CODES.admin) {
    return '管理员';
  }
  if (normalized === BUILTIN_ROLE_CODES.user) {
    return '普通用户';
  }
  return null;
}

export function resolveBuiltinRolePermissions(roleCode: string): Partial<Record<RbacModuleCode, ModulePermission>> | null {
  const normalized = normalizeRoleCode(roleCode);
  return BUILTIN_ROLE_PERMISSIONS[normalized] ?? null;
}

export function normalizeUsername(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}
