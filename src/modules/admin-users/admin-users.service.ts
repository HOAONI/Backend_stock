import { Injectable } from '@nestjs/common';
import { AdminUserStatus, Prisma } from '@prisma/client';

import { AuthService } from '@/modules/auth/auth.service';
import { BUILTIN_ROLE_CODES, normalizeRoleCode, normalizeUsername } from '@/common/auth/rbac.constants';
import { PrismaService } from '@/common/database/prisma.service';

import {
  CreateAdminUserDto,
  ListAdminUsersQueryDto,
  ResetAdminUserPasswordDto,
  UpdateAdminUserDto,
  UpdateAdminUserStatusDto,
} from './admin-users.dto';

type DbClient = PrismaService | Prisma.TransactionClient;

type UserWithRoles = Prisma.AdminUserGetPayload<{
  include: {
    userRoles: {
      include: {
        role: true;
      };
    };
  };
}>;

interface ServiceError extends Error {
  code?: string;
}

function createServiceError(code: string, message: string): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  return error;
}

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  private mapUser(row: UserWithRoles): Record<string, unknown> {
    return {
      id: row.id,
      username: row.username,
      display_name: row.displayName,
      email: row.email,
      status: row.status,
      roles: row.userRoles
        .filter((item) => !item.role.isDeleted)
        .map((item) => ({
          id: item.role.id,
          role_code: item.role.roleCode,
          role_name: item.role.roleName,
          is_builtin: item.role.isBuiltin,
        })),
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      last_login_at: row.lastLoginAt?.toISOString() ?? null,
    };
  }

  private async loadUserOrThrow(id: number, tx: DbClient = this.prisma): Promise<UserWithRoles> {
    const row = await tx.adminUser.findUnique({
      where: { id },
      include: {
        userRoles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!row || row.isDeleted) {
      throw createServiceError('NOT_FOUND', `用户 ${id} 不存在`);
    }

    return row;
  }

  private async resolveRoleIds(roleCodes: string[]): Promise<Array<{ id: number; roleCode: string }>> {
    const normalized = Array.from(new Set(roleCodes.map((item) => normalizeRoleCode(item)).filter(Boolean)));
    if (normalized.length === 0) {
      throw createServiceError('VALIDATION_ERROR', '至少需要一个角色');
    }

    const roles = await this.prisma.adminRole.findMany({
      where: {
        roleCode: { in: normalized },
        isDeleted: false,
      },
      select: {
        id: true,
        roleCode: true,
      },
    });

    const foundCodes = new Set(roles.map((item) => item.roleCode));
    const missing = normalized.filter((code) => !foundCodes.has(code));
    if (missing.length > 0) {
      throw createServiceError('VALIDATION_ERROR', `角色不存在: ${missing.join(', ')}`);
    }

    return roles;
  }

  private async countActiveSuperAdmins(tx: DbClient = this.prisma): Promise<number> {
    return await tx.adminUser.count({
      where: {
        isDeleted: false,
        status: AdminUserStatus.active,
        userRoles: {
          some: {
            role: {
              roleCode: BUILTIN_ROLE_CODES.superAdmin,
              isDeleted: false,
            },
          },
        },
      },
    });
  }

  private async ensureNotLastSuperAdmin(
    user: UserWithRoles,
    options: {
      nextStatus: AdminUserStatus;
      nextIsDeleted: boolean;
      nextRoleCodes?: string[] | null;
    },
    tx: DbClient,
  ): Promise<void> {
    const hasSuperRole = user.userRoles.some(
      (item) => !item.role.isDeleted && item.role.roleCode === BUILTIN_ROLE_CODES.superAdmin,
    );

    if (!hasSuperRole) {
      return;
    }

    const nextRoleCodes = options.nextRoleCodes;
    const willHaveSuperRole = nextRoleCodes
      ? nextRoleCodes.map((item) => normalizeRoleCode(item)).includes(BUILTIN_ROLE_CODES.superAdmin)
      : hasSuperRole;

    const willStayActive = !options.nextIsDeleted && options.nextStatus === AdminUserStatus.active;

    if (willStayActive && willHaveSuperRole) {
      return;
    }

    const activeSuperAdminCount = await this.countActiveSuperAdmins(tx);
    if (activeSuperAdminCount <= 1) {
      throw createServiceError('VALIDATION_ERROR', '不能禁用、删除或降级最后一个 super_admin 用户');
    }
  }

  async list(query: ListAdminUsersQueryDto): Promise<Record<string, unknown>> {
    const page = Number.isFinite(query.page) ? Math.max(1, Number(query.page)) : 1;
    const limit = Number.isFinite(query.limit) ? Math.min(Math.max(1, Number(query.limit)), 200) : 20;

    const where: Prisma.AdminUserWhereInput = {
      isDeleted: false,
    };

    const keyword = String(query.keyword ?? '').trim();
    if (keyword) {
      where.OR = [
        { username: { contains: keyword, mode: 'insensitive' } },
        { displayName: { contains: keyword, mode: 'insensitive' } },
        { email: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    if (query.status) {
      where.status = query.status === 'disabled' ? AdminUserStatus.disabled : AdminUserStatus.active;
    }

    if (query.role_code) {
      const roleCode = normalizeRoleCode(query.role_code);
      where.userRoles = {
        some: {
          role: {
            roleCode,
            isDeleted: false,
          },
        },
      };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.adminUser.count({ where }),
      this.prisma.adminUser.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      }),
    ]);

    return {
      total,
      page,
      limit,
      items: rows.map((row) => this.mapUser(row as UserWithRoles)),
    };
  }

  async detail(id: number): Promise<Record<string, unknown>> {
    const row = await this.loadUserOrThrow(id);
    return this.mapUser(row);
  }

  async create(input: CreateAdminUserDto): Promise<Record<string, unknown>> {
    const username = normalizeUsername(input.username);
    const usernameError = this.authService.validateUsername(username);
    if (usernameError) {
      throw createServiceError('VALIDATION_ERROR', usernameError);
    }

    const existing = await this.prisma.adminUser.findUnique({ where: { username } });
    if (existing && !existing.isDeleted) {
      throw createServiceError('CONFLICT', `用户名 ${username} 已存在`);
    }
    if (existing && existing.isDeleted) {
      throw createServiceError('CONFLICT', `用户名 ${username} 已被历史记录占用`);
    }

    const hashed = await this.authService.hashPassword(input.password);
    if (!hashed.hash) {
      throw createServiceError('VALIDATION_ERROR', hashed.error || '密码格式错误');
    }
    const passwordHash = hashed.hash;

    const roleEntities = await this.resolveRoleIds(input.role_codes);
    const status = input.status === 'disabled' ? AdminUserStatus.disabled : AdminUserStatus.active;

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.adminUser.create({
        data: {
          username,
          passwordHash,
          displayName: input.display_name?.trim() || null,
          email: input.email?.trim() || null,
          status,
          isDeleted: false,
        },
      });

      await tx.adminUserRole.createMany({
        data: roleEntities.map((role) => ({
          userId: user.id,
          roleId: role.id,
        })),
      });

      return tx.adminUser.findUniqueOrThrow({
        where: { id: user.id },
        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });
    });

    return this.mapUser(created as UserWithRoles);
  }

  async update(id: number, input: UpdateAdminUserDto): Promise<Record<string, unknown>> {
    const user = await this.loadUserOrThrow(id);

    const nextStatus = input.status === 'disabled'
      ? AdminUserStatus.disabled
      : input.status === 'active'
        ? AdminUserStatus.active
        : user.status;

    const nextRoleCodes = input.role_codes ? input.role_codes.map((item) => normalizeRoleCode(item)) : null;

    const username = input.username != null ? normalizeUsername(input.username) : null;
    if (username != null) {
      const usernameError = this.authService.validateUsername(username);
      if (usernameError) {
        throw createServiceError('VALIDATION_ERROR', usernameError);
      }
      if (username !== user.username) {
        const existing = await this.prisma.adminUser.findUnique({ where: { username } });
        if (existing && !existing.isDeleted && existing.id !== id) {
          throw createServiceError('CONFLICT', `用户名 ${username} 已存在`);
        }
      }
    }

    const roleEntities = input.role_codes ? await this.resolveRoleIds(input.role_codes) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.ensureNotLastSuperAdmin(
        user,
        {
          nextStatus,
          nextIsDeleted: false,
          nextRoleCodes,
        },
        tx,
      );

      await tx.adminUser.update({
        where: { id },
        data: {
          username: username ?? undefined,
          displayName: input.display_name == null ? undefined : (input.display_name.trim() || null),
          email: input.email == null ? undefined : (input.email.trim() || null),
          status: nextStatus,
        },
      });

      if (roleEntities) {
        await tx.adminUserRole.deleteMany({ where: { userId: id } });
        await tx.adminUserRole.createMany({
          data: roleEntities.map((role) => ({
            userId: id,
            roleId: role.id,
          })),
        });
      }

      return tx.adminUser.findUniqueOrThrow({
        where: { id },
        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });
    });

    if (nextStatus === AdminUserStatus.disabled) {
      await this.authService.clearSessionsByUserId(id);
    }

    return this.mapUser(updated as UserWithRoles);
  }

  async updateStatus(id: number, input: UpdateAdminUserStatusDto): Promise<Record<string, unknown>> {
    const user = await this.loadUserOrThrow(id);
    const nextStatus = input.status === 'disabled' ? AdminUserStatus.disabled : AdminUserStatus.active;

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.ensureNotLastSuperAdmin(
        user,
        {
          nextStatus,
          nextIsDeleted: false,
          nextRoleCodes: null,
        },
        tx,
      );

      return tx.adminUser.update({
        where: { id },
        data: { status: nextStatus },
        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });
    });

    if (nextStatus === AdminUserStatus.disabled) {
      await this.authService.clearSessionsByUserId(id);
    }

    return this.mapUser(updated as UserWithRoles);
  }

  async resetPassword(id: number, input: ResetAdminUserPasswordDto): Promise<Record<string, unknown>> {
    await this.loadUserOrThrow(id);

    const err = await this.authService.setUserPassword(id, input.new_password);
    if (err) {
      throw createServiceError('VALIDATION_ERROR', err);
    }

    await this.authService.clearSessionsByUserId(id);
    return { ok: true };
  }

  async softDelete(id: number, operatorId: number): Promise<Record<string, unknown>> {
    if (id === operatorId) {
      throw createServiceError('FORBIDDEN', '不允许删除当前登录用户');
    }

    const user = await this.loadUserOrThrow(id);

    await this.prisma.$transaction(async (tx) => {
      await this.ensureNotLastSuperAdmin(
        user,
        {
          nextStatus: AdminUserStatus.disabled,
          nextIsDeleted: true,
          nextRoleCodes: null,
        },
        tx,
      );

      await tx.adminUser.update({
        where: { id },
        data: {
          isDeleted: true,
          status: AdminUserStatus.disabled,
          deletedAt: new Date(),
        },
      });

      await tx.adminUserRole.deleteMany({ where: { userId: id } });
      await tx.adminSession.deleteMany({ where: { userId: id } });
    });

    return { ok: true };
  }
}
