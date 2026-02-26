import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '@/common/database/prisma.service';
import { getClientIp } from '@/common/auth/auth.utils';
import { resolveModuleCode, resolveRbacAction } from '@/common/auth/rbac.constants';

const SENSITIVE_FIELD_RE = /(password|token|secret|key|cookie|authorization|credential|ticket)/i;
const MAX_JSON_LENGTH = 4096;
const MAX_TEXT_FIELD_LENGTH = 255;

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 15))}...(truncated)`;
}

function summarizeFile(file: Express.Multer.File): Record<string, unknown> {
  return {
    fieldName: file.fieldname,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  };
}

function maskValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null) {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return '[binary]';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, seen));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) {
      return '[circular]';
    }
    seen.add(obj);

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) {
      if (SENSITIVE_FIELD_RE.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = maskValue(item, seen);
      }
    }
    return result;
  }

  if (typeof value === 'string') {
    return truncateText(value, MAX_JSON_LENGTH);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return String(value);
}

function toMaskedJson(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  try {
    const masked = maskValue(value, new WeakSet<object>());
    const serialized = JSON.stringify(masked);
    if (!serialized) {
      return null;
    }
    return truncateText(serialized, MAX_JSON_LENGTH);
  } catch {
    return null;
  }
}

function extractErrorCode(payload: unknown): string | null {
  if (!payload) {
    return null;
  }

  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const code = typeof parsed.error === 'string' ? parsed.error : '';
      return code ? truncateText(code, 64) : null;
    } catch {
      return null;
    }
  }

  if (typeof payload === 'object' && !Array.isArray(payload)) {
    const code = (payload as Record<string, unknown>).error;
    if (typeof code === 'string') {
      return truncateText(code, 64);
    }
  }

  return null;
}

function buildBodySummary(req: Request): Record<string, unknown> | null {
  const body = req.body && typeof req.body === 'object' ? { ...(req.body as Record<string, unknown>) } : null;

  const file = req.file as Express.Multer.File | undefined;
  const files = req.files as
    | Express.Multer.File[]
    | Record<string, Express.Multer.File[]>
    | undefined;

  const summary: Record<string, unknown> = body ? { ...body } : {};

  if (file) {
    summary._file = summarizeFile(file);
  }

  if (Array.isArray(files) && files.length > 0) {
    summary._files = files.map((item) => summarizeFile(item));
  }

  if (files && !Array.isArray(files)) {
    const grouped: Record<string, unknown> = {};
    for (const [key, list] of Object.entries(files)) {
      grouped[key] = Array.isArray(list) ? list.map((item) => summarizeFile(item)) : [];
    }
    summary._files = grouped;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

@Injectable()
export class AuditLogMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!req.path.startsWith('/api/v1/')) {
      next();
      return;
    }

    const startedAt = Date.now();
    const requestId = String(req.headers['x-request-id'] ?? randomUUID()).slice(0, 64);
    res.setHeader('x-request-id', requestId);

    let responsePayload: unknown = undefined;

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      responsePayload = body;
      return originalJson(body);
    }) as Response['json'];

    const originalSend = res.send.bind(res);
    res.send = ((body?: unknown) => {
      if (responsePayload === undefined) {
        responsePayload = body;
      }
      return originalSend(body as never);
    }) as Response['send'];

    res.on('finish', () => {
      const statusCode = res.statusCode;
      const success = statusCode >= 200 && statusCode < 400;

      const user = req.authUser;
      const bodySummary = buildBodySummary(req);

      const data = {
        requestId,
        userId: user?.id ?? null,
        usernameSnapshot: user?.username ?? null,
        method: String(req.method ?? 'GET').toUpperCase().slice(0, 8),
        path: truncateText(String(req.originalUrl || req.path || ''), MAX_TEXT_FIELD_LENGTH),
        moduleCode: resolveModuleCode(req.path),
        action: resolveRbacAction(req.method),
        statusCode,
        success,
        durationMs: Math.max(0, Date.now() - startedAt),
        ip: truncateText(getClientIp(req), 64),
        userAgent: truncateText(String(req.headers['user-agent'] ?? ''), MAX_TEXT_FIELD_LENGTH),
        queryMaskedJson: toMaskedJson(req.query),
        bodyMaskedJson: toMaskedJson(bodySummary),
        responseMaskedJson: toMaskedJson(responsePayload),
        errorCode: extractErrorCode(responsePayload),
      };

      void this.prisma.adminAuditLog.create({ data }).catch(() => {
        // ignore audit log persistence failures
      });
    });

    next();
  }
}
