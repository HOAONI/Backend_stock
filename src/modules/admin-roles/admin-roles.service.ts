import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BUILTIN_ROLE_CODES, normalizeRoleCode, RBAC_MODULE_CODES, RbacModuleCode } from '@/common/auth/rbac.constants';
import { PrismaService } from '@/common/database/prisma.service';

import {
  CreateAdminRoleDto,
  ListAdminRolesQueryDto,
  RolePermissionItemDto,
  UpdateAdminRoleDto,
} from './admin-roles.dto';

interface ServiceError extends Error {
  code?: string;
}

function createServiceError(code: string, message: string): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  return error;
}

type RoleWithPermissions = Prisma.AdminRoleGetPayload<{
  include: {
    permissions: true;
  };
}>;

@Injectable()
export class AdminRolesService {
  constructor(private readonly prisma: PrismaService) {}

  private mapRole(row: RoleWithPermissions, assignedUserCount: number): Record<string, unknown> {
    return {
      id: row.id,
      role_code: row.roleCode,
      role_name: row.roleName,
      description: row.description,
      is_builtin: row.isBuiltin,
      permissions: row.permissions
        .sort((a, b) => a.moduleCode.localeCompare(b.moduleCode))
        .map((item) => ({
          module_code: item.moduleCode,
          can_read: item.canRead,
          can_write: item.canWrite,
        })),
      assigned_user_count: assignedUserCount,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private normalizePermissions(items: RolePermissionItemDto[]): Array<{ moduleCode: string; canRead: boolean; canWrite: boolean }> {
    const allowed = new Set<string>(RBAC_MODULE_CODES);
    const aggregated = new Map<string, { canRead: boolean; canWrite: boolean }>();

    for (const item of items) {
      const moduleCode = String(item.module_code ?? '').trim() as RbacModuleCode;
      if (!allowed.has(moduleCode)) {
        throw createServiceError('VALIDATION_ERROR', `无效模块: ${moduleCode}`);
      }

      const previous = aggregated.get(moduleCode) ?? { canRead: false, canWrite: false };
      const canWrite = previous.canWrite || Boolean(item.can_write);
      const canRead = previous.canRead || Boolean(item.can_read) || canWrite;
      aggregated.set(moduleCode, { canRead, canWrite });
    }

    if (aggregated.size === 0) {
      throw createServiceError('VALIDATION_ERROR', '至少配置一个权限模块');
    }

    return Array.from(aggregated.entries()).map(([moduleCode, permission]) => ({
      moduleCode,
      canRead: permission.canRead,
      canWrite: permission.canWrite,
    }));
  }

  private async loadRoleOrThrow(id: number): Promise<RoleWithPermissions> {
    const row = await this.prisma.adminRole.findUnique({
      where: { id },
      include: {
        permissions: true,
      },
    });

    if (!row || row.isDeleted) {
      throw createServiceError('NOT_FOUND', `角色 ${id} 不存在`);
    }

    return row;
  }

  private async countAssignedUsers(roleId: number): Promise<number> {
    return await this.prisma.adminUserRole.count({
      where: {
        roleId,
        user: {
          isDeleted: false,
        },
      },
    });
  }

  async list(query: ListAdminRolesQueryDto): Promise<Record<string, unknown>> {
    const page = Number.isFinite(query.page) ? Math.max(1, Number(query.page)) : 1;
    const limit = Number.isFinite(query.limit) ? Math.min(Math.max(1, Number(query.limit)), 200) : 20;

    const where: Prisma.AdminRoleWhereInput = {
      isDeleted: false,
    };

    const keyword = String(query.keyword ?? '').trim();
    if (keyword) {
      where.OR = [
        { roleCode: { contains: keyword, mode: 'insensitive' } },
        { roleName: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.adminRole.count({ where }),
      this.prisma.adminRole.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          permissions: true,
        },
      }),
    ]);

    const roleIds = rows.map((item) => item.id);
    const assignments = roleIds.length
      ? await this.prisma.adminUserRole.findMany({
          where: {
            roleId: { in: roleIds },
            user: { isDeleted: false },
          },
          select: { roleId: true },
        })
      : [];
    const countMap = new Map<number, number>();
    for (const item of assignments) {
      countMap.set(item.roleId, (countMap.get(item.roleId) ?? 0) + 1);
    }

    return {
      total,
      page,
      limit,
      items: rows.map((row) => this.mapRole(row as RoleWithPermissions, countMap.get(row.id) ?? 0)),
    };
  }

