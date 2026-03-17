/** 审计日志可读化单测，确保后台把原始请求轨迹翻译成适合运营查看的中文事件摘要。 */

import { buildAdminLogEventView, matchesAdminLogKeyword } from '../src/modules/admin-logs/admin-log-event.util';
import type { AdminLogEventInput } from '../src/modules/admin-logs/admin-log-event.util';

// 用统一的最小事件骨架起步，测试只覆盖各接口路径带来的摘要差异。
function createInput(overrides: Partial<AdminLogEventInput> = {}): AdminLogEventInput {
  return {
    userId: 7,
    usernameSnapshot: 'surper1',
    method: 'GET',
    path: '/api/v1/unknown',
    moduleCode: 'analysis',
    action: 'read',
    success: true,
    queryMasked: {},
    bodyMasked: {},
    responseMasked: {},
    user: {
      id: 7,
      username: 'surper1',
      displayName: null,
    },
    ...overrides,
  };
}

// 可读摘要应该面向人，不应把 HTTP 动词和原始 API 路径直接暴露给后台用户。
function expectReadableSummary(summary: string): void {
  expect(summary).not.toMatch(/\b(GET|POST|PUT|PATCH|DELETE)\b/);
  expect(summary).not.toContain('/api/v1/');
}

describe('Admin log readable events', () => {
  it('builds a readable stock analysis summary', () => {
    const event = buildAdminLogEventView(createInput({
      method: 'POST',
      path: '/api/v1/analysis/analyze',
      moduleCode: 'analysis',
      action: 'write',
      bodyMasked: {
        stock_code: '600519',
      },
      responseMasked: {
        ok: true,
      },
    }));

    expect(event).toMatchObject({
      eventType: 'analysis_stock',
      eventSummary: 'surper1分析了股票 600519',
      moduleLabel: '股票分析',
      resultLabel: '成功',
      targetLabel: '600519',
    });
  });

  it('builds a readable recharge summary and supports keyword matching on summary text', () => {
    const event = buildAdminLogEventView(createInput({
      userId: 11,
      usernameSnapshot: 'admin1',
      method: 'POST',
      path: '/api/v1/users/me/trading/funds/add',
      moduleCode: 'trading_account',
      action: 'write',
      bodyMasked: {
        amount: 5000,
        note: 'manual topup',
      },
      user: {
        id: 11,
        username: 'admin1',
        displayName: null,
      },
    }));

    expect(event.eventSummary).toContain('admin1充值了 5,000 元');
    expect(matchesAdminLogKeyword(event, '充值', '/api/v1/users/me/trading/funds/add')).toBe(true);
  });

  it('builds readable simulation account events and keeps raw path searchable', () => {
    const statusEvent = buildAdminLogEventView(createInput({
      userId: 11,
      usernameSnapshot: 'admin1',
      path: '/api/v1/users/me/simulation-account/status',
      moduleCode: 'broker_account',
      action: 'read',
      responseMasked: {
        is_bound: true,
        account_uid: 'bt-user-2',
        account_display_name: '我的账号 1',
      },
      user: {
        id: 11,
        username: 'admin1',
        displayName: null,
      },
    }));

    expect(statusEvent).toMatchObject({
      eventType: 'simulation_account_status',
      eventSummary: 'admin1查看了模拟账户状态：我的账号 1',
      moduleLabel: '模拟账户',
      targetLabel: '我的账号 1',
    });
    expect(matchesAdminLogKeyword(statusEvent, '/api/v1/users/me/simulation-account/status', '/api/v1/users/me/simulation-account/status')).toBe(true);

    const bindEvent = buildAdminLogEventView(createInput({
      userId: 11,
      usernameSnapshot: 'admin1',
      method: 'POST',
      path: '/api/v1/users/me/simulation-account/bind',
      moduleCode: 'broker_account',
      action: 'write',
      bodyMasked: {
        account_uid: 'bt-user-2',
        account_display_name: '我的账号 1',
      },
      responseMasked: {
        account_uid: 'bt-user-2',
        account_display_name: '我的账号 1',
      },
      user: {
        id: 11,
        username: 'admin1',
        displayName: null,
      },
    }));

    expect(bindEvent.eventSummary).toBe('admin1绑定了模拟账户 我的账号 1');
    expect(bindEvent.targetLabel).toBe('我的账号 1');
  });

  it('renders readable view summaries for trading, stocks, history and analysis task endpoints', () => {
    const tradingEvent = buildAdminLogEventView(createInput({
      userId: 11,
      usernameSnapshot: 'admin1',
      path: '/api/v1/users/me/trading/orders?refresh=true',
      moduleCode: 'trading_account',
      action: 'read',
      queryMasked: {
        refresh: true,
      },
      user: {
        id: 11,
        username: 'admin1',
        displayName: null,
      },
    }));

    expect(tradingEvent).toMatchObject({
      eventType: 'trading_orders',
      eventSummary: 'admin1刷新了委托列表',
      targetLabel: '已刷新',
    });

    const quoteEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/stocks/600519/quote',
      moduleCode: 'stocks',
      action: 'read',
    }));

    expect(quoteEvent.eventSummary).toBe('surper1查看了股票 600519 的实时行情');

    const historyEvent = buildAdminLogEventView(createInput({
      userId: 11,
      usernameSnapshot: 'admin1',
      path: '/api/v1/history/46436ac31b8449e3876430a7b518a8b3/news?limit=20',
      moduleCode: 'history',
      action: 'read',
      responseMasked: {
        total: 0,
        items: [],
      },
      user: {
        id: 11,
        username: 'admin1',
        displayName: null,
      },
    }));

    expect(historyEvent.eventSummary).toBe('admin1查看了分析记录 46436ac31b8449e3876430a7b518a8b3 的相关新闻');

    const taskEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/analysis/tasks?limit=100',
      moduleCode: 'analysis',
      action: 'read',
      queryMasked: {
        limit: 100,
      },
    }));

    expect(taskEvent).toMatchObject({
      eventType: 'analysis_task_list',
      eventSummary: 'surper1查看了分析任务列表',
      targetLabel: '最近 100 条',
    });
  });

  it('resolves target usernames for admin reset password events', () => {
    const event = buildAdminLogEventView(createInput({
      method: 'POST',
      path: '/api/v1/admin/users/12/reset-password',
      moduleCode: 'admin_user',
      action: 'write',
    }), {
      adminUserLabels: new Map([[12, 'admin1']]),
    });

    expect(event).toMatchObject({
      eventType: 'admin_user_reset_password',
      eventSummary: 'surper1重置了用户 admin1 的密码',
      moduleLabel: '用户管理',
      targetLabel: 'admin1',
    });
  });

  it('renders readable admin user list and detail summaries for GET requests', () => {
    const listEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/admin/users?keyword=adm',
      moduleCode: 'admin_user',
      action: 'read',
      queryMasked: {
        keyword: 'adm',
      },
    }));

    expect(listEvent).toMatchObject({
      eventType: 'admin_user_list',
      eventSummary: 'surper1查看了用户列表',
      moduleLabel: '用户管理',
      targetLabel: '关键词：adm',
    });
    expectReadableSummary(listEvent.eventSummary);

    const detailEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/admin/users/12',
      moduleCode: 'admin_user',
      action: 'read',
      responseMasked: {
        id: 12,
        username: 'admin1',
      },
    }));

    expect(detailEvent).toMatchObject({
      eventType: 'admin_user_detail',
      eventSummary: 'surper1查看了用户详情：admin1',
      moduleLabel: '用户管理',
      targetLabel: 'admin1',
    });
    expectReadableSummary(detailEvent.eventSummary);
  });

  it('renders readable admin role CRUD summaries', () => {
    const listEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/admin/roles?keyword=trade',
      moduleCode: 'admin_role',
      action: 'read',
      queryMasked: {
        keyword: 'trade',
      },
    }));

    expect(listEvent).toMatchObject({
      eventType: 'admin_role_list',
      eventSummary: 'surper1查看了角色列表',
      moduleLabel: '角色管理',
      targetLabel: '关键词：trade',
    });
    expectReadableSummary(listEvent.eventSummary);

    const detailEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/admin/roles/9',
      moduleCode: 'admin_role',
      action: 'read',
      responseMasked: {
        id: 9,
        role_name: '交易员',
      },
    }));

    expect(detailEvent).toMatchObject({
      eventType: 'admin_role_detail',
      eventSummary: 'surper1查看了角色详情：交易员',
      moduleLabel: '角色管理',
      targetLabel: '交易员',
    });
    expectReadableSummary(detailEvent.eventSummary);

    const createEvent = buildAdminLogEventView(createInput({
      method: 'POST',
      path: '/api/v1/admin/roles',
      moduleCode: 'admin_role',
      action: 'write',
      bodyMasked: {
        role_name: '交易员',
        role_code: 'trader',
      },
      responseMasked: {
        id: 9,
        role_name: '交易员',
      },
    }));

    expect(createEvent).toMatchObject({
      eventType: 'admin_role_create',
      eventSummary: 'surper1创建了角色 交易员',
      targetLabel: '交易员',
    });
    expectReadableSummary(createEvent.eventSummary);

    const updateEvent = buildAdminLogEventView(createInput({
      method: 'PUT',
      path: '/api/v1/admin/roles/9',
      moduleCode: 'admin_role',
      action: 'write',
      bodyMasked: {
        role_name: '交易员',
      },
      responseMasked: {
        id: 9,
        role_name: '交易员',
      },
    }));

    expect(updateEvent).toMatchObject({
      eventType: 'admin_role_update',
      eventSummary: 'surper1更新了角色 交易员',
      targetLabel: '交易员',
    });
    expectReadableSummary(updateEvent.eventSummary);

    const deleteEvent = buildAdminLogEventView(createInput({
      method: 'DELETE',
      path: '/api/v1/admin/roles/9',
      moduleCode: 'admin_role',
      action: 'write',
    }));

    expect(deleteEvent).toMatchObject({
      eventType: 'admin_role_delete',
      eventSummary: 'surper1删除了角色 9',
      targetLabel: '9',
    });
    expectReadableSummary(deleteEvent.eventSummary);
  });

  it('formats config changes without leaking secret values', () => {
    const event = buildAdminLogEventView(createInput({
      userId: 1,
      usernameSnapshot: 'admin',
      method: 'PUT',
      path: '/api/v1/system/config',
      moduleCode: 'system_config',
      action: 'write',
      bodyMasked: {
        items: [
          { key: 'ADMIN_REGISTER_SECRET', value: '[REDACTED]' },
          { key: 'BACKTEST_EVAL_WINDOW_DAYS', value: '30' },
        ],
      },
      user: {
        id: 1,
        username: 'admin',
        displayName: '管理员',
      },
    }));

    expect(event.moduleLabel).toBe('配置管理');
    expect(event.eventSummary).toContain('管理员注册密钥');
    expect(event.eventSummary).toContain('回测评估窗口');
    expect(event.eventSummary).not.toContain('[REDACTED]');
    expect(event.eventSummary).not.toContain('123123');
  });

  it('marks base and backtest config changes as strategy parameters', () => {
    const event = buildAdminLogEventView(createInput({
      userId: 1,
      usernameSnapshot: 'admin',
      method: 'PUT',
      path: '/api/v1/system/config',
      moduleCode: 'system_config',
      action: 'write',
      bodyMasked: {
        items: [
          { key: 'BACKTEST_EVAL_WINDOW_DAYS', value: '30' },
          { key: 'ANALYSIS_AUTO_ORDER_ENABLED', value: 'true' },
        ],
      },
      user: {
        id: 1,
        username: 'admin',
        displayName: null,
      },
    }));

    expect(event.moduleLabel).toBe('策略参数');
    expect(event.eventSummary).toContain('回测评估窗口');
    expect(event.eventSummary).toContain('分析后自动下单');
  });

  it('builds readable backtest events and keeps generic fallbacks human-friendly', () => {
    const compareEvent = buildAdminLogEventView(createInput({
      userId: 11,
      usernameSnapshot: 'admin1',
      method: 'POST',
      path: '/api/v1/backtest/compare',
      moduleCode: 'backtest',
      action: 'write',
      bodyMasked: {
        code: '600519',
        eval_window_days_list: [5, 10, 20],
      },
      user: {
        id: 11,
        username: 'admin1',
        displayName: null,
      },
    }));

    expect(compareEvent).toMatchObject({
      eventType: 'backtest_compare',
      eventSummary: 'admin1比较了股票 600519 的回测窗口对比',
      targetLabel: '5 日、10 日、20 日',
    });

    const fallbackEvent = buildAdminLogEventView(createInput({
      userId: 11,
      usernameSnapshot: 'admin1',
      path: '/api/v1/admin/logs',
      moduleCode: 'admin_log',
      action: 'read',
      user: {
        id: 11,
        username: 'admin1',
        displayName: null,
      },
    }));

    expect(fallbackEvent.eventSummary).toBe('admin1查看了日志列表');
    expect(fallbackEvent.eventSummary).not.toContain('GET');
    expect(fallbackEvent.eventSummary).not.toContain('/api/v1/admin/logs');
  });

  it('renders readable scheduler, auth, admin logs, and system config summaries', () => {
    const retryEvent = buildAdminLogEventView(createInput({
      method: 'POST',
      path: '/api/v1/analysis/scheduler/tasks/task-123/retry',
      moduleCode: 'analysis',
      action: 'write',
    }));

    expect(retryEvent).toMatchObject({
      eventType: 'scheduler_task_retry',
      eventSummary: 'surper1重试了调度任务 task-123',
      moduleLabel: '调度中心',
      targetLabel: 'task-123',
    });
    expectReadableSummary(retryEvent.eventSummary);

    const rerunEvent = buildAdminLogEventView(createInput({
      method: 'POST',
      path: '/api/v1/analysis/scheduler/tasks/task-123/rerun',
      moduleCode: 'analysis',
      action: 'write',
    }));

    expect(rerunEvent.eventSummary).toBe('surper1重新运行了调度任务 task-123');
    expectReadableSummary(rerunEvent.eventSummary);

    const cancelEvent = buildAdminLogEventView(createInput({
      method: 'POST',
      path: '/api/v1/analysis/scheduler/tasks/task-123/cancel',
      moduleCode: 'analysis',
      action: 'write',
    }));

    expect(cancelEvent.eventSummary).toBe('surper1取消了调度任务 task-123');
    expectReadableSummary(cancelEvent.eventSummary);

    const priorityEvent = buildAdminLogEventView(createInput({
      method: 'PATCH',
      path: '/api/v1/analysis/scheduler/tasks/task-123/priority',
      moduleCode: 'analysis',
      action: 'write',
      bodyMasked: {
        priority: 3,
      },
    }));

    expect(priorityEvent).toMatchObject({
      eventType: 'scheduler_task_priority',
      eventSummary: 'surper1调整了调度任务 task-123 的优先级 3',
      targetLabel: 'task-123',
    });
    expectReadableSummary(priorityEvent.eventSummary);

    const statusEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/analysis/status/task-123',
      moduleCode: 'analysis',
      action: 'read',
    }));

    expect(statusEvent).toMatchObject({
      eventType: 'analysis_task_status',
      eventSummary: 'surper1查看了分析任务 task-123 的状态',
      targetLabel: 'task-123',
    });
    expectReadableSummary(statusEvent.eventSummary);

    const streamEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/analysis/tasks/task-123/stages/stream',
      moduleCode: 'analysis',
      action: 'read',
    }));

    expect(streamEvent).toMatchObject({
      eventType: 'analysis_task_stage_stream',
      eventSummary: 'surper1订阅了分析任务 task-123 的执行阶段动态',
      targetLabel: 'task-123',
    });
    expectReadableSummary(streamEvent.eventSummary);

    const logoutEvent = buildAdminLogEventView(createInput({
      method: 'POST',
      path: '/api/v1/auth/logout',
      moduleCode: 'auth',
      action: 'write',
    }));

    expect(logoutEvent).toMatchObject({
      eventType: 'auth_logout',
      eventSummary: 'surper1退出了系统',
      moduleLabel: '认证',
    });
    expectReadableSummary(logoutEvent.eventSummary);

    const adminLogListEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/admin/logs?module_code=admin_user',
      moduleCode: 'admin_log',
      action: 'read',
      queryMasked: {
        module_code: 'admin_user',
      },
    }));

    expect(adminLogListEvent).toMatchObject({
      eventType: 'admin_log_list',
      eventSummary: 'surper1查看了日志列表',
      moduleLabel: '日志管理',
      targetLabel: '模块：用户管理',
    });
    expectReadableSummary(adminLogListEvent.eventSummary);

    const adminLogDetailEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/admin/logs/88',
      moduleCode: 'admin_log',
      action: 'read',
    }));

    expect(adminLogDetailEvent).toMatchObject({
      eventType: 'admin_log_detail',
      eventSummary: 'surper1查看了日志 #88 详情',
      targetLabel: '日志 #88',
    });
    expectReadableSummary(adminLogDetailEvent.eventSummary);

    const configViewEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/system/config?include_schema=true',
      moduleCode: 'system_config',
      action: 'read',
      queryMasked: {
        include_schema: true,
      },
    }));

    expect(configViewEvent).toMatchObject({
      eventType: 'system_config_view',
      eventSummary: 'surper1查看了系统配置',
      moduleLabel: '配置管理',
      targetLabel: '包含配置结构',
    });
    expectReadableSummary(configViewEvent.eventSummary);

    const configSchemaEvent = buildAdminLogEventView(createInput({
      path: '/api/v1/system/config/schema',
      moduleCode: 'system_config',
      action: 'read',
    }));

    expect(configSchemaEvent).toMatchObject({
      eventType: 'system_config_schema',
      eventSummary: 'surper1查看了配置结构',
      moduleLabel: '配置管理',
    });
    expectReadableSummary(configSchemaEvent.eventSummary);
  });
});
