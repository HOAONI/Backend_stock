import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/common/database/prisma.service';

import { ListAdminLogsQueryDto } from './admin-logs.dto';

interface ServiceError extends Error {
  code?: string;
}

function createServiceError(code: string, message: string): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  return error;
}

function parseMaybeJson(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseDateStart(value: string): Date {
  if (value.length <= 10) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  return new Date(value);
}

function parseDateEnd(value: string): Date {
  if (value.length <= 10) {
    const end = new Date(`${value}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return end;
  }
  return new Date(value);
}

@Injectable()
export class AdminLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAdminLogsQueryDto, scope: { userId: number; includeAll: boolean }): Promise<Record<string, unknown>> {
    const page = Number.isFinite(query.page) ? Math.max(1, Number(query.page)) : 1;
    const limit = Number.isFinite(query.limit) ? Math.min(Math.max(1, Number(query.limit)), 200) : 20;

    const where: Prisma.AdminAuditLogWhereInput = {};

    if (!scope.includeAll) {
      where.userId = scope.userId;
    }

    if (query.user_id != null && Number.isFinite(query.user_id)) {
      if (scope.includeAll) {
        where.userId = Number(query.user_id);
      } else {
        where.userId = scope.userId;
      }
    }

    if (query.module_code) {
      where.moduleCode = String(query.module_code).trim();
    }

    if (query.method) {
      where.method = String(query.method).trim().toUpperCase();
    }

    if (query.status_code != null && Number.isFinite(query.status_code)) {
      where.statusCode = Number(query.status_code);
    }

    if (query.start_date || query.end_date) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (query.start_date) {
        createdAt.gte = parseDateStart(String(query.start_date));
      }
      if (query.end_date) {
        createdAt.lt = parseDateEnd(String(query.end_date));
      }
      where.createdAt = createdAt;
    }

    const keyword = String(query.keyword ?? '').trim();
    if (keyword) {
      where.OR = [
        { usernameSnapshot: { contains: keyword, mode: 'insensitive' } },
        { path: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.adminAuditLog.count({ where }),
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
            },
          },
        },
      }),
    ]);

    return {
      total,
      page,
      limit,
      items: rows.map((row) => ({
        id: row.id,
        request_id: row.requestId,
        user_id: row.userId,
        username: row.user?.username ?? row.usernameSnapshot,
        display_name: row.user?.displayName ?? null,
        method: row.method,
        path: row.path,
        module_code: row.moduleCode,
        action: row.action,
        status_code: row.statusCode,
        success: row.success,
        duration_ms: row.durationMs,
        error_code: row.errorCode,
        created_at: row.createdAt.toISOString(),
      })),
    };
  }

  async detail(id: number, scope: { userId: number; includeAll: boolean }): Promise<Record<string, unknown>> {
    const row = await this.prisma.adminAuditLog.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
          },
        },
      },
    });

    if (!row) {
      throw createServiceError('NOT_FOUND', `日志 ${id} 不存在`);
    }
    if (!scope.includeAll && row.userId !== scope.userId) {
      throw createServiceError('NOT_FOUND', `日志 ${id} 不存在`);
    }

    return {
      id: row.id,
      request_id: row.requestId,
      user_id: row.userId,
      username: row.user?.username ?? row.usernameSnapshot,
      display_name: row.user?.displayName ?? null,
      method: row.method,
      path: row.path,
      module_code: row.moduleCode,
      action: row.action,
      status_code: row.statusCode,
      success: row.success,
      duration_ms: row.durationMs,
      ip: row.ip,
      user_agent: row.userAgent,
      query_masked: parseMaybeJson(row.queryMaskedJson),
      body_masked: parseMaybeJson(row.bodyMaskedJson),
      response_masked: parseMaybeJson(row.responseMaskedJson),
      error_code: row.errorCode,
      created_at: row.createdAt.toISOString(),
    };
  }
}
