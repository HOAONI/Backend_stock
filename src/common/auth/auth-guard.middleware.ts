import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { AuthService } from '@/modules/auth/auth.service';
import { COOKIE_NAME } from './auth.constants';
import { isAuthEnabled } from './auth.utils';
import { BUILTIN_ROLE_CODES, resolveModuleCode, resolveRbacAction } from './rbac.constants';

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
