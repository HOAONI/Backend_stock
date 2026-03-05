import * as fs from 'node:fs';
import * as path from 'node:path';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface ApiResponse {
  status: number;
  json: unknown;
  raw: string;
  headers: Headers;
}

const DEFAULT_BASE_URL = process.env.BACKEND_BASE_URL || 'http://127.0.0.1:8002';
const DEFAULT_REPORT = path.resolve(process.cwd(), 'docs/GAP_VALIDATION_REPORT.md');
const STOCK_CODE = process.env.E2E_STOCK_CODE || '600519';
const E2E_USERNAME = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_INIT_USERNAME || 'admin';
const E2E_PASSWORD = process.env.E2E_ADMIN_PASSWORD || process.env.ADMIN_INIT_PASSWORD || 'BackendE2E#2026';
const E2E_REQUIRE_COMPLETED = String(process.env.E2E_REQUIRE_COMPLETED || 'false').toLowerCase() === 'true';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asArray<T = unknown>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  return [];
}

function pickSetCookie(headers: Headers): string[] {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === 'function') {
    return anyHeaders.getSetCookie();
  }
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

async function readSseEvents(
  baseUrl: string,
  cookie: string,
  durationMs: number,
  route = '/api/v1/analysis/tasks/stream',
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  const events: string[] = [];

  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Cookie: cookie,
      },
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      return events;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = 'message';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line) {
          if (currentEvent) {
            events.push(currentEvent);
          }
          currentEvent = 'message';
        } else if (line.startsWith('event:')) {
          currentEvent = line.slice('event:'.length).trim();
        }
        index = buffer.indexOf('\n');
      }
    }
  } catch {
    // Ignore SSE timeout/abort/network errors; caller interprets captured events.
  } finally {
    clearTimeout(timer);
  }

  return events;
}

