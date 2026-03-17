/** 认证与审计基础设施使用的共享类型约定。 */

import { ModulePermission, RbacModuleCode } from './rbac.constants';

export interface AuthenticatedUserContext {
  id: number;
  username: string;
  displayName: string | null;
  roleCodes: string[];
  permissions: Partial<Record<RbacModuleCode, ModulePermission>>;
}

export interface CurrentUserPayload {
  id: number;
  username: string;
  displayName: string | null;
  role: string | null;
  roles: string[];
}
