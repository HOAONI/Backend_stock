/** 后台认证模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { COOKIE_NAME } from '@/common/auth/auth.constants';
import {
  getClientIp,
  getSessionMaxAgeSeconds,
  isAuthEnabled,
  signSessionPayload,
  verifySessionCookie,
} from '@/common/auth/auth.utils';

import { AuthService } from './auth.service';
import { ChangePasswordRequestDto, LoginRequestDto, RegisterRequestDto } from './auth.dto';

/** 负责定义该领域的 HTTP 接口边界，把鉴权后的请求参数整理成服务层可消费的输入。 */
@Controller('/api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // 状态接口要兼容“认证未启用”和“认证已启用但未登录”两种场景，方便前端首屏判断分支。
  @Get('/status')
  async status(@Req() req: Request): Promise<Record<string, unknown>> {
    const authEnabled = isAuthEnabled();
    if (!authEnabled) {
      return {
        authEnabled: false,
        loggedIn: false,
        passwordSet: false,
        passwordChangeable: false,
        currentUser: null,
      };
    }

    await this.authService.ensureSeeded();

    const cookieValue = String(req.cookies?.[COOKIE_NAME] ?? '');
    const resolved = await this.authService.resolveUserFromCookie(cookieValue);
    const currentUser = resolved?.user ? this.authService.toCurrentUserPayload(resolved.user) : null;

    return {
      authEnabled,
      loggedIn: Boolean(resolved?.user),
      passwordSet: await this.authService.isAnyLoginableAdmin(),
      passwordChangeable: authEnabled,
      currentUser,
    };
  }

  // 登录成功后立即写入服务端 session，并把签名后的 sessionId 放进 HttpOnly Cookie。
  @Post('/login')
  async login(@Req() req: Request, @Res() res: Response, @Body() body: LoginRequestDto): Promise<void> {
    if (!isAuthEnabled()) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'auth_disabled',
        message: 'Authentication is not configured',
      });
      return;
    }

    await this.authService.ensureSeeded();

    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '').trim();

    if (!username || !password) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'invalid_request',
        message: '用户名和密码不能为空',
      });
      return;
    }

    const ip = getClientIp(req);
    const allowed = await this.authService.checkRateLimit(ip, username);
    if (!allowed) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({
        error: 'rate_limited',
        message: 'Too many failed attempts. Please try again later.',
      });
      return;
    }

    const user = await this.authService.authenticate(username, password);
    if (!user) {
      await this.authService.recordFailure(ip, username);
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: 'invalid_credentials',
        message: '用户名或密码错误',
      });
      return;
    }

    await this.authService.clearRateLimit(ip, username);
    await this.authService.cleanupExpiredSessions();

    const maxAge = getSessionMaxAgeSeconds();
    const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 255);
    const { sessionId, expiresAt } = await this.authService.createSession({
      userId: user.id,
      maxAgeSeconds: maxAge,
      ip,
      userAgent,
    });
    const cookieValue = signSessionPayload(sessionId, Math.floor(expiresAt.getTime() / 1000));

    // 反向代理场景下要优先信任 x-forwarded-proto，否则 HTTPS 下 cookie secure 会误判。
    const secure = (process.env.TRUST_X_FORWARDED_FOR ?? 'false').toLowerCase() === 'true'
      ? String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https'
      : req.protocol === 'https';

    res.cookie(COOKIE_NAME, cookieValue, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: maxAge * 1000,
    });

    res.status(HttpStatus.OK).json({
      ok: true,
      currentUser: this.authService.toCurrentUserPayload(user),
    });
  }

  // 自注册成功后沿用登录流程直接发放 session，减少新用户还要再登录一次的摩擦。
  @Post('/register')
  async register(@Req() req: Request, @Res() res: Response, @Body() body: RegisterRequestDto): Promise<void> {
    if (!isAuthEnabled()) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'auth_disabled',
        message: 'Authentication is not configured',
      });
      return;
    }

    if (!this.authService.selfRegisterEnabled()) {
      res.status(HttpStatus.NOT_FOUND).json({
        error: 'not_found',
        message: 'Self register is disabled',
      });
      return;
    }

    await this.authService.ensureSeeded();

    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '').trim();
    const confirmPassword = String(body.confirmPassword ?? '').trim();
    const accountType = body.accountType === 'admin' ? 'admin' : 'user';
    if (!username || !password) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'invalid_request',
        message: '用户名和密码不能为空',
      });
      return;
    }
    if (password !== confirmPassword) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'password_mismatch',
        message: '两次输入的密码不一致',
      });
      return;
    }
    if (accountType === 'admin' && !this.authService.validateAdminRegisterSecret(body.adminSecret)) {
      res.status(HttpStatus.FORBIDDEN).json({
        error: 'invalid_admin_secret',
        message: '管理员专属密钥错误',
      });
      return;
    }

    let user;
    try {
      user = await this.authService.registerSelfUser({
        username,
        password,
        displayName: body.displayName,
        accountType,
      });
    } catch (error: unknown) {
      const err = error as Error & { code?: string };
      if (err.code === 'VALIDATION_ERROR') {
        res.status(HttpStatus.BAD_REQUEST).json({ error: 'validation_error', message: err.message });
        return;
      }
      if (err.code === 'CONFLICT') {
        res.status(HttpStatus.CONFLICT).json({ error: 'conflict', message: err.message });
        return;
      }

      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'internal_error', message: err.message || '注册失败' });
      return;
    }

    await this.authService.cleanupExpiredSessions();
    const ip = getClientIp(req);
    const maxAge = getSessionMaxAgeSeconds();
    const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 255);
    const { sessionId, expiresAt } = await this.authService.createSession({
      userId: user.id,
      maxAgeSeconds: maxAge,
      ip,
      userAgent,
    });
    const cookieValue = signSessionPayload(sessionId, Math.floor(expiresAt.getTime() / 1000));

    const secure = (process.env.TRUST_X_FORWARDED_FOR ?? 'false').toLowerCase() === 'true'
      ? String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https'
      : req.protocol === 'https';

    res.cookie(COOKIE_NAME, cookieValue, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: maxAge * 1000,
    });

    res.status(HttpStatus.CREATED).json({
      ok: true,
      currentUser: this.authService.toCurrentUserPayload(user),
    });
  }

  // 改密接口要求当前会话仍然有效，防止前端拿旧页面直接绕过重新登录流程。
  @Post('/change-password')
  async changePassword(@Body() body: ChangePasswordRequestDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    if (!isAuthEnabled()) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'not_changeable',
        message: 'Password cannot be changed via web',
      });
      return;
    }

    if (String(body.newPassword) !== String(body.newPasswordConfirm)) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'password_mismatch',
        message: '两次输入的新密码不一致',
      });
      return;
    }

    const cookieValue = String(req.cookies?.[COOKIE_NAME] ?? '');
    const resolved = await this.authService.resolveUserFromCookie(cookieValue);
    if (!resolved) {
      res.status(HttpStatus.UNAUTHORIZED).json({
        error: 'unauthorized',
        message: 'Login required',
      });
      return;
    }

    const err = await this.authService.changePassword(resolved.user.id, body.currentPassword, body.newPassword);
    if (err) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: 'invalid_password',
        message: err,
      });
      return;
    }

    await this.authService.touchSession(resolved.sessionId);
    res.status(HttpStatus.NO_CONTENT).send();
  }

  @Post('/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    // 即使 cookie 已过期或被篡改，也要尽量清掉客户端 cookie，避免前端停留在脏状态。
    const cookieValue = String(req.cookies?.[COOKIE_NAME] ?? '');
    const verified = verifySessionCookie(cookieValue);
    if (verified.valid && verified.sessionId) {
      await this.authService.clearSession(verified.sessionId);
    }

    res.clearCookie(COOKIE_NAME, {
      path: '/',
      sameSite: 'lax',
      httpOnly: true,
    });
    res.status(HttpStatus.NO_CONTENT).send();
  }
}
