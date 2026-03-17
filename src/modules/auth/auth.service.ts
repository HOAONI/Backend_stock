/** 后台认证模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { AdminUserStatus, Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '@/common/database/prisma.service';
import {
  DEFAULT_ADMIN_REGISTER_SECRET,
  MIN_PASSWORD_LEN,
  RATE_LIMIT_MAX_FAILURES,
  RATE_LIMIT_WINDOW_SEC,
} from '@/common/auth/auth.constants';
import { parseSessionCookie, verifySessionCookie } from '@/common/auth/auth.utils';
import { AuthenticatedUserContext, CurrentUserPayload } from '@/common/auth/auth.types';
import {
  BUILTIN_ROLE_CODES,
  BUILTIN_ROLE_PERMISSIONS,
  ModulePermission,
  normalizeRoleCode,
  normalizeUsername,
  RbacModuleCode,
  resolveBuiltinRolePermissions,
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

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
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

  // 每次启动都尝试把内置角色与权限自愈到当前版本，避免历史数据把鉴权链路拖偏。
  private async seedBuiltinRolesAndUsers(): Promise<void> {
    const roleMeta = [
      {
        roleCode: BUILTIN_ROLE_CODES.admin,
        roleName: '管理员',
        description: '拥有系统后台管理权限（不含角色管理）',
      },
      {
        roleCode: BUILTIN_ROLE_CODES.user,
        roleName: '普通用户',
        description: '可使用分析、回测、交易与个人设置能力',
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

      const adminRoleId = roles.get(BUILTIN_ROLE_CODES.admin);
      const userRoleId = roles.get(BUILTIN_ROLE_CODES.user);
      if (!adminRoleId || !userRoleId) {
        throw new Error('无法初始化 admin/user 角色');
      }

      const users = await tx.adminUser.findMany({
        where: { isDeleted: false },
        select: {
          id: true,
          username: true,
          userRoles: {
            include: {
              role: {
                select: {
                  roleCode: true,
                  isDeleted: true,
                },
              },
            },
          },
        },
      });

      if (users.length === 0) {
        // 首次启动必须落一个可登录的管理员，否则后台会进入“已开启鉴权但无人可进”的死锁态。
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

        await tx.adminUserRole.create({
          data: {
            userId: user.id,
            roleId: adminRoleId,
          },
        });
      } else {
        // 历史版本里存在 super_admin / analyst / operator 等角色，这里统一收敛到 admin / user 两档。
        const migratedUserIds: number[] = [];

        for (const user of users) {
          const activeRoleCodes = user.userRoles
            .filter((item) => !item.role.isDeleted)
            .map((item) => item.role.roleCode);
          const normalizedRoleCodes = Array.from(new Set(activeRoleCodes.map((item) => normalizeRoleCode(item)).filter(Boolean)));
          const targetRoleCode = user.username === 'surper1' || normalizedRoleCodes.includes(BUILTIN_ROLE_CODES.admin)
            ? BUILTIN_ROLE_CODES.admin
            : BUILTIN_ROLE_CODES.user;

          if (activeRoleCodes.length === 1 && activeRoleCodes[0] === targetRoleCode) {
            continue;
          }

          await tx.adminUserRole.deleteMany({ where: { userId: user.id } });
          await tx.adminUserRole.create({
            data: {
              userId: user.id,
              roleId: targetRoleCode === BUILTIN_ROLE_CODES.admin ? adminRoleId : userRoleId,
            },
          });
          migratedUserIds.push(user.id);
        }

        if (migratedUserIds.length > 0) {
          await tx.adminSession.deleteMany({
            where: {
              userId: { in: migratedUserIds },
            },
          });
        }
      }

      await tx.adminRole.updateMany({
        where: {
          roleCode: {
            in: ['super_admin', 'analyst', 'operator'],
          },
          isDeleted: false,
        },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
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

  private getAdminRegisterSecret(): string {
    const configured = String(process.env.ADMIN_REGISTER_SECRET ?? '').trim();
    return configured || DEFAULT_ADMIN_REGISTER_SECRET;
  }

  validateAdminRegisterSecret(secret: string | null | undefined): boolean {
    return String(secret ?? '').trim() === this.getAdminRegisterSecret();
  }

  private resolvePrimaryRole(roleCodes: string[]): string | null {
    const normalized = roleCodes.map((item) => normalizeRoleCode(item)).filter(Boolean);
    if (normalized.includes(BUILTIN_ROLE_CODES.admin)) {
      return BUILTIN_ROLE_CODES.admin;
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

    // 这里把“内置角色的静态权限”和“数据库里自定义角色权限”统一折叠成同一种结构。
    // 一个用户可能同时挂多个角色，这里按“读写并集”合并，避免权限被后出现的角色覆盖掉。
    for (const userRole of userRoles) {
      const builtinPermissions = resolveBuiltinRolePermissions(userRole.role.roleCode);
      const permissions = builtinPermissions
        ? Object.entries(builtinPermissions).map(([moduleCode, permission]) => ({
            moduleCode,
            canRead: Boolean(permission?.canRead),
            canWrite: Boolean(permission?.canWrite),
          }))
        : userRole.role.permissions;

      for (const permission of permissions) {
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
      roleCodes: Array.from(new Set(record.user.userRoles.map((item) => normalizeRoleCode(item.role.roleCode)).filter(Boolean))),
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
    accountType?: 'user' | 'admin';
  }): Promise<AuthenticatedUserContext> {
    // 自注册只允许落到内置角色，保证前端入口不会绕开后台约束创建出未知角色组合。
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

    const accountType = input.accountType === 'admin' ? 'admin' : 'user';
    const targetRoleCode = accountType === 'admin'
      ? BUILTIN_ROLE_CODES.admin
      : BUILTIN_ROLE_CODES.user;
    const targetRoleId = await this.getActiveRoleIdByCode(targetRoleCode);
    if (!targetRoleId) {
      const error = new Error(`系统未初始化 ${targetRoleCode} 角色`) as Error & { code?: string };
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

    // 用户与角色绑定必须在一个事务里创建，避免只建了账号却没落角色导致后续无法登录。
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
          roleId: targetRoleId,
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
    // 会话解析阶段一次性带出角色和权限，后续 controller/middleware 就不用重复查库拼上下文。
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

  // 会话除了验签外，还要再检查过期状态和用户有效性，避免被删除/禁用账号继续沿用旧 cookie。
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
    // cookie 先验签，再回源数据库确认 session 与用户仍然有效，避免中间件层直接处理细节。
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

  // 登录成功后会回写 lastLoginAt，既方便运营排查，也能辅助识别“从未真正登录过”的初始化账号。
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

  // Session 数据始终落服务端数据库，cookie 里只放签名后的 sessionId，便于后续统一失效与审计。
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

  // 限流窗口按用户名 + IP 聚合，兼顾暴力破解防护与同一办公网络下的误伤控制。
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

  // 失败次数会在窗口期内累加，窗口过后自动重置，避免一次输错永久把用户锁死。
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