async function main(): Promise<void> {
  const reportFile = path.resolve(process.argv[2] || DEFAULT_REPORT);
  const baseUrl = process.argv[3] || DEFAULT_BASE_URL;

  const checks: CheckResult[] = [];
  let cookie = '';

  const request = async (route: string, init: RequestInit = {}): Promise<ApiResponse> => {
    const headers = new Headers(init.headers ?? {});
    if (cookie) {
      headers.set('Cookie', cookie);
    }
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    const response = await fetch(`${baseUrl}${route}`, {
      ...init,
      headers,
    });

    const setCookies = pickSetCookie(response.headers);
    if (setCookies.length > 0) {
      cookie = setCookies.map((item) => item.split(';')[0]).join('; ');
    }

    const raw = await response.text();
    let json: unknown = null;
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = raw;
      }
    }

    return {
      status: response.status,
      json,
      raw,
      headers: response.headers,
    };
  };

  const push = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };

  const health = await request('/api/health');
  push('health', health.status === 200 ? 'pass' : 'fail', `status=${health.status}`);

  const authStatus0 = await request('/api/v1/auth/status');
  const auth0 = asRecord(authStatus0.json);
  push(
    'auth-status-initial',
    authStatus0.status === 200 ? 'pass' : 'fail',
    `status=${authStatus0.status}, authEnabled=${String(auth0.authEnabled)}, passwordSet=${String(auth0.passwordSet)}`,
  );

  const invalidLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: E2E_USERNAME, password: `${E2E_PASSWORD}_wrong` }),
  });
  push('auth-login-invalid', invalidLogin.status === 401 ? 'pass' : 'warn', `status=${invalidLogin.status}`);

  const login = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: E2E_USERNAME, password: E2E_PASSWORD }),
  });
  push('auth-login', login.status === 200 ? 'pass' : 'fail', `status=${login.status}`);

  const authStatus1 = await request('/api/v1/auth/status');
  const auth1 = asRecord(authStatus1.json);
  push(
    'auth-status-logged-in',
    authStatus1.status === 200 && auth1.loggedIn === true ? 'pass' : 'fail',
    `status=${authStatus1.status}, loggedIn=${String(auth1.loggedIn)}`,
  );

  const adminCookieSnapshot = cookie;
  const registerUsername = `e2e_register_${Date.now().toString(36)}`;
  const registerPassword = 'E2ERegister#2026';
  const registerResp = await request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: registerUsername,
      password: registerPassword,
      confirmPassword: registerPassword,
      displayName: 'E2E Register User',
    }),
  });
  if (registerResp.status === 201) {
    const registerPayload = asRecord(registerResp.json);
    const currentUser = asRecord(registerPayload.currentUser);
    const roles = asArray<string>(currentUser.roles);
    push(
      'auth-register',
      roles.includes('analyst') ? 'pass' : 'warn',
      `status=${registerResp.status}, roles=${roles.join(',') || '(none)'}`,
    );

    const registerDup = await request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: registerUsername,
        password: registerPassword,
        confirmPassword: registerPassword,
      }),
    });
    push('auth-register-duplicate', registerDup.status === 409 ? 'pass' : 'warn', `status=${registerDup.status}`);

    const settingsGet = await request('/api/v1/users/me/settings');
    push('user-settings-get', settingsGet.status === 200 ? 'pass' : 'warn', `status=${settingsGet.status}`);

    const settingsUpdatePayload: Record<string, unknown> = {
      simulation: {
        accountName: 'E2E SIM',
        accountId: 'e2e-account',
        initialCapital: 120000,
        note: 'e2e update',
      },
      ai: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
      },
      strategy: {
        positionMaxPct: 35,
        stopLossPct: 9,
        takeProfitPct: 18,
      },
    };

    if (process.env.PERSONAL_SECRET_KEY) {
      settingsUpdatePayload.ai = {
        ...(settingsUpdatePayload.ai as Record<string, unknown>),
        apiToken: 'e2e-personal-token',
      };
    }

    const settingsPut = await request('/api/v1/users/me/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsUpdatePayload),
    });
    push('user-settings-update', settingsPut.status === 200 ? 'pass' : 'warn', `status=${settingsPut.status}`);

    if (settingsPut.status === 200 && process.env.PERSONAL_SECRET_KEY) {
      const settingsPayload = asRecord(settingsPut.json);
      const ai = asRecord(settingsPayload.ai);
      const hasToken = ai.hasToken === true;
      const masked = String(ai.apiTokenMasked ?? '');
      push(
        'user-settings-token-masked',
        hasToken && masked === '******' ? 'pass' : 'warn',
        `hasToken=${String(hasToken)}, masked=${masked || '(empty)'}`,
      );
    }

    await request('/api/v1/auth/logout', { method: 'POST' });
    cookie = adminCookieSnapshot;
  } else if (registerResp.status === 404) {
    push('auth-register', 'warn', 'self register disabled (404)');
  } else {
    push('auth-register', 'warn', `status=${registerResp.status}`);
  }

  const rolesList = await request('/api/v1/admin/roles?page=1&limit=20');
  push('admin-roles-list', rolesList.status === 200 ? 'pass' : 'fail', `status=${rolesList.status}`);

  const dynamicRoleCode = `e2e_role_${Date.now().toString(36)}`;
  const roleCreate = await request('/api/v1/admin/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role_code: dynamicRoleCode,
      role_name: 'E2E Role',
      description: 'temporary role for e2e validation',
      permissions: [
        { module_code: 'history', can_read: true, can_write: false },
        { module_code: 'admin_log', can_read: true, can_write: false },
      ],
    }),
  });
  const roleCreatePayload = asRecord(roleCreate.json);
  const createdRoleId = Number(roleCreatePayload.id ?? 0);
  push(
    'admin-role-create',
    [200, 201].includes(roleCreate.status) && createdRoleId > 0 ? 'pass' : 'warn',
    `status=${roleCreate.status}, roleId=${createdRoleId || '(none)'}`,
  );

  const dynamicUserName = `e2e_user_${Date.now().toString(36)}`;
  const dynamicUserPassword = 'E2EUser#2026';
  const userCreate = await request('/api/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: dynamicUserName,
      password: dynamicUserPassword,
      display_name: 'E2E User',
      role_codes: [dynamicRoleCode],
      status: 'active',
    }),
  });
  const userCreatePayload = asRecord(userCreate.json);
  const createdUserId = Number(userCreatePayload.id ?? 0);
  push(
    'admin-user-create',
    [200, 201].includes(userCreate.status) && createdUserId > 0 ? 'pass' : 'warn',
    `status=${userCreate.status}, userId=${createdUserId || '(none)'}`,
  );

  if (createdRoleId > 0) {
    const deleteRoleConflict = await request(`/api/v1/admin/roles/${createdRoleId}`, { method: 'DELETE' });
    push(
      'admin-role-delete-conflict',
      deleteRoleConflict.status === 409 ? 'pass' : 'warn',
      `status=${deleteRoleConflict.status}`,
    );
  } else {
    push('admin-role-delete-conflict', 'warn', 'role not created');
  }

  if (createdUserId > 0) {
    const disableUser = await request(`/api/v1/admin/users/${createdUserId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    push('admin-user-disable', disableUser.status === 200 ? 'pass' : 'warn', `status=${disableUser.status}`);

    const deleteUser = await request(`/api/v1/admin/users/${createdUserId}`, { method: 'DELETE' });
    push('admin-user-delete', deleteUser.status === 200 ? 'pass' : 'warn', `status=${deleteUser.status}`);
  } else {
    push('admin-user-disable', 'warn', 'user not created');
    push('admin-user-delete', 'warn', 'user not created');
  }

  if (createdRoleId > 0) {
    const deleteRoleAfterUserRemoved = await request(`/api/v1/admin/roles/${createdRoleId}`, { method: 'DELETE' });
    push(
      'admin-role-delete',
      deleteRoleAfterUserRemoved.status === 200 ? 'pass' : 'warn',
      `status=${deleteRoleAfterUserRemoved.status}`,
    );
  } else {
    push('admin-role-delete', 'warn', 'role not created');
  }

  const analystUsername = `e2e_analyst_${Date.now().toString(36)}`;
  const analystPassword = 'E2EAnalyst#2026';
  const analystCreate = await request('/api/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: analystUsername,
      password: analystPassword,
      display_name: 'E2E Analyst',
      role_codes: ['analyst'],
      status: 'active',
    }),
  });
  const analystPayload = asRecord(analystCreate.json);
  const analystUserId = Number(analystPayload.id ?? 0);
  push(
    'admin-analyst-create',
    [200, 201].includes(analystCreate.status) && analystUserId > 0 ? 'pass' : 'warn',
    `status=${analystCreate.status}, userId=${analystUserId || '(none)'}`,
  );

  const logoutForRoleCheck = await request('/api/v1/auth/logout', { method: 'POST' });
  push('rbac-logout-admin', logoutForRoleCheck.status === 204 ? 'pass' : 'warn', `status=${logoutForRoleCheck.status}`);

  const analystLogin = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: analystUsername, password: analystPassword }),
  });
  push('rbac-login-analyst', analystLogin.status === 200 ? 'pass' : 'warn', `status=${analystLogin.status}`);

  const analystForbidden = await request('/api/v1/system/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config_version: 'invalid-version',
      mask_token: '******',
      reload_now: false,
      items: [{ key: 'CORS_ALLOW_ALL', value: 'false' }],
    }),
  });
  push(
    'rbac-analyst-write-system',
    analystForbidden.status === 403 ? 'pass' : 'warn',
    `status=${analystForbidden.status}`,
  );

  const logoutAnalyst = await request('/api/v1/auth/logout', { method: 'POST' });
  push('rbac-logout-analyst', logoutAnalyst.status === 204 ? 'pass' : 'warn', `status=${logoutAnalyst.status}`);

  const reloginAdmin = await request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: E2E_USERNAME, password: E2E_PASSWORD }),
  });
  push('rbac-relogin-admin', reloginAdmin.status === 200 ? 'pass' : 'warn', `status=${reloginAdmin.status}`);

  if (analystUserId > 0) {
    await request(`/api/v1/admin/users/${analystUserId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    const analystDelete = await request(`/api/v1/admin/users/${analystUserId}`, { method: 'DELETE' });
    push('admin-analyst-delete', analystDelete.status === 200 ? 'pass' : 'warn', `status=${analystDelete.status}`);
  } else {
    push('admin-analyst-delete', 'warn', 'analyst user not created');
  }

  const ssePromise = readSseEvents(baseUrl, cookie, 25000);

  const asyncCreate = await request('/api/v1/analysis/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stock_code: STOCK_CODE,
      report_type: 'detailed',
      force_refresh: true,
      async_mode: true,
    }),
  });
  const asyncPayload = asRecord(asyncCreate.json);
  const taskId = String(asyncPayload.task_id ?? '');
  const stageStreamRoute = taskId ? `/api/v1/analysis/tasks/${encodeURIComponent(taskId)}/stages/stream` : '';
  const stageSsePromise = stageStreamRoute
    ? readSseEvents(baseUrl, cookie, 25000, stageStreamRoute)
    : Promise.resolve([]);
  push(
    'analysis-async-submit',
    asyncCreate.status === 202 && taskId.length > 0 ? 'pass' : 'fail',
    `status=${asyncCreate.status}, taskId=${taskId || '(none)'}`,
  );

  const brokerInvalid = await request('/api/v1/analysis/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stock_code: '000001',
      report_type: 'detailed',
      force_refresh: true,
      async_mode: true,
      execution_mode: 'broker',
      broker_account_id: 99999999,
    }),
  });
  push(
    'analysis-broker-invalid-account',
    brokerInvalid.status === 400 ? 'pass' : 'warn',
    `status=${brokerInvalid.status}`,
  );

  const duplicate = await request('/api/v1/analysis/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stock_code: STOCK_CODE,
      report_type: 'detailed',
      force_refresh: true,
      async_mode: true,
    }),
  });
  push(
    'analysis-duplicate-guard',
    duplicate.status === 409 ? 'pass' : 'warn',
    `status=${duplicate.status}`,
  );

  let lastStatus = '';
  let terminalPayload: Record<string, unknown> = {};
  if (taskId) {
    for (let i = 0; i < 90; i += 1) {
      const statusResp = await request(`/api/v1/analysis/status/${encodeURIComponent(taskId)}`);
      const payload = asRecord(statusResp.json);
      lastStatus = String(payload.status ?? '');
      terminalPayload = payload;
      if (['completed', 'failed'].includes(lastStatus)) {
        break;
      }
      await sleep(1000);
    }
  }

  if (lastStatus === 'completed') {
    push('analysis-async-terminal', 'pass', 'task reached completed');
  } else if (lastStatus === 'failed') {
    push(
      'analysis-async-terminal',
      E2E_REQUIRE_COMPLETED ? 'warn' : 'pass',
      E2E_REQUIRE_COMPLETED
        ? 'task reached failed (pipeline or external provider issue)'
        : 'task reached failed (terminal status accepted in non-strict mode)',
    );
  } else {
    push('analysis-async-terminal', 'fail', `task did not reach terminal status, last=${lastStatus || '(none)'}`);
  }

  if (lastStatus === 'failed') {
    const taskError = String(terminalPayload.error ?? '');
    const hasAbortLiteral = /This operation was aborted/i.test(taskError);
    push(
      'analysis-failed-message-quality',
      hasAbortLiteral ? 'warn' : 'pass',
      hasAbortLiteral ? `error still contains abort literal: ${taskError.slice(0, 120)}` : `error=${taskError.slice(0, 120) || '(empty)'}`,
    );
  } else {
    push('analysis-failed-message-quality', 'pass', `terminal=${lastStatus || '(none)'}`);
  }

  const sseEvents = await ssePromise;
  const hasConnected = sseEvents.includes('connected');
  const hasCreated = sseEvents.includes('task_created');
  const hasTerminalEvent = sseEvents.some((event) => ['task_completed', 'task_failed'].includes(event));
  push(
    'analysis-sse-sequence',
    hasConnected && hasCreated ? 'pass' : 'warn',
    `events=${sseEvents.join(', ') || '(none)'}`,
  );
  push(
    'analysis-sse-terminal-event',
    hasTerminalEvent ? 'pass' : 'warn',
    `events=${sseEvents.join(', ') || '(none)'}`,
  );

  const tasks = await request('/api/v1/analysis/tasks?limit=20');
  push('analysis-task-list', tasks.status === 200 ? 'pass' : 'fail', `status=${tasks.status}`);

  const history = await request('/api/v1/history?page=1&limit=20');
  push('history-list', history.status === 200 ? 'pass' : 'fail', `status=${history.status}`);

  const resultPayload = asRecord(terminalPayload.result);
  const queryId = String(resultPayload.query_id ?? taskId);
  if (queryId) {
    const detail = await request(`/api/v1/history/${encodeURIComponent(queryId)}`);
    const news = await request(`/api/v1/history/${encodeURIComponent(queryId)}/news?limit=20`);
    push('history-detail', detail.status === 200 || detail.status === 404 ? 'pass' : 'warn', `status=${detail.status}`);
    push('history-news', news.status === 200 ? 'pass' : 'warn', `status=${news.status}`);
  } else {
    push('history-detail', 'warn', 'missing query_id from task result');
    push('history-news', 'warn', 'missing query_id from task result');
  }

  if (taskId) {
    const taskStages = await request(`/api/v1/analysis/tasks/${encodeURIComponent(taskId)}/stages`);
    push('analysis-task-stages', taskStages.status === 200 ? 'pass' : 'warn', `status=${taskStages.status}`);
  } else {
    push('analysis-task-stages', 'warn', 'missing task_id');
  }

  const stageSseEvents = await stageSsePromise;
  const hasStageConnected = stageSseEvents.includes('connected');
  const hasStageUpdate = stageSseEvents.includes('stage_update');
  push(
    'analysis-stage-sse-sequence',
    hasStageConnected && hasStageUpdate ? 'pass' : 'warn',
    `events=${stageSseEvents.join(', ') || '(none)'}`,
  );

  const configResp = await request('/api/v1/system/config?include_schema=true');
  const schemaResp = await request('/api/v1/system/config/schema');
  const validateResp = await request('/api/v1/system/config/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ key: 'CORS_ALLOW_ALL', value: 'false' }],
    }),
  });
  push('system-config-get', configResp.status === 200 ? 'pass' : 'fail', `status=${configResp.status}`);
  push('system-config-schema', schemaResp.status === 200 ? 'pass' : 'fail', `status=${schemaResp.status}`);
  push('system-config-validate', validateResp.status === 200 ? 'pass' : 'fail', `status=${validateResp.status}`);

  const brokerAccountsList = await request('/api/v1/users/me/broker-accounts');
  const tradingSummary = await request('/api/v1/users/me/trading/account-summary');
  const tradingPositions = await request('/api/v1/users/me/trading/positions');
  const tradingOrders = await request('/api/v1/users/me/trading/orders');
  const tradingTrades = await request('/api/v1/users/me/trading/trades');
  const tradingPerformance = await request('/api/v1/users/me/trading/performance');
  const agentBridgeEndpoint = await request('/api/v1/internal/agent/credential-tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: 1, scope: 'read' }),
  });
  push(
    'broker-accounts-list-removed',
    brokerAccountsList.status === 404 ? 'pass' : 'warn',
    `status=${brokerAccountsList.status}`,
  );
  push(
    'trading-account-summary',
    [200, 404].includes(tradingSummary.status) ? 'pass' : 'warn',
    `status=${tradingSummary.status}`,
  );
  push(
    'trading-positions',
    [200, 404].includes(tradingPositions.status) ? 'pass' : 'warn',
    `status=${tradingPositions.status}`,
  );
  push(
    'trading-orders',
    [200, 404].includes(tradingOrders.status) ? 'pass' : 'warn',
    `status=${tradingOrders.status}`,
  );
  push(
    'trading-trades',
    [200, 404].includes(tradingTrades.status) ? 'pass' : 'warn',
    `status=${tradingTrades.status}`,
  );
  push(
    'trading-performance',
    [200, 404].includes(tradingPerformance.status) ? 'pass' : 'warn',
    `status=${tradingPerformance.status}`,
  );
  push(
    'agent-bridge-endpoint-removed',
    agentBridgeEndpoint.status === 404 ? 'pass' : 'warn',
    `status=${agentBridgeEndpoint.status}`,
  );

  const configData = asRecord(configResp.json);
  const staleVersion = `${String(configData.config_version ?? '')}_stale`;
  const conflictResp = await request('/api/v1/system/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config_version: staleVersion,
      mask_token: '******',
      reload_now: false,
      items: [{ key: 'CORS_ALLOW_ALL', value: 'false' }],
    }),
  });
  push('system-config-version-conflict', conflictResp.status === 409 ? 'pass' : 'warn', `status=${conflictResp.status}`);

  const backtestResults = await request('/api/v1/backtest/results?page=1&limit=20');
  const backtestPerf = await request('/api/v1/backtest/performance');
  push('backtest-results', backtestResults.status === 200 ? 'pass' : 'warn', `status=${backtestResults.status}`);
  push(
    'backtest-performance',
    [200, 404].includes(backtestPerf.status) ? 'pass' : 'warn',
    `status=${backtestPerf.status}`,
  );
  const backtestCurves = await request('/api/v1/backtest/curves?scope=overall&eval_window_days=10');
  const backtestDistribution = await request('/api/v1/backtest/distribution?scope=overall&eval_window_days=10');
  const backtestCompare = await request('/api/v1/backtest/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eval_window_days_list: [5, 10, 20],
      strategy_codes: ['agent_v1', 'ma20_trend', 'rsi14_mean_reversion'],
    }),
  });
  const backtestCurvesStockMissingCode = await request('/api/v1/backtest/curves?scope=stock&eval_window_days=10');
  const backtestComparePayload = asRecord(backtestCompare.json);
  const backtestCompareItems = asArray<Record<string, unknown>>(backtestComparePayload.items);
  const compareRowsExpected = 3 * 3;
  const compareHasStrategyFields = backtestCompareItems.every(
    (item) => typeof item.strategy_code === 'string' && typeof item.strategy_name === 'string',
  );
  push('backtest-curves', backtestCurves.status === 200 ? 'pass' : 'warn', `status=${backtestCurves.status}`);
  push(
    'backtest-distribution',
    backtestDistribution.status === 200 ? 'pass' : 'warn',
    `status=${backtestDistribution.status}`,
  );
  push('backtest-compare', backtestCompare.status === 200 ? 'pass' : 'warn', `status=${backtestCompare.status}`);
  push(
    'backtest-compare-structure',
    backtestCompare.status === 200 && compareHasStrategyFields && backtestCompareItems.length === compareRowsExpected ? 'pass' : 'warn',
    `status=${backtestCompare.status}, rows=${backtestCompareItems.length}, expected=${compareRowsExpected}, strategyFields=${compareHasStrategyFields}`,
  );
  push(
    'backtest-curves-stock-missing-code',
    backtestCurvesStockMissingCode.status === 400 ? 'pass' : 'warn',
    `status=${backtestCurvesStockMissingCode.status}`,
  );

  const invalidPeriod = await request(`/api/v1/stocks/${encodeURIComponent(STOCK_CODE)}/history?period=weekly&days=30`);
  push('stocks-invalid-period', invalidPeriod.status === 422 ? 'pass' : 'warn', `status=${invalidPeriod.status}`);
  const stockIndicators = await request(`/api/v1/stocks/${encodeURIComponent(STOCK_CODE)}/indicators?period=daily&days=120&windows=5,10,20,60`);
  const stockFactors = await request(`/api/v1/stocks/${encodeURIComponent(STOCK_CODE)}/factors`);
  const stockIndicatorsInvalidPeriod = await request(
    `/api/v1/stocks/${encodeURIComponent(STOCK_CODE)}/indicators?period=weekly&days=30&windows=5,10`,
  );
  push('stocks-indicators', stockIndicators.status === 200 ? 'pass' : 'warn', `status=${stockIndicators.status}`);
  push('stocks-factors', stockFactors.status === 200 ? 'pass' : 'warn', `status=${stockFactors.status}`);
  push(
    'stocks-indicators-invalid-period',
    stockIndicatorsInvalidPeriod.status === 422 ? 'pass' : 'warn',
    `status=${stockIndicatorsInvalidPeriod.status}`,
  );

  const extractNoFile = await request('/api/v1/stocks/extract-from-image', { method: 'POST' });
  push('stocks-extract-no-file', extractNoFile.status === 400 ? 'pass' : 'warn', `status=${extractNoFile.status}`);

  const logs = await request('/api/v1/admin/logs?page=1&limit=20');
  const logsPayload = asRecord(logs.json);
  const logItems = asArray<Record<string, unknown>>(logsPayload.items);
  push('admin-logs-list', logs.status === 200 ? 'pass' : 'warn', `status=${logs.status}, count=${logItems.length}`);

  if (logs.status === 200 && logItems.length > 0) {
    const firstId = Number(logItems[0]?.id ?? 0);
    const logDetail = await request(`/api/v1/admin/logs/${firstId}`);
    push('admin-logs-detail', logDetail.status === 200 ? 'pass' : 'warn', `status=${logDetail.status}`);
  } else {
    push('admin-logs-detail', 'warn', 'no log record to inspect');
  }

  const logout = await request('/api/v1/auth/logout', { method: 'POST' });
  push('auth-logout', logout.status === 204 ? 'pass' : 'warn', `status=${logout.status}`);

  const protectedAfterLogout = await request('/api/v1/system/config');
  push(
    'auth-protected-after-logout',
    protectedAfterLogout.status === 401 ? 'pass' : 'warn',
    `status=${protectedAfterLogout.status}`,
  );

  const passCount = checks.filter((item) => item.status === 'pass').length;
  const warnCount = checks.filter((item) => item.status === 'warn').length;
  const failCount = checks.filter((item) => item.status === 'fail').length;

  const lines: string[] = [];
  lines.push('# End-to-End Validation Report');
  lines.push('');
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push(`- Base URL: \`${baseUrl}\``);
  lines.push(`- Stock code: \`${STOCK_CODE}\``);
  lines.push(`- Summary: pass=${passCount}, warn=${warnCount}, fail=${failCount}`);
  lines.push('');
  lines.push('| Check | Result | Detail |');
  lines.push('| --- | --- | --- |');
  for (const item of checks) {
    lines.push(`| ${item.name} | ${item.status} | ${item.detail} |`);
  }
  lines.push('');

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, lines.join('\n'), 'utf8');

  console.log(`E2E report written: ${reportFile}`);
  console.log(`pass=${passCount}, warn=${warnCount}, fail=${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
