/** 后台审计日志模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '@/common/database/prisma.service';

import {
  buildAdminLogEventView,
  collectAdminLogTargetUserIds,
  matchesAdminLogKeyword,
} from './admin-log-event.util';
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

type AdminAuditLogRow = Prisma.AdminAuditLogGetPayload<{
  include: {
    user: {
      select: {
        id: true;
        username: true;
        displayName: true;
      };
    };
  };
}>;

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class AdminLogsService {
  constructor(private readonly prisma: PrismaService) {}

  private buildBaseWhere(query: ListAdminLogsQueryDto, scope: { userId: number; includeAll: boolean }): Prisma.AdminAuditLogWhereInput {
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

    return where;
  }

  private async loadTargetUserLabels(rows: AdminAuditLogRow[]): Promise<Map<number, string>> {
    const targetIds = collectAdminLogTargetUserIds(rows.map(row => row.path));
    if (targetIds.length === 0) {
      return new Map<number, string>();
    }

    const users = await this.prisma.adminUser.findMany({
      where: {
        id: { in: targetIds },
      },
      select: {
        id: true,
        username: true,
        displayName: true,
      },
    });

    return new Map(
      users.map((user) => [
        user.id,
        user.displayName?.trim() || user.username,
      ]),
    );
  }

  private async buildEventRows(rows: AdminAuditLogRow[]) {
    const targetUserLabels = await this.loadTargetUserLabels(rows);

    return rows.map((row) => {
      const queryMasked = parseMaybeJson(row.queryMaskedJson);
      const bodyMasked = parseMaybeJson(row.bodyMaskedJson);
      const responseMasked = parseMaybeJson(row.responseMaskedJson);
      const event = buildAdminLogEventView({
        userId: row.userId,
        usernameSnapshot: row.usernameSnapshot,
        method: row.method,
        path: row.path,
        moduleCode: row.moduleCode,
        action: row.action,
        success: row.success,
        queryMasked,
        bodyMasked,
        responseMasked,
        user: row.user,
      }, {
        adminUserLabels: targetUserLabels,
      });

      return {
        row,
        queryMasked,
        bodyMasked,
        responseMasked,
        event,
      };
    });
  }

  async list(query: ListAdminLogsQueryDto, scope: { userId: number; includeAll: boolean }): Promise<Record<string, unknown>> {
    const page = Number.isFinite(query.page) ? Math.max(1, Number(query.page)) : 1;
    const limit = Number.isFinite(query.limit) ? Math.min(Math.max(1, Number(query.limit)), 200) : 20;
    const keyword = String(query.keyword ?? '').trim();
    const where = this.buildBaseWhere(query, scope);

    let total = 0;
    let eventRows: Awaited<ReturnType<AdminLogsService['buildEventRows']>> = [];

    if (keyword) {
      const allRows = await this.prisma.adminAuditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

      const enrichedRows = await this.buildEventRows(allRows);
      const filteredRows = enrichedRows.filter(item => matchesAdminLogKeyword(item.event, keyword, item.row.path));
      total = filteredRows.length;
      eventRows = filteredRows.slice((page - 1) * limit, page * limit);
    } else {
      const [count, rows] = await this.prisma.$transaction([
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

      total = count;
      eventRows = await this.buildEventRows(rows);
    }

    return {
      total,
      page,
      limit,
      items: eventRows.map(({ row, event }) => ({
        id: row.id,
        request_id: row.requestId,
        user_id: row.userId,
        username: event.username,
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
        event_type: event.eventType,
        event_summary: event.eventSummary,
        module_label: event.moduleLabel,
        result_label: event.resultLabel,
        target_label: event.targetLabel,
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

    const [eventRow] = await this.buildEventRows([row]);

    return {
      id: row.id,
      request_id: row.requestId,
      user_id: row.userId,
      username: eventRow.event.username,
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
      query_masked: eventRow.queryMasked,
      body_masked: eventRow.bodyMasked,
      response_masked: eventRow.responseMasked,
      error_code: row.errorCode,
      created_at: row.createdAt.toISOString(),
      event_type: eventRow.event.eventType,
      event_summary: eventRow.event.eventSummary,
      module_label: eventRow.event.moduleLabel,
      result_label: eventRow.event.resultLabel,
      target_label: eventRow.event.targetLabel,
    };
  }
}