  async detail(id: number): Promise<Record<string, unknown>> {
    const row = await this.loadRoleOrThrow(id);
    const assignedUserCount = await this.countAssignedUsers(id);
    return this.mapRole(row, assignedUserCount);
  }

  async create(input: CreateAdminRoleDto): Promise<Record<string, unknown>> {
    const roleCode = normalizeRoleCode(input.role_code);
    if (!roleCode) {
      throw createServiceError('VALIDATION_ERROR', '角色编码不能为空');
    }

    const existing = await this.prisma.adminRole.findUnique({ where: { roleCode } });
    if (existing && !existing.isDeleted) {
      throw createServiceError('CONFLICT', `角色编码 ${roleCode} 已存在`);
    }
    if (existing && existing.isDeleted) {
      throw createServiceError('CONFLICT', `角色编码 ${roleCode} 已被历史记录占用`);
    }

    const permissions = this.normalizePermissions(input.permissions);

    const row = await this.prisma.$transaction(async (tx) => {
      const role = await tx.adminRole.create({
        data: {
          roleCode,
          roleName: input.role_name.trim(),
          description: input.description?.trim() || null,
          isBuiltin: false,
          isDeleted: false,
        },
      });

      await tx.adminRolePermission.createMany({
        data: permissions.map((item) => ({
          roleId: role.id,
          moduleCode: item.moduleCode,
          canRead: item.canRead,
          canWrite: item.canWrite,
        })),
      });

      return tx.adminRole.findUniqueOrThrow({
        where: { id: role.id },
        include: {
          permissions: true,
        },
      });
    });

    return this.mapRole(row as RoleWithPermissions, 0);
  }

  async update(id: number, input: UpdateAdminRoleDto): Promise<Record<string, unknown>> {
    const role = await this.loadRoleOrThrow(id);

    if (role.roleCode === BUILTIN_ROLE_CODES.superAdmin && input.role_code) {
      throw createServiceError('FORBIDDEN', 'super_admin 角色编码不允许修改');
    }

    const nextRoleCode = input.role_code != null ? normalizeRoleCode(input.role_code) : role.roleCode;
    if (!nextRoleCode) {
      throw createServiceError('VALIDATION_ERROR', '角色编码不能为空');
    }

    if (nextRoleCode !== role.roleCode) {
      const existing = await this.prisma.adminRole.findUnique({ where: { roleCode: nextRoleCode } });
      if (existing && !existing.isDeleted && existing.id !== id) {
        throw createServiceError('CONFLICT', `角色编码 ${nextRoleCode} 已存在`);
      }
    }

    const permissions = input.permissions ? this.normalizePermissions(input.permissions) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.adminRole.update({
        where: { id },
        data: {
          roleCode: nextRoleCode,
          roleName: input.role_name == null ? undefined : input.role_name.trim(),
          description: input.description == null ? undefined : (input.description.trim() || null),
        },
      });

      if (permissions) {
        await tx.adminRolePermission.deleteMany({ where: { roleId: id } });
        await tx.adminRolePermission.createMany({
          data: permissions.map((item) => ({
            roleId: id,
            moduleCode: item.moduleCode,
            canRead: item.canRead,
            canWrite: item.canWrite,
          })),
        });
      }

      return tx.adminRole.findUniqueOrThrow({
        where: { id },
        include: {
          permissions: true,
        },
      });
    });

    const assignedUserCount = await this.countAssignedUsers(id);
    return this.mapRole(updated as RoleWithPermissions, assignedUserCount);
  }

  async softDelete(id: number): Promise<Record<string, unknown>> {
    const role = await this.loadRoleOrThrow(id);

    if (role.roleCode === BUILTIN_ROLE_CODES.superAdmin) {
      throw createServiceError('FORBIDDEN', 'super_admin 角色禁止删除');
    }

    const assignedUserCount = await this.countAssignedUsers(id);
    if (assignedUserCount > 0) {
      throw createServiceError('CONFLICT', '该角色仍被用户使用，无法删除');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.adminRole.update({
        where: { id },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      });

      await tx.adminRolePermission.deleteMany({ where: { roleId: id } });
      await tx.adminUserRole.deleteMany({ where: { roleId: id } });
    });

    return { ok: true };
  }
}
