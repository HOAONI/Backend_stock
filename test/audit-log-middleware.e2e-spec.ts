/** 审计中间件单测，确保敏感字段进入日志前会被统一脱敏。 */

import { EventEmitter } from 'node:events';

import { AuditLogMiddleware } from '../src/common/auth/audit-log.middleware';

describe('AuditLogMiddleware', () => {
  it('redacts adminSecret from persisted audit payloads', async () => {
    const prisma = {
      adminAuditLog: {
        create: jest.fn(async () => ({})),
      },
    } as any;

    const middleware = new AuditLogMiddleware(prisma);
    const req = {
      path: '/api/v1/auth/register',
      originalUrl: '/api/v1/auth/register',
      method: 'POST',
      headers: {
        'user-agent': 'jest-test',
      },
      query: {
        accountType: 'admin',
      },
      body: {
        username: 'root2',
        adminSecret: '123123',
        password: 'password123',
      },
      authUser: {
        id: 1,
        username: 'admin',
      },
      ip: '127.0.0.1',
      socket: {
        remoteAddress: '127.0.0.1',
      },
    } as any;

    // 用 EventEmitter 模拟 Express response 的 finish 生命周期，覆盖日志在响应结束后异步落库的路径。
    const res = Object.assign(new EventEmitter(), {
      statusCode: 201,
      setHeader: jest.fn(),
      json: jest.fn(function json(_body: unknown) {
        return this;
      }),
      send: jest.fn(function send(_body?: unknown) {
        return this;
      }),
    }) as any;

    const next = jest.fn();
    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);

    res.json({
      ok: true,
      adminSecret: '123123',
    });
    res.emit('finish');

    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.adminAuditLog.create).toHaveBeenCalledTimes(1);

    const loggedData = prisma.adminAuditLog.create.mock.calls[0][0].data;
    expect(loggedData.bodyMaskedJson).toContain('"adminSecret":"[REDACTED]"');
    expect(loggedData.responseMaskedJson).toContain('"adminSecret":"[REDACTED]"');
    expect(loggedData.bodyMaskedJson).not.toContain('123123');
    expect(loggedData.responseMaskedJson).not.toContain('123123');
  });
});
