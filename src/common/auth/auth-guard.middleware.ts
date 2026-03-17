/** 认证与审计基础设施的中间件实现，在请求进入业务层前统一处理上下文。 */

import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { AuthService } from '@/modules/auth/auth.service';
import { COOKIE_NAME } from './auth.constants';
import { isAuthEnabled } from './auth.utils';
import { BUILTIN_ROLE_CODES, resolveModuleCode, resolveRbacAction } from './rbac.constants';

// 这些路径需要绕过鉴权，否则健康检查、登录注册和文档工具都会被中间件提前拦截。
function isExemptPath(pathname: string): boolean {
  const normalized = pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  const exempt = new Set([
    '/api/health',
    '/health',
    '/api/health/live',
    '/api/health/ready',
    '/api/v1/auth/status',
    '/api/v1/auth/login',
    '/api/v1/auth/register',
    '/api/v1/auth/logout',
    '/docs',
    '/redoc',
    '/openapi.json',
  ]);

  return exempt.has(normalized);
}

/** 负责在请求进入控制器前统一补齐上下文、鉴权或审计信息。 */
@Injectable()
export class AuthGuardMiddleware implements NestMiddleware {
  constructor(private readonly authService: AuthService) {}

  private hasPermission(
    user: Request['authUser'],
    moduleCode: ReturnType<typeof resolveModuleCode>,
    action: ReturnType<typeof resolveRbacAction>,
  ): boolean {
    if (!user || !moduleCode) {
      return false;
    }

    // 内置 admin 仍然不能直接操作角色管理，避免 v1 阶段无细粒度保护时误改权限体系。
    if (user.roleCodes.includes(BUILTIN_ROLE_CODES.admin)) {
      return moduleCode !== 'admin_role';
    }

    const modulePermission = user.permissions[moduleCode];
    if (!modulePermission) {
      return false;
    }

    if (action === 'read') {
      return modulePermission.canRead || modulePermission.canWrite;
    }

    return modulePermission.canWrite;
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!isAuthEnabled()) {
      next();
      return;
    }

    const path = req.path;
    if (isExemptPath(path)) {
      next();
      return;
    }

    if (!path.startsWith('/api/v1/')) {
      next();
      return;
    }

    const cookieValue = String(req.cookies?.[COOKIE_NAME] ?? '');
    const resolved = await this.authService.resolveUserFromCookie(cookieValue);
    if (!resolved) {
      res.status(401).json({ error: 'unauthorized', message: 'Login required' });
      return;
    }

    req.authUser = resolved.user;
    // 每次带着有效 cookie 访问时都刷新 lastSeenAt，便于后续做在线态判断和审计追踪。
    await this.authService.touchSession(resolved.sessionId);

    const moduleCode = resolveModuleCode(path);
    if (moduleCode) {
      const action = resolveRbacAction(req.method);
      if (!this.hasPermission(req.authUser, moduleCode, action)) {
        res.status(403).json({ error: 'forbidden', message: 'Insufficient permissions' });
        return;
      }
    }

    next();
  }
}
