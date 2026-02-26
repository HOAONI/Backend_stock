import { Injectable, OnModuleInit } from '@nestjs/common';
import { AdminUserStatus, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '@/common/database/prisma.service';
import { MIN_PASSWORD_LEN, RATE_LIMIT_MAX_FAILURES, RATE_LIMIT_WINDOW_SEC } from '@/common/auth/auth.constants';
import { parseSessionCookie, verifySessionCookie } from '@/common/auth/auth.utils';
import { AuthenticatedUserContext, CurrentUserPayload } from '@/common/auth/auth.types';
import {
  BUILTIN_ROLE_CODES,
  BUILTIN_ROLE_PERMISSIONS,
  ModulePermission,
  normalizeRoleCode,
  normalizeUsername,
  RbacModuleCode,
} from '@/common/auth/rbac.constants';

interface SessionRecord {
  sessionId: string;
  expiresAt: Date;
  user: {
    id: number;
    username: string;
    displayName: string | null;
    status: AdminUserStatus;
    isDeleted: boolean;
    userRoles: Array<{
      role: {
        roleCode: string;
        permissions: Array<{
          moduleCode: string;
          canRead: boolean;
          canWrite: boolean;
        }>;
      };
    }>;
  };
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{3,64}$/;

function normalizeModuleCode(value: string): RbacModuleCode | null {
  const text = String(value ?? '').trim() as RbacModuleCode;
  return text || null;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private seedPromise: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    if (!this.authEnabled()) {
      return;
    }
    await this.ensureSeeded();
  }

  authEnabled(): boolean {
    return (process.env.ADMIN_AUTH_ENABLED ?? 'false').toLowerCase() === 'true';
  }

  selfRegisterEnabled(): boolean {
    return (process.env.ADMIN_SELF_REGISTER_ENABLED ?? 'true').toLowerCase() !== 'false';
  }

  async ensureSeeded(): Promise<void> {
    if (!this.authEnabled()) {
      return;
    }

    if (!this.seedPromise) {
      this.seedPromise = this.seedBuiltinRolesAndUsers();
    }

    await this.seedPromise;
  }

  private async seedBuiltinRolesAndUsers(): Promise<void> {
    const roleMeta = [
      {
        roleCode: BUILTIN_ROLE_CODES.superAdmin,
        roleName: '超级管理员',
        description: '拥有系统全部权限',
      },
      {
        roleCode: BUILTIN_ROLE_CODES.analyst,
        roleName: '分析员',
        description: '负责分析和回测能力',
      },
      {
        roleCode: BUILTIN_ROLE_CODES.operator,
        roleName: '操作员',
        description: '负责系统配置与运营',
      },
    ] as const;

    await this.prisma.$transaction(async (tx) => {
      const roles = new Map<string, number>();

      for (const item of roleMeta) {
        const role = await tx.adminRole.upsert({
          where: { roleCode: item.roleCode },
          update: {
            roleName: item.roleName,
            description: item.description,
            isBuiltin: true,
            isDeleted: false,
            deletedAt: null,
          },
          create: {
            roleCode: item.roleCode,
            roleName: item.roleName,
            description: item.description,
            isBuiltin: true,
            isDeleted: false,
          },
        });
        roles.set(item.roleCode, role.id);
      }

      for (const [roleCode, permissions] of Object.entries(BUILTIN_ROLE_PERMISSIONS)) {
        const roleId = roles.get(roleCode);
        if (!roleId) {
          continue;
        }

        const moduleCodes = Object.keys(permissions);
        await tx.adminRolePermission.deleteMany({
          where: {
            roleId,
            moduleCode: {
              notIn: moduleCodes,
            },
          },
        });

        for (const [moduleCode, permission] of Object.entries(permissions)) {
          await tx.adminRolePermission.upsert({
            where: {
              roleId_moduleCode: {
                roleId,
                moduleCode,
              },
            },
            update: {
              canRead: Boolean(permission?.canRead),
              canWrite: Boolean(permission?.canWrite),
            },
            create: {
              roleId,
              moduleCode,
              canRead: Boolean(permission?.canRead),
              canWrite: Boolean(permission?.canWrite),
            },
          });
        }
      }

      const userCount = await tx.adminUser.count({ where: { isDeleted: false } });
      if (userCount > 0) {
        return;
      }

      const username = normalizeUsername(process.env.ADMIN_INIT_USERNAME || 'admin');
      const usernameError = this.validateUsername(username);
      if (usernameError) {
        throw new Error(`ADMIN_INIT_USERNAME 无效: ${usernameError}`);
      }

      const initPassword = String(process.env.ADMIN_INIT_PASSWORD ?? '').trim();
      const passwordError = this.validatePassword(initPassword);
      if (passwordError) {
        throw new Error(`首次启动需要设置 ADMIN_INIT_PASSWORD: ${passwordError}`);
      }

      const passwordHash = await argon2.hash(initPassword, { type: argon2.argon2id });
      const user = await tx.adminUser.create({
        data: {
          username,
          passwordHash,
          displayName: 'Administrator',
          status: AdminUserStatus.active,
          isDeleted: false,
        },
      });

      const superAdminRoleId = roles.get(BUILTIN_ROLE_CODES.superAdmin);
      if (!superAdminRoleId) {
        throw new Error('无法初始化 super_admin 角色');
      }

      await tx.adminUserRole.create({
        data: {
          userId: user.id,
          roleId: superAdminRoleId,
        },
      });
    });
  }

  validatePassword(value: string): string | null {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) {
      return '密码不能为空';
    }
    if (trimmed.length < MIN_PASSWORD_LEN) {
      return `密码至少 ${MIN_PASSWORD_LEN} 位`;
    }
    return null;
  }

  validateUsername(value: string): string | null {
    const username = normalizeUsername(value);
    if (!username) {
      return '用户名不能为空';
    }
    if (!USERNAME_PATTERN.test(username)) {
      return '用户名需为 3-64 位字母、数字、下划线、连字符或点';
    }
    return null;
  }

  private resolvePrimaryRole(roleCodes: string[]): string | null {
    const normalized = roleCodes.map((item) => normalizeRoleCode(item)).filter(Boolean);
    if (normalized.includes(BUILTIN_ROLE_CODES.superAdmin)) {
      return BUILTIN_ROLE_CODES.superAdmin;
    }
    return normalized[0] ?? null;
  }

  async isAnyLoginableAdmin(): Promise<boolean> {
    const count = await this.prisma.adminUser.count({
      where: {
        isDeleted: false,
        status: AdminUserStatus.active,
      },
    });
    return count > 0;
  }

  private buildPermissions(
    userRoles: SessionRecord['user']['userRoles'],
  ): Partial<Record<RbacModuleCode, ModulePermission>> {
    const result: Partial<Record<RbacModuleCode, ModulePermission>> = {};

    for (const userRole of userRoles) {
      for (const permission of userRole.role.permissions) {
        const moduleCode = normalizeModuleCode(permission.moduleCode);
        if (!moduleCode) {
          continue;
        }

        const previous = result[moduleCode] ?? { canRead: false, canWrite: false };
        result[moduleCode] = {
          canRead: previous.canRead || permission.canRead || permission.canWrite,
          canWrite: previous.canWrite || permission.canWrite,
        };
      }
    }

    return result;
  }

  private toContext(record: SessionRecord): AuthenticatedUserContext {
    return {
      id: record.user.id,
      username: record.user.username,
      displayName: record.user.displayName,
      roleCodes: record.user.userRoles.map((item) => normalizeRoleCode(item.role.roleCode)),
      permissions: this.buildPermissions(record.user.userRoles),
    };
  }

  toCurrentUserPayload(user: AuthenticatedUserContext): CurrentUserPayload {
    const normalizedRoles = Array.from(new Set(user.roleCodes.map((item) => normalizeRoleCode(item)).filter(Boolean)));
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: this.resolvePrimaryRole(normalizedRoles),
      roles: normalizedRoles,
    };
  }

  private async getActiveRoleIdByCode(roleCode: string): Promise<number | null> {
    const role = await this.prisma.adminRole.findFirst({
      where: {
        roleCode: normalizeRoleCode(roleCode),
        isDeleted: false,
      },
      select: { id: true },
    });

    return role?.id ?? null;
  }

  async registerSelfUser(input: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<AuthenticatedUserContext> {
    const username = normalizeUsername(input.username);
    const usernameError = this.validateUsername(username);
    if (usernameError) {
      const error = new Error(usernameError) as Error & { code?: string };
      error.code = 'VALIDATION_ERROR';
      throw error;
    }

    const passwordError = this.validatePassword(input.password);
    if (passwordError) {
      const error = new Error(passwordError) as Error & { code?: string };
      error.code = 'VALIDATION_ERROR';
      throw error;
    }

    const analystRoleId = await this.getActiveRoleIdByCode(BUILTIN_ROLE_CODES.analyst);
    if (!analystRoleId) {
      const error = new Error('系统未初始化 analyst 角色') as Error & { code?: string };
      error.code = 'INTERNAL_ERROR';
      throw error;
    }

    const existing = await this.prisma.adminUser.findUnique({
      where: { username },
      select: {
        id: true,
        isDeleted: true,
      },
    });
    if (existing && !existing.isDeleted) {
      const error = new Error(`用户名 ${username} 已存在`) as Error & { code?: string };
      error.code = 'CONFLICT';
      throw error;
    }
    if (existing?.isDeleted) {
      const error = new Error(`用户名 ${username} 已被历史记录占用`) as Error & { code?: string };
      error.code = 'CONFLICT';
      throw error;
    }

    const passwordHash = await argon2.hash(String(input.password).trim(), { type: argon2.argon2id });
    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.adminUser.create({
        data: {
          username,
          passwordHash,
          displayName: input.displayName?.trim() || null,
          status: AdminUserStatus.active,
          isDeleted: false,
        },
      });

      await tx.adminUserRole.create({
        data: {
          userId: created.id,
          roleId: analystRoleId,
        },
      });

      return tx.adminUser.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          userRoles: {
            include: {
              role: {
                include: {
                  permissions: true,
                },
              },
            },
          },
        },
      });
    });

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      roleCodes: user.userRoles.map((item) => normalizeRoleCode(item.role.roleCode)),
      permissions: this.buildPermissions(
        user.userRoles.map((item) => ({
          role: {
            roleCode: item.role.roleCode,
            permissions: item.role.permissions.map((permission) => ({
              moduleCode: permission.moduleCode,
              canRead: permission.canRead,
              canWrite: permission.canWrite,
            })),
          },
        })),
      ),
    };
  }

  private async loadSessionWithUser(sessionId: string): Promise<SessionRecord | null> {
    const session = await this.prisma.adminSession.findUnique({
      where: { sessionId },
      include: {
        user: {
          include: {
            userRoles: {
              include: {
                role: {
                  include: {
                    permissions: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!session) {
      return null;
    }

    return session as SessionRecord;
  }

  async resolveUserFromSessionId(sessionId: string): Promise<AuthenticatedUserContext | null> {
    const session = await this.loadSessionWithUser(sessionId);
    if (!session) {
      return null;
    }

    if (session.expiresAt.getTime() < Date.now()) {
      await this.clearSession(sessionId);
      return null;
    }

    if (session.user.isDeleted || session.user.status !== AdminUserStatus.active) {
      return null;
    }

    return this.toContext(session);
  }

  async resolveUserFromCookie(cookieValue: string): Promise<{ user: AuthenticatedUserContext; sessionId: string } | null> {
    const verified = verifySessionCookie(cookieValue);
    if (!verified.valid || !verified.sessionId) {
      return null;
    }

    const user = await this.resolveUserFromSessionId(verified.sessionId);
    if (!user) {
      return null;
    }

    return {
      user,
      sessionId: verified.sessionId,
    };
  }

  async verifyPasswordForUser(userId: number, password: string): Promise<boolean> {
    const row = await this.prisma.adminUser.findUnique({ where: { id: userId } });
    if (!row || row.isDeleted) {
      return false;
    }

    try {
      return await argon2.verify(row.passwordHash, password);
    } catch {
      return false;
    }
  }

  async findActiveUserByUsername(username: string): Promise<Prisma.AdminUserGetPayload<{ include: { userRoles: { include: { role: { include: { permissions: true } } } } } }> | null> {
    const normalized = normalizeUsername(username);
    const user = await this.prisma.adminUser.findUnique({
      where: { username: normalized },
      include: {
        userRoles: {
          include: {
            role: {
              include: {
                permissions: true,
              },
            },
          },
        },
      },
    });

    if (!user || user.isDeleted || user.status !== AdminUserStatus.active) {
      return null;
    }

    return user;
  }

  async authenticate(username: string, password: string): Promise<AuthenticatedUserContext | null> {
    const user = await this.findActiveUserByUsername(username);
    if (!user) {
      return null;
    }

    try {
      const verified = await argon2.verify(user.passwordHash, password);
      if (!verified) {
        return null;
      }
    } catch {
      return null;
    }

    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      roleCodes: user.userRoles.map((item) => normalizeRoleCode(item.role.roleCode)),
      permissions: this.buildPermissions(
        user.userRoles.map((item) => ({
          role: {
            roleCode: item.role.roleCode,
            permissions: item.role.permissions.map((permission) => ({
              moduleCode: permission.moduleCode,
              canRead: permission.canRead,
              canWrite: permission.canWrite,
            })),
          },
        })),
      ),
    };
  }

  async hashPassword(password: string): Promise<{ hash?: string; error?: string }> {
    const error = this.validatePassword(password);
    if (error) {
      return { error };
    }

    const hash = await argon2.hash(String(password).trim(), { type: argon2.argon2id });
    return { hash };
  }

  async setUserPassword(userId: number, password: string): Promise<string | null> {
    const hashed = await this.hashPassword(password);
    if (hashed.error || !hashed.hash) {
      return hashed.error || '密码不合法';
    }

    await this.prisma.adminUser.update({
      where: { id: userId },
      data: {
        passwordHash: hashed.hash,
      },
    });

    return null;
  }

  async changePassword(userId: number, currentPassword: string, newPassword: string): Promise<string | null> {
    const verified = await this.verifyPasswordForUser(userId, currentPassword);
    if (!verified) {
      return '当前密码错误';
    }

    return this.setUserPassword(userId, newPassword);
  }

  async createSession(input: {
    userId: number;
    maxAgeSeconds: number;
    ip: string;
    userAgent: string;
  }): Promise<{ sessionId: string; expiresAt: Date }> {
    const sessionId = randomUUID().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + input.maxAgeSeconds * 1000);

    await this.prisma.adminSession.create({
      data: {
        sessionId,
        userId: input.userId,
        expiresAt,
        ip: input.ip,
        userAgent: input.userAgent.slice(0, 255),
      },
    });

    return { sessionId, expiresAt };
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.prisma.adminSession.deleteMany({ where: { sessionId } });
  }

  async clearSessionsByUserId(userId: number): Promise<void> {
    await this.prisma.adminSession.deleteMany({ where: { userId } });
  }

  async cleanupExpiredSessions(): Promise<void> {
    await this.prisma.adminSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.prisma.adminSession.updateMany({
      where: { sessionId },
      data: { lastSeenAt: new Date() },
    });
  }

  async checkRateLimit(ip: string, username: string): Promise<boolean> {
    const key = {
      ip,
      username: normalizeUsername(username),
    };

    const row = await this.prisma.adminLoginRateLimit.findUnique({ where: { ip_username: key } });
    if (!row) {
      return true;
    }

    const now = Date.now();
    const first = row.firstFailedAt.getTime();
    if ((now - first) / 1000 > RATE_LIMIT_WINDOW_SEC) {
      await this.prisma.adminLoginRateLimit.delete({ where: { ip_username: key } });
      return true;
    }

    return row.failureCount < RATE_LIMIT_MAX_FAILURES;
  }

  async recordFailure(ip: string, username: string): Promise<void> {
    const key = {
      ip,
      username: normalizeUsername(username),
    };

    const row = await this.prisma.adminLoginRateLimit.findUnique({ where: { ip_username: key } });
    const now = new Date();

    if (!row) {
      await this.prisma.adminLoginRateLimit.create({
        data: {
          ip: key.ip,
          username: key.username,
          failureCount: 1,
          firstFailedAt: now,
        },
      });
      return;
    }

    const elapsed = (Date.now() - row.firstFailedAt.getTime()) / 1000;
    if (elapsed > RATE_LIMIT_WINDOW_SEC) {
      await this.prisma.adminLoginRateLimit.update({
        where: { ip_username: key },
        data: {
          failureCount: 1,
          firstFailedAt: now,
        },
      });
      return;
    }

    await this.prisma.adminLoginRateLimit.update({
      where: { ip_username: key },
      data: {
        failureCount: row.failureCount + 1,
      },
    });
  }

  async clearRateLimit(ip: string, username: string): Promise<void> {
    await this.prisma.adminLoginRateLimit.deleteMany({
      where: {
        ip,
        username: normalizeUsername(username),
      },
    });
  }

  parseCookieSessionId(cookieValue: string): string | null {
    const parsed = parseSessionCookie(cookieValue);
    if (!parsed) {
      return null;
    }
    return parsed.sessionId;
  }
}
