/** 认证注册链路单测，覆盖 controller 注册流程和 service 自注册角色归属。 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AuthenticatedUserContext } from '../src/common/auth/auth.types';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthService } from '../src/modules/auth/auth.service';

describe('Auth register', () => {
  const envBackup = {
    ADMIN_AUTH_ENABLED: process.env.ADMIN_AUTH_ENABLED,
    ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
    ADMIN_REGISTER_SECRET: process.env.ADMIN_REGISTER_SECRET,
  };

  afterAll(() => {
    process.env.ADMIN_AUTH_ENABLED = envBackup.ADMIN_AUTH_ENABLED;
    process.env.ADMIN_SESSION_SECRET = envBackup.ADMIN_SESSION_SECRET;
    process.env.ADMIN_REGISTER_SECRET = envBackup.ADMIN_REGISTER_SECRET;
  });

  describe('HTTP register flow', () => {
    let app: INestApplication;
    let authService: {
      selfRegisterEnabled: jest.Mock<boolean, []>;
      ensureSeeded: jest.Mock<Promise<void>, []>;
      validateAdminRegisterSecret: jest.Mock<boolean, [string | null | undefined]>;
      registerSelfUser: jest.Mock<Promise<AuthenticatedUserContext>, [Record<string, unknown>]>;
      cleanupExpiredSessions: jest.Mock<Promise<void>, []>;
      createSession: jest.Mock<Promise<{ sessionId: string; expiresAt: Date }>, [Record<string, unknown>]>;
      toCurrentUserPayload: jest.Mock<Record<string, unknown>, [AuthenticatedUserContext]>;
    };

    beforeEach(async () => {
      process.env.ADMIN_AUTH_ENABLED = 'true';
      process.env.ADMIN_SESSION_SECRET = 'test-register-secret';
      process.env.ADMIN_REGISTER_SECRET = '123123';

      authService = {
        selfRegisterEnabled: jest.fn(() => true),
        ensureSeeded: jest.fn(async () => {}),
        validateAdminRegisterSecret: jest.fn((secret) => String(secret ?? '').trim() === '123123'),
        registerSelfUser: jest.fn(async (input) => {
          const accountType = input.accountType === 'admin' ? 'admin' : 'user';
          const roleCode = accountType === 'admin' ? 'admin' : 'user';
          return {
            id: accountType === 'admin' ? 2 : 1,
            username: String(input.username),
            displayName: input.displayName == null ? null : String(input.displayName),
            roleCodes: [roleCode],
            permissions: {},
          };
        }),
        cleanupExpiredSessions: jest.fn(async () => {}),
        createSession: jest.fn(async ({ userId }) => ({
          sessionId: `session-${String(userId)}`,
          expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        })),
        toCurrentUserPayload: jest.fn((user) => ({
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.roleCodes[0] ?? null,
          roles: user.roleCodes,
        })),
      };

      // HTTP 层测试只保留 Controller，并把注册/发 session 的副作用全部收敛到 mock service 里。
      const moduleRef = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          {
            provide: AuthService,
            useValue: authService,
          },
        ],
      }).compile();

      app = moduleRef.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it('registers a normal user as user', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          username: 'normaluser',
          password: 'password123',
          confirmPassword: 'password123',
          displayName: 'Normal User',
        })
        .expect(201);

      expect(response.body.currentUser).toMatchObject({
        username: 'normaluser',
        role: 'user',
        roles: ['user'],
      });
      expect(authService.registerSelfUser).toHaveBeenCalledWith(expect.objectContaining({
        username: 'normaluser',
        accountType: 'user',
      }));
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('dsa_session=')]));
    });

    it('rejects admin register when secret is missing', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          username: 'adminmissing',
          password: 'password123',
          confirmPassword: 'password123',
          accountType: 'admin',
        })
        .expect(403)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            error: 'invalid_admin_secret',
            message: '管理员专属密钥错误',
          });
        });

      expect(authService.registerSelfUser).not.toHaveBeenCalled();
    });

    it('rejects admin register when secret is invalid', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          username: 'admininvalid',
          password: 'password123',
          confirmPassword: 'password123',
          accountType: 'admin',
          adminSecret: 'wrong-secret',
        })
        .expect(403);

      expect(authService.validateAdminRegisterSecret).toHaveBeenCalledWith('wrong-secret');
      expect(authService.registerSelfUser).not.toHaveBeenCalled();
    });

    it('registers an admin as admin when secret is valid', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          username: 'adminuser',
          password: 'password123',
          confirmPassword: 'password123',
          accountType: 'admin',
          adminSecret: '123123',
        })
        .expect(201);

      expect(response.body.currentUser).toMatchObject({
        username: 'adminuser',
        role: 'admin',
        roles: ['admin'],
      });
      expect(authService.registerSelfUser).toHaveBeenCalledWith(expect.objectContaining({
        username: 'adminuser',
        accountType: 'admin',
      }));
      expect(response.headers['set-cookie']).toEqual(expect.arrayContaining([expect.stringContaining('dsa_session=')]));
    });

    it('returns conflict when username already exists', async () => {
      authService.registerSelfUser.mockRejectedValueOnce(Object.assign(new Error('用户名 duplicate 已存在'), {
        code: 'CONFLICT',
      }));

      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({
          username: 'duplicate',
          password: 'password123',
          confirmPassword: 'password123',
        })
        .expect(409)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            error: 'conflict',
            message: '用户名 duplicate 已存在',
          });
        });
    });
  });

  describe('AuthService role assignment', () => {
    // 这组测试专门验证自注册最终绑定到哪种内置角色，不依赖完整数据库实现。
    function createServiceHarness() {
      let assignedRoleId: number | null = null;
      const roleIdMap = new Map<number, string>([
        [101, 'user'],
        [202, 'admin'],
      ]);

      const tx = {
        adminUser: {
          create: jest.fn(async ({ data }) => ({
            id: 7,
            username: data.username,
            displayName: data.displayName,
            status: data.status,
            isDeleted: data.isDeleted,
          })),
          findUniqueOrThrow: jest.fn(async ({ where }) => ({
            id: where.id,
            username: 'tester',
            displayName: 'Tester',
            userRoles: [
              {
                role: {
                  roleCode: roleIdMap.get(assignedRoleId ?? 101) ?? 'user',
                  permissions: [
                    {
                      moduleCode: 'auth',
                      canRead: true,
                      canWrite: true,
                    },
                  ],
                },
              },
            ],
          })),
        },
        adminUserRole: {
          create: jest.fn(async ({ data }) => {
            assignedRoleId = data.roleId;
            return { id: 1, ...data };
          }),
        },
      };

      const prisma = {
        adminRole: {
          findFirst: jest.fn(async ({ where }) => {
            if (where.roleCode === 'user') {
              return { id: 101 };
            }
            if (where.roleCode === 'admin') {
              return { id: 202 };
            }
            return null;
          }),
        },
        adminUser: {
          findUnique: jest.fn(async () => null),
        },
        $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => await callback(tx)),
      } as any;

      return {
        prisma,
        tx,
        getAssignedRoleId: () => assignedRoleId,
      };
    }

    it('assigns user role to normal self-registration', async () => {
      const harness = createServiceHarness();
      const service = new AuthService(harness.prisma);

      const user = await service.registerSelfUser({
        username: 'normaluser',
        password: 'password123',
        accountType: 'user',
      });

      expect(harness.getAssignedRoleId()).toBe(101);
      expect(harness.tx.adminUserRole.create).toHaveBeenCalledWith({
        data: {
          userId: 7,
          roleId: 101,
        },
      });
      expect(user.roleCodes).toEqual(['user']);
    });

    it('assigns admin role to admin self-registration', async () => {
      const harness = createServiceHarness();
      const service = new AuthService(harness.prisma);

      const user = await service.registerSelfUser({
        username: 'adminuser',
        password: 'password123',
        accountType: 'admin',
      });

      expect(harness.getAssignedRoleId()).toBe(202);
      expect(harness.tx.adminUserRole.create).toHaveBeenCalledWith({
        data: {
          userId: 7,
          roleId: 202,
        },
      });
      expect(user.roleCodes).toEqual(['admin']);
    });
  });
});
