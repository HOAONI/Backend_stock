/** 认证与审计基础设施中的实现文件，承载该领域的具体逻辑。 */

import * as crypto from 'node:crypto';

import { Request } from 'express';

import { SESSION_MAX_AGE_HOURS_DEFAULT } from './auth.constants';

export function isAuthEnabled(): boolean {
  return (process.env.ADMIN_AUTH_ENABLED ?? 'false').toLowerCase() === 'true';
}

export function getSessionMaxAgeSeconds(): number {
  const parsed = Number(process.env.ADMIN_SESSION_MAX_AGE_HOURS ?? SESSION_MAX_AGE_HOURS_DEFAULT);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SESSION_MAX_AGE_HOURS_DEFAULT * 3600;
  }
  return Math.floor(parsed * 3600);
}

export function getAuthSecret(): string {
  const explicit = process.env.ADMIN_SESSION_SECRET?.trim();
  if (explicit) {
    return explicit;
  }

  const basis = `${process.env.DATABASE_URL ?? 'backend_stock'}::${process.env.HOST ?? 'localhost'}`;
  return crypto.createHash('sha256').update(basis).digest('hex');
}

export function signSessionPayload(sessionId: string, expiresAtUnix: number): string {
  const payload = `${sessionId}.${expiresAtUnix}`;
  const signature = crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

export function parseSessionCookie(cookieValue: string): { sessionId: string; expiresAtUnix: number; signature: string } | null {
  const parts = String(cookieValue ?? '').split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [sessionId, expiresAtRaw, signature] = parts;
  const expiresAtUnix = Number(expiresAtRaw);
  if (!sessionId || !Number.isFinite(expiresAtUnix) || !signature) {
    return null;
  }

  return { sessionId, expiresAtUnix, signature };
}

export function verifySessionCookie(cookieValue: string): { valid: boolean; sessionId?: string } {
  const parsed = parseSessionCookie(cookieValue);
  if (!parsed) {
    return { valid: false };
  }

  const expected = signSessionPayload(parsed.sessionId, parsed.expiresAtUnix).split('.').at(-1);
  if (!expected || parsed.signature.length !== expected.length) {
    return { valid: false };
  }

  if (!crypto.timingSafeEqual(Buffer.from(parsed.signature), Buffer.from(expected))) {
    return { valid: false };
  }

  if (Date.now() > parsed.expiresAtUnix * 1000) {
    return { valid: false };
  }

  return { valid: true, sessionId: parsed.sessionId };
}

export function getClientIp(request: Request): string {
  const trustProxy = (process.env.TRUST_X_FORWARDED_FOR ?? 'false').toLowerCase() === 'true';
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0].trim();
    }
  }

  return request.ip || request.socket.remoteAddress || '127.0.0.1';
}
