import { buildAdminLogEventView, matchesAdminLogKeyword } from '../src/modules/admin-logs/admin-log-event.util';

describe('Admin log readable events', () => {
  it('builds a readable stock analysis summary', () => {
    const event = buildAdminLogEventView({
      userId: 7,
      usernameSnapshot: 'surper1',
      method: 'POST',
      path: '/api/v1/analysis/analyze',
      moduleCode: 'analysis',
      action: 'write',
      success: true,
      queryMasked: {},
      bodyMasked: {
        stock_code: '600519',
      },
      responseMasked: {
        ok: true,
      },
      user: {
        id: 7,
        username: 'surper1',
        displayName: null,
      },
    });

    expect(event).toMatchObject({
      eventType: 'analysis_stock',
      eventSummary: 'surper1分析了股票 600519',
      moduleLabel: '股票分析',
      resultLabel: '成功',
      targetLabel: '600519',
    });
  });

  it('builds a readable recharge summary and supports keyword matching on summary text', () => {
    const event = buildAdminLogEventView({
      userId: 11,
      usernameSnapshot: 'admin1',
      method: 'POST',
      path: '/api/v1/users/me/trading/funds/add',
      moduleCode: 'trading_account',
      action: 'write',
      success: true,
      queryMasked: {},
      bodyMasked: {
        amount: 5000,
        note: 'manual topup',
      },
      responseMasked: {
        ok: true,
      },
      user: {
        id: 11,
        username: 'admin1',
        displayName: null,
      },
    });

    expect(event.eventSummary).toContain('admin1充值了 5,000 元');
    expect(matchesAdminLogKeyword(event, '充值', '/api/v1/users/me/trading/funds/add')).toBe(true);
  });

  it('resolves target usernames for admin reset password events', () => {
    const event = buildAdminLogEventView({
      userId: 7,
      usernameSnapshot: 'surper1',
      method: 'POST',
      path: '/api/v1/admin/users/12/reset-password',
      moduleCode: 'admin_user',
      action: 'write',
      success: true,
      queryMasked: {},
      bodyMasked: {},
      responseMasked: {
        ok: true,
      },
      user: {
        id: 7,
        username: 'surper1',
        displayName: null,
      },
    }, {
      adminUserLabels: new Map([[12, 'admin1']]),
    });

    expect(event).toMatchObject({
      eventType: 'admin_user_reset_password',
      eventSummary: 'surper1重置了用户 admin1 的密码',
      moduleLabel: '用户管理',
      targetLabel: 'admin1',
    });
  });

  it('formats config changes without leaking secret values', () => {
    const event = buildAdminLogEventView({
      userId: 1,
      usernameSnapshot: 'admin',
      method: 'PUT',
      path: '/api/v1/system/config',
      moduleCode: 'system_config',
      action: 'write',
      success: true,
      queryMasked: {},
      bodyMasked: {
        items: [
          { key: 'ADMIN_REGISTER_SECRET', value: '[REDACTED]' },
          { key: 'BACKTEST_EVAL_WINDOW_DAYS', value: '30' },
        ],
      },
      responseMasked: {
        ok: true,
      },
      user: {
        id: 1,
        username: 'admin',
        displayName: '管理员',
      },
    });

    expect(event.moduleLabel).toBe('配置管理');
    expect(event.eventSummary).toContain('管理员注册密钥');
    expect(event.eventSummary).toContain('回测评估窗口');
    expect(event.eventSummary).not.toContain('[REDACTED]');
    expect(event.eventSummary).not.toContain('123123');
  });

  it('marks base and backtest config changes as strategy parameters', () => {
    const event = buildAdminLogEventView({
      userId: 1,
      usernameSnapshot: 'admin',
      method: 'PUT',
      path: '/api/v1/system/config',
      moduleCode: 'system_config',
      action: 'write',
      success: true,
      queryMasked: {},
      bodyMasked: {
        items: [
          { key: 'BACKTEST_EVAL_WINDOW_DAYS', value: '30' },
          { key: 'ANALYSIS_AUTO_ORDER_ENABLED', value: 'true' },
        ],
      },
      responseMasked: {
        ok: true,
      },
      user: {
        id: 1,
        username: 'admin',
        displayName: null,
      },
    });

    expect(event.moduleLabel).toBe('策略参数');
    expect(event.eventSummary).toContain('回测评估窗口');
    expect(event.eventSummary).toContain('分析后自动下单');
  });
});
