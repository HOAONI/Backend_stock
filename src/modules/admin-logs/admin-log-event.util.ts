/** 后台审计日志模块的辅助函数集合，用于承载可复用的数据映射与格式化逻辑。 */

interface AdminLogActor {
  id: number;
  username: string;
  displayName: string | null;
}

export interface AdminLogEventInput {
  userId: number | null;
  usernameSnapshot: string | null;
  method: string;
  path: string;
  moduleCode: string | null;
  action: string | null;
  success: boolean;
  bodyMasked: unknown;
  queryMasked: unknown;
  responseMasked: unknown;
  user?: AdminLogActor | null;
}

export interface AdminLogEventLookup {
  adminUserLabels?: Map<number, string>;
}

export interface AdminLogEventView {
  eventType: string;
  eventSummary: string;
  moduleLabel: string;
  resultLabel: '成功' | '失败';
  targetLabel: string | null;
  actorLabel: string;
  username: string;
}

interface AdminLogEventContext {
  input: AdminLogEventInput;
  actorLabel: string;
  username: string;
  normalizedPath: string;
  pathSegments: string[];
  searchParams: URLSearchParams;
  body: Record<string, unknown> | null;
  query: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
}

const MODULE_LABEL_MAP: Record<string, string> = {
  analysis: '股票分析',
  history: '历史记录',
  stocks: '股票数据',
  backtest: '回测分析',
  system_config: '配置管理',
  user_settings: '用户设置',
  broker_account: '模拟账户',
  trading_account: '交易账户',
  admin_user: '用户管理',
  admin_role: '角色管理',
  admin_log: '日志管理',
  auth: '认证',
};

const CONFIG_KEY_LABEL_MAP: Record<string, string> = {
  NODE_ENV: '运行环境',
  PORT: '服务端口',
  HOST: '监听地址',
  DATABASE_URL: '数据库连接',
  CORS_ORIGINS: '跨域允许来源',
  CORS_ALLOW_ALL: '允许所有跨域来源',
  ADMIN_AUTH_ENABLED: '后台认证开关',
  ADMIN_SELF_REGISTER_ENABLED: '自助注册开关',
  ADMIN_REGISTER_SECRET: '管理员注册密钥',
  ADMIN_SESSION_MAX_AGE_HOURS: '后台会话有效时长',
  ADMIN_SESSION_SECRET: '后台会话签名密钥',
  TRUST_X_FORWARDED_FOR: '信任代理请求头',
  ADMIN_INIT_USERNAME: '初始管理员用户名',
  ADMIN_INIT_PASSWORD: '初始管理员密码',
  RUN_WORKER_IN_API: 'API 内嵌 Worker',
  AGENT_BASE_URL: 'Agent 服务地址',
  AGENT_SERVICE_AUTH_TOKEN: 'Agent 服务令牌',
  AGENT_REQUEST_TIMEOUT_MS: 'Agent 请求超时',
  AGENT_TASK_POLL_INTERVAL_MS: 'Agent 任务轮询间隔',
  AGENT_TASK_POLL_TIMEOUT_MS: 'Agent 任务轮询超时',
  AGENT_TASK_POLL_MAX_RETRIES: 'Agent 任务最大重试次数',
  ANALYSIS_TASK_STALE_TIMEOUT_MS: '分析任务超时阈值',
  SCHEDULER_HEARTBEAT_TTL_MS: '调度心跳有效期',
  AGENT_TASK_RETRY_BASE_DELAY_MS: 'Agent 重试基础延迟',
  BACKTEST_EVAL_WINDOW_DAYS: '回测评估窗口',
  BACKTEST_MIN_AGE_DAYS: '回测最小样本天数',
  BACKTEST_ENGINE_VERSION: '回测引擎版本',
  BACKTEST_NEUTRAL_BAND_PCT: '回测中性区间阈值',
  BACKTRADER_DEFAULT_COMMISSION: '默认佣金率',
  BACKTRADER_DEFAULT_SLIPPAGE_BPS: '默认滑点基点',
  SIM_PROVIDER_DEFAULT_CODE: '默认模拟提供方',
  SIMULATION_BIND_BROKER_CODE: '模拟账户绑定券商',
  ANALYSIS_AUTO_ORDER_ENABLED: '分析后自动下单',
  ANALYSIS_AUTO_ORDER_TYPE: '自动下单类型',
  ANALYSIS_AUTO_ORDER_A_SHARE_ONLY: '自动下单仅限 A 股',
  ANALYSIS_AUTO_ORDER_MAX_NOTIONAL: '自动下单最大金额',
  ANALYSIS_AUTO_ORDER_MAX_QTY: '自动下单最大数量',
  ANALYSIS_AUTO_ORDER_ENFORCE_SESSION: '自动下单限制交易时段',
  ANALYSIS_AUTO_ORDER_TIMEZONE: '自动下单时区',
  ANALYSIS_AUTO_ORDER_TRADING_SESSIONS: '自动下单交易时段',
  BACKTEST_AGENT_BASE_URL: '回测 Agent 地址',
  BACKTEST_AGENT_TOKEN: '回测 Agent 令牌',
  BACKTEST_AGENT_TIMEOUT_MS: '回测 Agent 超时',
  PERSONAL_SECRET_KEY: '个人数据密钥',
  AGENT_FORWARD_RUNTIME_CONFIG: '转发运行配置到 Agent',
};

const STATUS_LABEL_MAP: Record<string, string> = {
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  refining: '精修中',
};

const USER_SETTINGS_SECTION_LABEL_MAP: Record<string, string> = {
  simulation: '模拟设置',
  ai: 'AI 设置',
  strategy: '策略参数',
};

const ROLE_CODE_LABEL_MAP: Record<string, string> = {
  admin: '管理员',
  user: '普通用户',
};

function normalizePath(path: string): string {
  return String(path ?? '').split('?')[0] || '';
}

function parseUrl(path: string): URL {
  const raw = String(path ?? '').trim();
  const normalized = raw.startsWith('/') ? raw : `/${raw}`;
  return new URL(normalized, 'http://audit.local');
}

function getPathSegments(path: string): string[] {
  return normalizePath(path).split('/').filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return String(value ?? '').trim();
}

function getString(value: unknown): string | null {
  const text = asString(value);
  return text ? text : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = asString(value).toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  return null;
}

function getNestedValue(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function getNestedString(value: unknown, ...keys: string[]): string | null {
  return getString(getNestedValue(value, ...keys));
}

function getRecordString(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = getString(record?.[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function getRecordNumber(record: Record<string, unknown> | null, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = getNumber(record?.[key]);
    if (value != null) {
      return value;
    }
  }
  return null;
}

function getRecordBoolean(record: Record<string, unknown> | null, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = getBoolean(record?.[key]);
    if (value != null) {
      return value;
    }
  }
  return null;
}

function getSearchParam(searchParams: URLSearchParams, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = getString(searchParams.get(key));
    if (value) {
      return value;
    }
  }
  return null;
}

function resolveModuleLabel(moduleCode: string | null | undefined): string {
  const normalized = asString(moduleCode);
  return MODULE_LABEL_MAP[normalized] ?? '系统操作';
}

function extractPathUserId(path: string): number | null {
  const matched = normalizePath(path).match(/^\/api\/v1\/admin\/users\/(\d+)(?:\/|$)/);
  if (!matched) {
    return null;
  }
  const id = Number(matched[1]);
  return Number.isFinite(id) ? id : null;
}

function resolveUsername(input: AdminLogEventInput): string {
  const userUsername = getString(input.user?.username);
  if (userUsername) {
    return userUsername;
  }

  const snapshot = getString(input.usernameSnapshot);
  if (snapshot) {
    return snapshot;
  }

  const body = asRecord(input.bodyMasked);
  const attemptedUsername = getString(body?.username);
  if (attemptedUsername) {
    return attemptedUsername;
  }

  if (input.userId != null) {
    return `用户#${input.userId}`;
  }

  return '系统';
}

function resolveActorLabel(input: AdminLogEventInput): string {
  const displayName = getString(input.user?.displayName);
  if (displayName) {
    return displayName;
  }
  return resolveUsername(input);
}

// 先把原始审计输入规整成统一上下文，后续各模块事件构建器只关心语义，不再重复解析 path/body/query。
function createContext(input: AdminLogEventInput): AdminLogEventContext {
  const url = parseUrl(input.path);
  return {
    input,
    actorLabel: resolveActorLabel(input),
    username: resolveUsername(input),
    normalizedPath: normalizePath(input.path),
    pathSegments: getPathSegments(input.path),
    searchParams: url.searchParams,
    body: asRecord(input.bodyMasked),
    query: asRecord(input.queryMasked),
    response: asRecord(input.responseMasked),
  };
}

// 所有事件视图最终都汇总到同一结构，保证列表检索、详情页和关键词搜索使用一致字段。
function createEventView(
  ctx: AdminLogEventContext,
  options: {
    eventType: string;
    eventSummary: string;
    moduleLabel?: string;
    targetLabel?: string | null;
  },
): AdminLogEventView {
  return {
    eventType: options.eventType,
    eventSummary: options.eventSummary,
    moduleLabel: options.moduleLabel ?? resolveModuleLabel(ctx.input.moduleCode),
    resultLabel: ctx.input.success ? '成功' : '失败',
    targetLabel: options.targetLabel ?? null,
    actorLabel: ctx.actorLabel,
    username: ctx.username,
  };
}

function buildSummary(actorLabel: string, success: boolean, successText: string, failureText = successText): string {
  return success
    ? `${actorLabel}${successText}`
    : `${actorLabel}尝试${failureText}但失败了`;
}

function buildReadSummary(actorLabel: string, success: boolean, subject: string, refresh = false): string {
  return buildSummary(
    actorLabel,
    success,
    `${refresh ? '刷新了' : '查看了'}${subject}`,
    `${refresh ? '刷新' : '查看'}${subject}`,
  );
}

function appendDetail(summary: string, detail: string | null): string {
  return detail ? `${summary}：${detail}` : summary;
}

function formatAmount(value: number | null): string | null {
  if (value == null) {
    return null;
  }

  const hasDecimal = Math.abs(value % 1) > 0.000001;
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: hasDecimal ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatList(labels: string[]): string {
  const unique = Array.from(new Set(labels.map((item) => item.trim()).filter(Boolean)));
  if (unique.length === 0) {
    return '';
  }
  if (unique.length <= 3) {
    return unique.join('、');
  }
  return `${unique.slice(0, 3).join('、')} 等 ${unique.length} 项`;
}

function inferConfigCategory(key: string): string {
  const normalized = asString(key).toUpperCase();
  if (!normalized) {
    return 'uncategorized';
  }
  if (normalized.includes('BACKTEST')) {
    return 'backtest';
  }
  if (
    normalized.includes('PORT')
    || normalized.includes('HOST')
    || normalized.includes('DATABASE')
    || normalized.includes('CORS')
    || normalized.includes('ADMIN')
  ) {
    return 'system';
  }
  return 'base';
}

function labelConfigKey(key: string): string {
  const normalized = asString(key).toUpperCase();
  return CONFIG_KEY_LABEL_MAP[normalized] ?? normalized;
}

function extractConfigKeys(value: unknown): string[] {
  const body = asRecord(value);
  const items = asArray(body?.items);
  return items
    .map((item) => getString(asRecord(item)?.key))
    .filter((item): item is string => Boolean(item));
}

function extractTargetLabelFromResponse(responseMasked: unknown): string | null {
  const response = asRecord(responseMasked);
  if (!response) {
    return null;
  }

  const directUsername = getString(response.username);
  if (directUsername) {
    return directUsername;
  }

  const nestedUser = asRecord(response.user);
  if (nestedUser) {
    return getString(nestedUser.username) ?? getString(nestedUser.display_name) ?? getString(nestedUser.displayName);
  }

  return null;
}

function getPathParamAfter(pathSegments: string[], segment: string): string | null {
  const index = pathSegments.indexOf(segment);
  if (index < 0 || index >= pathSegments.length - 1) {
    return null;
  }
  return getString(pathSegments[index + 1]);
}

function getQueryString(ctx: AdminLogEventContext, ...keys: string[]): string | null {
  return getRecordString(ctx.query, ...keys) ?? getSearchParam(ctx.searchParams, ...keys);
}

function getQueryNumber(ctx: AdminLogEventContext, ...keys: string[]): number | null {
  const recordValue = getRecordNumber(ctx.query, ...keys);
  if (recordValue != null) {
    return recordValue;
  }
  return getNumber(getSearchParam(ctx.searchParams, ...keys));
}

function getQueryBoolean(ctx: AdminLogEventContext, ...keys: string[]): boolean | null {
  const recordValue = getRecordBoolean(ctx.query, ...keys);
  if (recordValue != null) {
    return recordValue;
  }
  return getBoolean(getSearchParam(ctx.searchParams, ...keys));
}

function labelStatus(value: string | null): string | null {
  const normalized = asString(value).toLowerCase();
  return normalized ? (STATUS_LABEL_MAP[normalized] ?? normalized) : null;
}

function labelRoleCode(value: string | null): string | null {
  const normalized = asString(value).toLowerCase();
  return normalized ? (ROLE_CODE_LABEL_MAP[normalized] ?? normalized) : null;
}

function extractStockCodeFromResponse(ctx: AdminLogEventContext): string | null {
  return getRecordString(ctx.response, 'stock_code', 'stockCode', 'code')
    ?? getNestedString(ctx.response, 'meta', 'stock_code')
    ?? getNestedString(ctx.response, 'meta', 'stockCode');
}

function extractStockCodes(ctx: AdminLogEventContext): string[] {
  const codes = [
    getRecordString(ctx.body, 'stock_code', 'stockCode', 'code'),
    ...asArray(ctx.body?.stock_codes).map(item => getString(item)),
    getRecordString(ctx.query, 'stock_code', 'stockCode', 'code'),
    ...asArray(ctx.query?.stock_codes).map(item => getString(item)),
    getSearchParam(ctx.searchParams, 'stock_code', 'stockCode', 'code'),
    getPathParamAfter(ctx.pathSegments, 'stocks'),
    extractStockCodeFromResponse(ctx),
    getNestedString(ctx.response, 'runtime_strategy', 'stock_code'),
  ].filter((item): item is string => Boolean(item) && item !== 'extract-from-image');

  return Array.from(new Set(codes));
}

function extractSimulationAccountLabel(ctx: AdminLogEventContext): string | null {
  return getRecordString(ctx.response, 'account_display_name', 'accountDisplayName')
    ?? getRecordString(ctx.body, 'account_display_name', 'accountDisplayName')
    ?? getRecordString(ctx.response, 'account_uid', 'accountUid')
    ?? getRecordString(ctx.body, 'account_uid', 'accountUid');
}

function extractQueryId(ctx: AdminLogEventContext): string | null {
  return getPathParamAfter(ctx.pathSegments, 'history')
    ?? getRecordString(ctx.query, 'query_id', 'queryId')
    ?? getSearchParam(ctx.searchParams, 'query_id', 'queryId')
    ?? getNestedString(ctx.response, 'meta', 'query_id')
    ?? getRecordString(ctx.response, 'query_id', 'queryId');
}

function extractAnalysisTaskId(ctx: AdminLogEventContext): string | null {
  return getPathParamAfter(ctx.pathSegments, 'tasks')
    ?? getRecordString(ctx.body, 'task_id', 'taskId')
    ?? getRecordString(ctx.query, 'task_id', 'taskId')
    ?? getSearchParam(ctx.searchParams, 'task_id', 'taskId');
}

function extractBacktestCode(ctx: AdminLogEventContext): string | null {
  return getRecordString(ctx.body, 'code', 'stock_code', 'stockCode')
    ?? getRecordString(ctx.query, 'code', 'stock_code', 'stockCode')
    ?? getSearchParam(ctx.searchParams, 'code', 'stock_code', 'stockCode')
    ?? getPathParamAfter(ctx.pathSegments, 'performance')
    ?? extractStockCodeFromResponse(ctx);
}

function extractEvalWindowDays(ctx: AdminLogEventContext): number | null {
  return getRecordNumber(ctx.body, 'eval_window_days', 'evalWindowDays')
    ?? getQueryNumber(ctx, 'eval_window_days', 'evalWindowDays');
}

function extractDateRangeLabel(
  startDate: string | null,
  endDate: string | null,
): string | null {
  if (startDate && endDate) {
    return `${startDate} 至 ${endDate}`;
  }
  if (startDate) {
    return `${startDate} 起`;
  }
  if (endDate) {
    return `截至 ${endDate}`;
  }
  return null;
}

function extractUserSettingsSections(ctx: AdminLogEventContext): string[] {
  return Object.entries(USER_SETTINGS_SECTION_LABEL_MAP)
    .filter(([key]) => Object.prototype.hasOwnProperty.call(ctx.body ?? {}, key))
    .map(([, label]) => label);
}

function extractStrategyName(ctx: AdminLogEventContext): string | null {
  return getRecordString(ctx.body, 'name')
    ?? getRecordString(ctx.response, 'name')
    ?? getNestedString(ctx.response, 'strategy', 'name');
}

function extractStrategyId(ctx: AdminLogEventContext): string | null {
  return getPathParamAfter(ctx.pathSegments, 'strategies')
    ?? getRecordString(ctx.body, 'strategy_id', 'strategyId')
    ?? getRecordString(ctx.response, 'id', 'strategy_id', 'strategyId');
}

function extractRunGroupId(ctx: AdminLogEventContext): string | null {
  return getPathParamAfter(ctx.pathSegments, 'runs')
    ?? getRecordString(ctx.body, 'run_group_id', 'runGroupId')
    ?? getRecordString(ctx.response, 'run_group_id', 'runGroupId');
}

function formatEvalWindowLabel(days: number | null): string | null {
  return days != null ? `${days} 日窗口` : null;
}

function extractAdminRoleLabel(ctx: AdminLogEventContext): string | null {
  return getRecordString(ctx.response, 'role_name', 'roleName')
    ?? getRecordString(ctx.body, 'role_name', 'roleName')
    ?? labelRoleCode(getRecordString(ctx.response, 'role_code', 'roleCode'))
    ?? labelRoleCode(getRecordString(ctx.body, 'role_code', 'roleCode'))
    ?? getPathParamAfter(ctx.pathSegments, 'roles');
}

function findAdminTargetLabel(input: AdminLogEventInput, lookup: AdminLogEventLookup): string | null {
  const fromResponse = extractTargetLabelFromResponse(input.responseMasked);
  if (fromResponse) {
    return fromResponse;
  }

  const body = asRecord(input.bodyMasked);
  const fromBody = getString(body?.username);
  if (fromBody) {
    return fromBody;
  }

  const targetId = extractPathUserId(input.path);
  if (targetId == null) {
    return null;
  }
  return lookup.adminUserLabels?.get(targetId) ?? `用户#${targetId}`;
}

function buildAnalysisRequestEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const stockCodes = extractStockCodes(ctx);
  const targetLabel = stockCodes.length > 0 ? formatList(stockCodes) : null;

  if (stockCodes.length > 1) {
    return createEventView(ctx, {
      eventType: 'analysis_batch',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `批量分析了 ${stockCodes.length} 只股票`,
        `批量分析 ${stockCodes.length} 只股票`,
      ),
      moduleLabel: '股票分析',
      targetLabel,
    });
  }

  if (stockCodes.length === 1) {
    return createEventView(ctx, {
      eventType: 'analysis_stock',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `分析了股票 ${stockCodes[0]}`,
        `分析股票 ${stockCodes[0]}`,
      ),
      moduleLabel: '股票分析',
      targetLabel: stockCodes[0],
    });
  }

  return createEventView(ctx, {
    eventType: 'analysis_request',
    eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, '发起了一次股票分析', '发起股票分析'),
    moduleLabel: '股票分析',
  });
}

function buildAnalysisEvent(ctx: AdminLogEventContext): AdminLogEventView {
  if (ctx.normalizedPath === '/api/v1/analysis/analyze') {
    return buildAnalysisRequestEvent(ctx);
  }

  if (ctx.normalizedPath === '/api/v1/analysis/tasks') {
    const statusLabel = labelStatus(getQueryString(ctx, 'status'));
    const limit = getQueryNumber(ctx, 'limit');
    const targetLabel = formatList([
      statusLabel ? `状态：${statusLabel}` : '',
      limit != null ? `最近 ${limit} 条` : '',
    ]) || null;
    const subject = statusLabel ? `${statusLabel}分析任务列表` : '分析任务列表';
    return createEventView(ctx, {
      eventType: 'analysis_task_list',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: '股票分析',
      targetLabel,
    });
  }

  if (/^\/api\/v1\/analysis\/tasks\/[^/]+\/stages$/.test(ctx.normalizedPath)) {
    const taskId = extractAnalysisTaskId(ctx);
    return createEventView(ctx, {
      eventType: 'analysis_task_stages',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `分析任务 ${taskId ?? '目标任务'} 的执行阶段`),
      moduleLabel: '股票分析',
      targetLabel: taskId,
    });
  }

  if (/^\/api\/v1\/analysis\/tasks\/[^/]+\/stages\/stream$/.test(ctx.normalizedPath)) {
    const taskId = extractAnalysisTaskId(ctx);
    return createEventView(ctx, {
      eventType: 'analysis_task_stage_stream',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `订阅了分析任务 ${taskId ?? '目标任务'} 的执行阶段动态`,
        `订阅分析任务 ${taskId ?? '目标任务'} 的执行阶段动态`,
      ),
      moduleLabel: '股票分析',
      targetLabel: taskId,
    });
  }

  if (ctx.normalizedPath === '/api/v1/analysis/tasks/stream') {
    return createEventView(ctx, {
      eventType: 'analysis_task_stream',
      eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, '订阅了分析任务动态', '订阅分析任务动态'),
      moduleLabel: '股票分析',
    });
  }

  if (ctx.normalizedPath === '/api/v1/analysis/scheduler/overview') {
    return createEventView(ctx, {
      eventType: 'scheduler_overview',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '调度中心概览'),
      moduleLabel: '调度中心',
    });
  }

  if (ctx.normalizedPath === '/api/v1/analysis/scheduler/health') {
    return createEventView(ctx, {
      eventType: 'scheduler_health',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '调度中心健康状态'),
      moduleLabel: '调度中心',
    });
  }

  if (ctx.normalizedPath === '/api/v1/analysis/scheduler/tasks') {
    const statusLabel = labelStatus(getQueryString(ctx, 'status'));
    const stockCode = getQueryString(ctx, 'stock_code', 'stockCode');
    const username = getQueryString(ctx, 'username');
    const targetLabel = formatList([
      statusLabel ? `状态：${statusLabel}` : '',
      stockCode ? `股票：${stockCode}` : '',
      username ? `用户：${username}` : '',
    ]) || null;
    return createEventView(ctx, {
      eventType: 'scheduler_task_list',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '调度任务列表'),
      moduleLabel: '调度中心',
      targetLabel,
    });
  }

  if (/^\/api\/v1\/analysis\/scheduler\/tasks\/[^/]+\/retry$/.test(ctx.normalizedPath)) {
    const taskId = extractAnalysisTaskId(ctx);
    return createEventView(ctx, {
      eventType: 'scheduler_task_retry',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `重试了调度任务 ${taskId ?? '目标任务'}`,
        `重试调度任务 ${taskId ?? '目标任务'}`,
      ),
      moduleLabel: '调度中心',
      targetLabel: taskId,
    });
  }

  if (/^\/api\/v1\/analysis\/scheduler\/tasks\/[^/]+\/rerun$/.test(ctx.normalizedPath)) {
    const taskId = extractAnalysisTaskId(ctx);
    return createEventView(ctx, {
      eventType: 'scheduler_task_rerun',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `重新运行了调度任务 ${taskId ?? '目标任务'}`,
        `重新运行调度任务 ${taskId ?? '目标任务'}`,
      ),
      moduleLabel: '调度中心',
      targetLabel: taskId,
    });
  }

  if (/^\/api\/v1\/analysis\/scheduler\/tasks\/[^/]+\/cancel$/.test(ctx.normalizedPath)) {
    const taskId = extractAnalysisTaskId(ctx);
    return createEventView(ctx, {
      eventType: 'scheduler_task_cancel',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `取消了调度任务 ${taskId ?? '目标任务'}`,
        `取消调度任务 ${taskId ?? '目标任务'}`,
      ),
      moduleLabel: '调度中心',
      targetLabel: taskId,
    });
  }

  if (/^\/api\/v1\/analysis\/scheduler\/tasks\/[^/]+\/priority$/.test(ctx.normalizedPath)) {
    const taskId = extractAnalysisTaskId(ctx);
    const priority = getRecordNumber(ctx.body, 'priority');
    const priorityLabel = priority != null ? `优先级 ${priority}` : '任务优先级';
    return createEventView(ctx, {
      eventType: 'scheduler_task_priority',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `调整了调度任务 ${taskId ?? '目标任务'} 的${priorityLabel}`,
        `调整调度任务 ${taskId ?? '目标任务'} 的${priorityLabel}`,
      ),
      moduleLabel: '调度中心',
      targetLabel: taskId,
    });
  }

  if (/^\/api\/v1\/analysis\/scheduler\/tasks\/[^/]+$/.test(ctx.normalizedPath)) {
    const taskId = extractAnalysisTaskId(ctx);
    return createEventView(ctx, {
      eventType: 'scheduler_task_detail',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `调度任务 ${taskId ?? '目标任务'} 详情`),
      moduleLabel: '调度中心',
      targetLabel: taskId,
    });
  }

  if (/^\/api\/v1\/analysis\/status\/[^/]+$/.test(ctx.normalizedPath)) {
    const taskId = getPathParamAfter(ctx.pathSegments, 'status');
    return createEventView(ctx, {
      eventType: 'analysis_task_status',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `分析任务 ${taskId ?? '目标任务'} 的状态`),
      moduleLabel: '股票分析',
      targetLabel: taskId,
    });
  }

  return createEventView(ctx, {
    eventType: 'analysis_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '股票分析相关信息'),
    moduleLabel: '股票分析',
  });
}

function buildFundsEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const amount = formatAmount(getRecordNumber(ctx.body, 'amount'));
  const amountLabel = amount ? `${amount} 元` : null;
  return createEventView(ctx, {
    eventType: 'trading_add_funds',
    eventSummary: buildSummary(
      ctx.actorLabel,
      ctx.input.success,
      amountLabel ? `充值了 ${amountLabel}` : '完成了一笔资金充值',
      amountLabel ? `充值 ${amountLabel}` : '完成资金充值',
    ),
    moduleLabel: '交易账户',
    targetLabel: amountLabel,
  });
}

function buildPlaceOrderEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const stockCode = getRecordString(ctx.body, 'stock_code', 'stockCode');
  const direction = getRecordString(ctx.body, 'direction') === 'sell' ? '卖出' : '买入';
  const quantity = getRecordNumber(ctx.body, 'quantity');
  const quantityLabel = quantity != null ? `${quantity} 股` : '';
  const targetLabel = stockCode ? `${stockCode}${quantityLabel ? ` ${quantityLabel}` : ''}` : null;

  return createEventView(ctx, {
    eventType: 'trading_place_order',
    eventSummary: buildSummary(
      ctx.actorLabel,
      ctx.input.success,
      `提交了${direction}委托${targetLabel ? `：${targetLabel}` : ''}`,
      `提交${direction}委托${targetLabel ? `：${targetLabel}` : ''}`,
    ),
    moduleLabel: '交易账户',
    targetLabel,
  });
}

function buildCancelOrderEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const orderId = getRecordString(ctx.body, 'order_id', 'orderId');
  return createEventView(ctx, {
    eventType: 'trading_cancel_order',
    eventSummary: buildSummary(
      ctx.actorLabel,
      ctx.input.success,
      `撤销了订单${orderId ? ` ${orderId}` : ''}`,
      `撤销订单${orderId ? ` ${orderId}` : ''}`,
    ),
    moduleLabel: '交易账户',
    targetLabel: orderId,
  });
}

function buildTradingAccountEvent(ctx: AdminLogEventContext): AdminLogEventView {
  if (ctx.normalizedPath === '/api/v1/users/me/trading/funds/add') {
    return buildFundsEvent(ctx);
  }

  if (ctx.normalizedPath === '/api/v1/users/me/trading/orders' && ctx.input.method === 'POST') {
    return buildPlaceOrderEvent(ctx);
  }

  if (ctx.normalizedPath === '/api/v1/users/me/trading/orders/cancel') {
    return buildCancelOrderEvent(ctx);
  }

  const refresh = getQueryBoolean(ctx, 'refresh') === true;

  if (ctx.normalizedPath === '/api/v1/users/me/trading/account-summary') {
    return createEventView(ctx, {
      eventType: 'trading_account_summary',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '交易账户总览', refresh),
      moduleLabel: '交易账户',
      targetLabel: refresh ? '已刷新' : null,
    });
  }

  if (ctx.normalizedPath === '/api/v1/users/me/trading/positions') {
    return createEventView(ctx, {
      eventType: 'trading_positions',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '持仓信息', refresh),
      moduleLabel: '交易账户',
      targetLabel: refresh ? '已刷新' : null,
    });
  }

  if (ctx.normalizedPath === '/api/v1/users/me/trading/orders') {
    return createEventView(ctx, {
      eventType: 'trading_orders',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '委托列表', refresh),
      moduleLabel: '交易账户',
      targetLabel: refresh ? '已刷新' : null,
    });
  }

  if (ctx.normalizedPath === '/api/v1/users/me/trading/trades') {
    return createEventView(ctx, {
      eventType: 'trading_trades',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '成交记录', refresh),
      moduleLabel: '交易账户',
      targetLabel: refresh ? '已刷新' : null,
    });
  }

  if (ctx.normalizedPath === '/api/v1/users/me/trading/performance') {
    return createEventView(ctx, {
      eventType: 'trading_performance',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '交易绩效', refresh),
      moduleLabel: '交易账户',
      targetLabel: refresh ? '已刷新' : null,
    });
  }

  return createEventView(ctx, {
    eventType: 'trading_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '交易账户信息'),
    moduleLabel: '交易账户',
  });
}

function buildBrokerAccountEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const targetLabel = extractSimulationAccountLabel(ctx);

  if (ctx.normalizedPath === '/api/v1/users/me/simulation-account/status') {
    const subject = appendDetail('模拟账户状态', targetLabel);
    return createEventView(ctx, {
      eventType: 'simulation_account_status',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: '模拟账户',
      targetLabel,
    });
  }

  if (ctx.normalizedPath === '/api/v1/users/me/simulation-account/bind') {
    return createEventView(ctx, {
      eventType: 'simulation_account_bind',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `绑定了模拟账户${targetLabel ? ` ${targetLabel}` : ''}`,
        `绑定模拟账户${targetLabel ? ` ${targetLabel}` : ''}`,
      ),
      moduleLabel: '模拟账户',
      targetLabel,
    });
  }

  return createEventView(ctx, {
    eventType: 'simulation_account_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '模拟账户信息'),
    moduleLabel: '模拟账户',
    targetLabel,
  });
}

function buildStocksEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const stockCode = getPathParamAfter(ctx.pathSegments, 'stocks');

  if (ctx.normalizedPath === '/api/v1/stocks/extract-from-image') {
    const targetLabel = formatList(
      asArray(ctx.response?.codes)
        .map(item => getString(item))
        .filter((item): item is string => Boolean(item)),
    ) || null;
    return createEventView(ctx, {
      eventType: 'stocks_extract_from_image',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `从图片中识别了股票代码${targetLabel ? `：${targetLabel}` : ''}`,
        '从图片中识别股票代码',
      ),
      moduleLabel: '股票数据',
      targetLabel,
    });
  }

  if (stockCode && ctx.normalizedPath.endsWith('/quote')) {
    return createEventView(ctx, {
      eventType: 'stocks_quote',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `股票 ${stockCode} 的实时行情`),
      moduleLabel: '股票数据',
      targetLabel: stockCode,
    });
  }

  if (stockCode && ctx.normalizedPath.endsWith('/history')) {
    const days = getQueryNumber(ctx, 'days');
    const subject = days != null
      ? `股票 ${stockCode} 近 ${days} 天的历史走势`
      : `股票 ${stockCode} 的历史走势`;
    return createEventView(ctx, {
      eventType: 'stocks_history',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: '股票数据',
      targetLabel: stockCode,
    });
  }

  if (stockCode && ctx.normalizedPath.endsWith('/indicators')) {
    return createEventView(ctx, {
      eventType: 'stocks_indicators',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `股票 ${stockCode} 的技术指标`),
      moduleLabel: '股票数据',
      targetLabel: stockCode,
    });
  }

  if (stockCode && ctx.normalizedPath.endsWith('/factors')) {
    const date = getQueryString(ctx, 'date');
    const subject = date
      ? `股票 ${stockCode} 在 ${date} 的因子数据`
      : `股票 ${stockCode} 的因子数据`;
    return createEventView(ctx, {
      eventType: 'stocks_factors',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: '股票数据',
      targetLabel: stockCode,
    });
  }

  return createEventView(ctx, {
    eventType: 'stocks_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '股票数据'),
    moduleLabel: '股票数据',
    targetLabel: stockCode,
  });
}

function buildHistoryEvent(ctx: AdminLogEventContext): AdminLogEventView {
  if (ctx.normalizedPath === '/api/v1/history') {
    const stockCode = getQueryString(ctx, 'stock_code', 'stockCode');
    const dateRangeLabel = extractDateRangeLabel(
      getQueryString(ctx, 'start_date', 'startDate'),
      getQueryString(ctx, 'end_date', 'endDate'),
    );
    const targetLabel = formatList([
      stockCode ? `股票：${stockCode}` : '',
      dateRangeLabel ? `时间：${dateRangeLabel}` : '',
    ]) || null;
    const subject = stockCode ? `股票 ${stockCode} 的分析历史` : '分析历史列表';
    return createEventView(ctx, {
      eventType: 'history_list',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: '历史记录',
      targetLabel,
    });
  }

  if (/^\/api\/v1\/history\/[^/]+\/news$/.test(ctx.normalizedPath)) {
    const queryId = extractQueryId(ctx);
    const stockCode = extractStockCodeFromResponse(ctx);
    const subject = stockCode
      ? `股票 ${stockCode} 分析记录的相关新闻`
      : `分析记录 ${queryId ?? '目标记录'} 的相关新闻`;
    return createEventView(ctx, {
      eventType: 'history_news',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: '历史记录',
      targetLabel: stockCode ?? queryId,
    });
  }

  if (/^\/api\/v1\/history\/[^/]+$/.test(ctx.normalizedPath)) {
    const queryId = extractQueryId(ctx);
    const stockCode = extractStockCodeFromResponse(ctx);
    const subject = stockCode
      ? `股票 ${stockCode} 的分析记录`
      : `分析记录 ${queryId ?? '目标记录'}`;
    return createEventView(ctx, {
      eventType: 'history_detail',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: '历史记录',
      targetLabel: stockCode ?? queryId,
    });
  }

  return createEventView(ctx, {
    eventType: 'history_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '历史记录'),
    moduleLabel: '历史记录',
  });
}

function buildAdminUserEvent(ctx: AdminLogEventContext, lookup: AdminLogEventLookup): AdminLogEventView {
  const targetLabel = findAdminTargetLabel(ctx.input, lookup);
  const body = ctx.body;

  if (ctx.input.method === 'GET' && ctx.normalizedPath === '/api/v1/admin/users') {
    const keyword = getQueryString(ctx, 'keyword');
    const roleCode = labelRoleCode(getQueryString(ctx, 'role_code', 'roleCode'));
    const targetFilters = formatList([
      keyword ? `关键词：${keyword}` : '',
      roleCode ? `角色：${roleCode}` : '',
    ]) || null;

    return createEventView(ctx, {
      eventType: 'admin_user_list',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '用户列表'),
      moduleLabel: '用户管理',
      targetLabel: targetFilters,
    });
  }

  if (ctx.input.method === 'GET' && /^\/api\/v1\/admin\/users\/[^/]+$/.test(ctx.normalizedPath)) {
    return createEventView(ctx, {
      eventType: 'admin_user_detail',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, appendDetail('用户详情', targetLabel)),
      moduleLabel: '用户管理',
      targetLabel,
    });
  }

  if (ctx.input.method === 'POST' && ctx.normalizedPath === '/api/v1/admin/users') {
    return createEventView(ctx, {
      eventType: 'admin_user_create',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `创建了用户 ${targetLabel ?? '新用户'}`,
        `创建用户${targetLabel ? ` ${targetLabel}` : ''}`,
      ),
      moduleLabel: '用户管理',
      targetLabel,
    });
  }

  if (ctx.input.method === 'PUT' && /\/status$/.test(ctx.normalizedPath)) {
    const status = getRecordString(body, 'status') === 'disabled' ? '禁用' : '启用';
    return createEventView(ctx, {
      eventType: 'admin_user_status',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `将用户 ${targetLabel ?? '目标用户'} 设置为${status}`,
        `将用户 ${targetLabel ?? '目标用户'} 设置为${status}`,
      ),
      moduleLabel: '用户管理',
      targetLabel,
    });
  }

  if (ctx.input.method === 'POST' && /\/reset-password$/.test(ctx.normalizedPath)) {
    return createEventView(ctx, {
      eventType: 'admin_user_reset_password',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `重置了用户 ${targetLabel ?? '目标用户'} 的密码`,
        `重置用户 ${targetLabel ?? '目标用户'} 的密码`,
      ),
      moduleLabel: '用户管理',
      targetLabel,
    });
  }

  if (ctx.input.method === 'DELETE') {
    return createEventView(ctx, {
      eventType: 'admin_user_delete',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `删除了用户 ${targetLabel ?? '目标用户'}`,
        `删除用户 ${targetLabel ?? '目标用户'}`,
      ),
      moduleLabel: '用户管理',
      targetLabel,
    });
  }

  return createEventView(ctx, {
    eventType: 'admin_user_update',
    eventSummary: buildSummary(
      ctx.actorLabel,
      ctx.input.success,
      `更新了用户 ${targetLabel ?? '目标用户'}`,
      `更新用户 ${targetLabel ?? '目标用户'}`,
    ),
    moduleLabel: '用户管理',
    targetLabel,
  });
}

function buildAdminRoleEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const targetLabel = extractAdminRoleLabel(ctx);

  if (ctx.input.method === 'GET' && ctx.normalizedPath === '/api/v1/admin/roles') {
    const keyword = getQueryString(ctx, 'keyword');
    return createEventView(ctx, {
      eventType: 'admin_role_list',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '角色列表'),
      moduleLabel: '角色管理',
      targetLabel: keyword ? `关键词：${keyword}` : null,
    });
  }

  if (ctx.input.method === 'GET' && /^\/api\/v1\/admin\/roles\/[^/]+$/.test(ctx.normalizedPath)) {
    return createEventView(ctx, {
      eventType: 'admin_role_detail',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, appendDetail('角色详情', targetLabel)),
      moduleLabel: '角色管理',
      targetLabel,
    });
  }

  if (ctx.input.method === 'POST' && ctx.normalizedPath === '/api/v1/admin/roles') {
    return createEventView(ctx, {
      eventType: 'admin_role_create',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `创建了角色${targetLabel ? ` ${targetLabel}` : ''}`,
        `创建角色${targetLabel ? ` ${targetLabel}` : ''}`,
      ),
      moduleLabel: '角色管理',
      targetLabel,
    });
  }

  if (ctx.input.method === 'PUT' && /^\/api\/v1\/admin\/roles\/[^/]+$/.test(ctx.normalizedPath)) {
    return createEventView(ctx, {
      eventType: 'admin_role_update',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `更新了角色${targetLabel ? ` ${targetLabel}` : ''}`,
        `更新角色${targetLabel ? ` ${targetLabel}` : ''}`,
      ),
      moduleLabel: '角色管理',
      targetLabel,
    });
  }

  if (ctx.input.method === 'DELETE' && /^\/api\/v1\/admin\/roles\/[^/]+$/.test(ctx.normalizedPath)) {
    return createEventView(ctx, {
      eventType: 'admin_role_delete',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `删除了角色${targetLabel ? ` ${targetLabel}` : ''}`,
        `删除角色${targetLabel ? ` ${targetLabel}` : ''}`,
      ),
      moduleLabel: '角色管理',
      targetLabel,
    });
  }

  return createEventView(ctx, {
    eventType: 'admin_role_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '角色管理'),
    moduleLabel: '角色管理',
    targetLabel,
  });
}

function buildAdminLogEvent(ctx: AdminLogEventContext): AdminLogEventView {
  if (ctx.normalizedPath === '/api/v1/admin/logs') {
    const moduleCode = getQueryString(ctx, 'module_code', 'moduleCode');
    const method = getQueryString(ctx, 'method');
    const keyword = getQueryString(ctx, 'keyword');
    const targetLabel = formatList([
      keyword ? `关键词：${keyword}` : '',
      moduleCode ? `模块：${resolveModuleLabel(moduleCode)}` : '',
      method ? `方法：${method.toUpperCase()}` : '',
    ]) || null;

    return createEventView(ctx, {
      eventType: 'admin_log_list',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '日志列表'),
      moduleLabel: '日志管理',
      targetLabel,
    });
  }

  if (/^\/api\/v1\/admin\/logs\/[^/]+$/.test(ctx.normalizedPath)) {
    const logId = getPathParamAfter(ctx.pathSegments, 'logs');
    return createEventView(ctx, {
      eventType: 'admin_log_detail',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `日志 #${logId ?? '目标日志'} 详情`),
      moduleLabel: '日志管理',
      targetLabel: logId ? `日志 #${logId}` : null,
    });
  }

  return createEventView(ctx, {
    eventType: 'admin_log_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '日志管理'),
    moduleLabel: '日志管理',
  });
}

function buildSystemConfigEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const changedKeys = extractConfigKeys(ctx.body);
  const changedLabels = changedKeys.map(labelConfigKey);
  const targetLabel = formatList(changedLabels) || null;
  const isStrategyConfig = changedKeys.length > 0 && changedKeys.every((key) => {
    const category = inferConfigCategory(key);
    return category === 'base' || category === 'backtest';
  });
  const moduleLabel = isStrategyConfig ? '策略参数' : '配置管理';

  if (ctx.normalizedPath === '/api/v1/system/config' && ctx.input.method === 'GET') {
    const includeSchema = getQueryBoolean(ctx, 'include_schema', 'includeSchema');
    return createEventView(ctx, {
      eventType: 'system_config_view',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '系统配置'),
      moduleLabel: '配置管理',
      targetLabel: includeSchema ? '包含配置结构' : null,
    });
  }

  if (ctx.normalizedPath === '/api/v1/system/config/schema' && ctx.input.method === 'GET') {
    return createEventView(ctx, {
      eventType: 'system_config_schema',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '配置结构'),
      moduleLabel: '配置管理',
    });
  }

  if (ctx.normalizedPath === '/api/v1/system/config/validate') {
    return createEventView(ctx, {
      eventType: isStrategyConfig ? 'strategy_config_validate' : 'system_config_validate',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `校验了${moduleLabel}${changedKeys.length ? `（${changedKeys.length} 项）` : ''}`,
        `校验${moduleLabel}${changedKeys.length ? `（${changedKeys.length} 项）` : ''}`,
      ),
      moduleLabel,
      targetLabel,
    });
  }

  return createEventView(ctx, {
    eventType: isStrategyConfig ? 'strategy_config_update' : 'system_config_update',
    eventSummary: buildSummary(
      ctx.actorLabel,
      ctx.input.success,
      `${isStrategyConfig ? '调整了策略参数' : '修改了系统配置'}${targetLabel ? `：${targetLabel}` : changedKeys.length ? `（${changedKeys.length} 项）` : ''}`,
      isStrategyConfig ? '调整策略参数' : '修改系统配置',
    ),
    moduleLabel,
    targetLabel,
  });
}

function buildUserSettingsEvent(ctx: AdminLogEventContext): AdminLogEventView {
  if (ctx.normalizedPath === '/api/v1/users/me/settings' && ctx.input.method === 'GET') {
    return createEventView(ctx, {
      eventType: 'user_settings_view',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '个人设置'),
      moduleLabel: '用户设置',
    });
  }

  if (ctx.normalizedPath === '/api/v1/users/me/settings' && ctx.input.method === 'PUT') {
    const sectionLabels = extractUserSettingsSections(ctx);
    const targetLabel = formatList(sectionLabels) || null;
    return createEventView(ctx, {
      eventType: 'user_settings_update',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `修改了个人设置${targetLabel ? `：${targetLabel}` : ''}`,
        '修改个人设置',
      ),
      moduleLabel: '用户设置',
      targetLabel,
    });
  }

  return createEventView(ctx, {
    eventType: 'user_settings_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '用户设置'),
    moduleLabel: '用户设置',
  });
}

function buildAuthEvent(ctx: AdminLogEventContext): AdminLogEventView {
  if (ctx.normalizedPath === '/api/v1/auth/status') {
    const currentUser = getNestedString(ctx.response, 'currentUser', 'username')
      ?? getNestedString(ctx.response, 'currentUser', 'display_name')
      ?? getNestedString(ctx.response, 'currentUser', 'displayName');
    const loggedIn = getRecordBoolean(ctx.response, 'loggedIn', 'logged_in');
    const targetLabel = currentUser ?? (loggedIn === false ? '未登录' : null);
    return createEventView(ctx, {
      eventType: 'auth_status',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '登录状态'),
      moduleLabel: '认证',
      targetLabel,
    });
  }

  if (ctx.normalizedPath === '/api/v1/auth/login') {
    return createEventView(ctx, {
      eventType: 'auth_login',
      eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, '登录了系统', '登录系统'),
      moduleLabel: '认证',
      targetLabel: getRecordString(ctx.body, 'username'),
    });
  }

  if (ctx.normalizedPath === '/api/v1/auth/register') {
    const accountType = getRecordString(ctx.body, 'accountType') === 'admin' ? '管理员账号' : '普通用户账号';
    return createEventView(ctx, {
      eventType: 'auth_register',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `注册了${accountType}`,
        `注册${accountType}`,
      ),
      moduleLabel: '认证',
      targetLabel: getRecordString(ctx.body, 'username'),
    });
  }

  if (ctx.normalizedPath === '/api/v1/auth/change-password') {
    return createEventView(ctx, {
      eventType: 'auth_change_password',
      eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, '修改了登录密码', '修改登录密码'),
      moduleLabel: '认证',
    });
  }

  if (ctx.normalizedPath === '/api/v1/auth/logout') {
    return createEventView(ctx, {
      eventType: 'auth_logout',
      eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, '退出了系统', '退出系统'),
      moduleLabel: '认证',
    });
  }

  return createEventView(ctx, {
    eventType: 'auth_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '认证信息'),
    moduleLabel: '认证',
  });
}

function buildBacktestStrategyLibraryEvent(ctx: AdminLogEventContext): AdminLogEventView | null {
  if (ctx.normalizedPath === '/api/v1/backtest/strategies/templates') {
    return createEventView(ctx, {
      eventType: 'backtest_strategy_templates',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '策略模板'),
      moduleLabel: '策略库',
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/strategies' && ctx.input.method === 'GET') {
    return createEventView(ctx, {
      eventType: 'backtest_strategy_list',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '自定义策略列表'),
      moduleLabel: '策略库',
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/strategies' && ctx.input.method === 'POST') {
    const targetLabel = extractStrategyName(ctx);
    return createEventView(ctx, {
      eventType: 'backtest_strategy_create',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `创建了自定义策略${targetLabel ? ` ${targetLabel}` : ''}`,
        `创建自定义策略${targetLabel ? ` ${targetLabel}` : ''}`,
      ),
      moduleLabel: '策略库',
      targetLabel,
    });
  }

  if (/^\/api\/v1\/backtest\/strategies\/[^/]+$/.test(ctx.normalizedPath) && ctx.input.method === 'GET') {
    const targetLabel = extractStrategyName(ctx) ?? extractStrategyId(ctx);
    return createEventView(ctx, {
      eventType: 'backtest_strategy_detail',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `自定义策略 ${targetLabel ?? '目标策略'}`),
      moduleLabel: '策略库',
      targetLabel,
    });
  }

  if (/^\/api\/v1\/backtest\/strategies\/[^/]+$/.test(ctx.normalizedPath) && ctx.input.method === 'PATCH') {
    const targetLabel = extractStrategyName(ctx) ?? extractStrategyId(ctx);
    return createEventView(ctx, {
      eventType: 'backtest_strategy_update',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `更新了自定义策略${targetLabel ? ` ${targetLabel}` : ''}`,
        `更新自定义策略${targetLabel ? ` ${targetLabel}` : ''}`,
      ),
      moduleLabel: '策略库',
      targetLabel,
    });
  }

  if (/^\/api\/v1\/backtest\/strategies\/[^/]+$/.test(ctx.normalizedPath) && ctx.input.method === 'DELETE') {
    const targetLabel = extractStrategyName(ctx) ?? extractStrategyId(ctx);
    return createEventView(ctx, {
      eventType: 'backtest_strategy_delete',
      eventSummary: buildSummary(
        ctx.actorLabel,
        ctx.input.success,
        `删除了自定义策略${targetLabel ? ` ${targetLabel}` : ''}`,
        `删除自定义策略${targetLabel ? ` ${targetLabel}` : ''}`,
      ),
      moduleLabel: '策略库',
      targetLabel,
    });
  }

  return null;
}

function buildBacktestEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const strategyLibraryEvent = buildBacktestStrategyLibraryEvent(ctx);
  if (strategyLibraryEvent) {
    return strategyLibraryEvent;
  }

  if (ctx.normalizedPath === '/api/v1/backtest/run') {
    const code = extractBacktestCode(ctx);
    const evalWindowLabel = formatEvalWindowLabel(extractEvalWindowDays(ctx));
    const subjectBase = code ? `股票 ${code} 的回测计算` : '回测计算';
    const subject = evalWindowLabel ? `${subjectBase}（${evalWindowLabel}）` : subjectBase;
    return createEventView(ctx, {
      eventType: 'backtest_run',
      eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, `发起了${subject}`, `发起${subject}`),
      moduleLabel: '回测分析',
      targetLabel: code ?? evalWindowLabel,
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/results') {
    const code = extractBacktestCode(ctx);
    const subject = code ? `股票 ${code} 的回测结果列表` : '回测结果列表';
    return createEventView(ctx, {
      eventType: 'backtest_results',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: '回测分析',
      targetLabel: code,
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/performance') {
    const evalWindowLabel = formatEvalWindowLabel(extractEvalWindowDays(ctx));
    return createEventView(ctx, {
      eventType: 'backtest_performance',
      eventSummary: buildReadSummary(
        ctx.actorLabel,
        ctx.input.success,
        evalWindowLabel ? `整体回测表现（${evalWindowLabel}）` : '整体回测表现',
      ),
      moduleLabel: '回测分析',
      targetLabel: evalWindowLabel,
    });
  }

  if (/^\/api\/v1\/backtest\/performance\/[^/]+$/.test(ctx.normalizedPath)) {
    const code = getPathParamAfter(ctx.pathSegments, 'performance');
    const evalWindowLabel = formatEvalWindowLabel(extractEvalWindowDays(ctx));
    const subjectBase = `股票 ${code ?? '目标股票'} 的回测表现`;
    return createEventView(ctx, {
      eventType: 'backtest_stock_performance',
      eventSummary: buildReadSummary(
        ctx.actorLabel,
        ctx.input.success,
        evalWindowLabel ? `${subjectBase}（${evalWindowLabel}）` : subjectBase,
      ),
      moduleLabel: '回测分析',
      targetLabel: code ?? evalWindowLabel,
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/curves') {
    const code = extractBacktestCode(ctx);
    const scope = getQueryString(ctx, 'scope') === 'stock' && code ? `股票 ${code}` : '整体';
    return createEventView(ctx, {
      eventType: 'backtest_curves',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `${scope}回测收益曲线`),
      moduleLabel: '回测分析',
      targetLabel: code,
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/distribution') {
    const code = extractBacktestCode(ctx);
    const scope = getQueryString(ctx, 'scope') === 'stock' && code ? `股票 ${code}` : '整体';
    return createEventView(ctx, {
      eventType: 'backtest_distribution',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `${scope}回测收益分布`),
      moduleLabel: '回测分析',
      targetLabel: code,
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/compare') {
    const code = extractBacktestCode(ctx);
    const windows = asArray(ctx.body?.eval_window_days_list)
      .map(item => getNumber(item))
      .filter((item): item is number => item != null)
      .map(item => `${item} 日`);
    const targetLabel = windows.length > 0 ? formatList(windows) : code;
    const subject = code ? `股票 ${code} 的回测窗口对比` : '回测窗口对比';
    return createEventView(ctx, {
      eventType: 'backtest_compare',
      eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, `比较了${subject}`, `比较${subject}`),
      moduleLabel: '回测分析',
      targetLabel,
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/strategy/run') {
    const code = extractBacktestCode(ctx);
    const dateRangeLabel = extractDateRangeLabel(
      getRecordString(ctx.body, 'start_date', 'startDate'),
      getRecordString(ctx.body, 'end_date', 'endDate'),
    );
    const targetLabel = formatList([code ? `股票：${code}` : '', dateRangeLabel ? `区间：${dateRangeLabel}` : '']) || null;
    const subject = code ? `股票 ${code} 的策略回测` : '策略回测';
    return createEventView(ctx, {
      eventType: 'backtest_strategy_run',
      eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, `发起了${subject}`, `发起${subject}`),
      moduleLabel: '策略回测',
      targetLabel,
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/strategy/runs') {
    const code = extractBacktestCode(ctx);
    const subject = code ? `股票 ${code} 的策略回测列表` : '策略回测列表';
    return createEventView(ctx, {
      eventType: 'backtest_strategy_runs',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: '策略回测',
      targetLabel: code,
    });
  }

  if (/^\/api\/v1\/backtest\/strategy\/runs\/[^/]+$/.test(ctx.normalizedPath)) {
    const runGroupId = extractRunGroupId(ctx);
    return createEventView(ctx, {
      eventType: 'backtest_strategy_run_detail',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `策略回测 ${runGroupId ?? '目标记录'} 详情`),
      moduleLabel: '策略回测',
      targetLabel: runGroupId,
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/agent/run') {
    const code = extractBacktestCode(ctx);
    const dateRangeLabel = extractDateRangeLabel(
      getRecordString(ctx.body, 'start_date', 'startDate'),
      getRecordString(ctx.body, 'end_date', 'endDate'),
    );
    const targetLabel = formatList([code ? `股票：${code}` : '', dateRangeLabel ? `区间：${dateRangeLabel}` : '']) || null;
    const subject = code ? `股票 ${code} 的 Agent 回放回测` : 'Agent 回放回测';
    return createEventView(ctx, {
      eventType: 'agent_backtest_run',
      eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, `发起了${subject}`, `发起${subject}`),
      moduleLabel: 'Agent 回放回测',
      targetLabel,
    });
  }

  if (ctx.normalizedPath === '/api/v1/backtest/agent/runs') {
    const code = extractBacktestCode(ctx);
    const statusLabel = labelStatus(getQueryString(ctx, 'status'));
    const targetLabel = formatList([code ? `股票：${code}` : '', statusLabel ? `状态：${statusLabel}` : '']) || null;
    const subject = code ? `股票 ${code} 的 Agent 回放记录` : 'Agent 回放记录';
    return createEventView(ctx, {
      eventType: 'agent_backtest_runs',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, subject),
      moduleLabel: 'Agent 回放回测',
      targetLabel,
    });
  }

  if (/^\/api\/v1\/backtest\/agent\/runs\/[^/]+$/.test(ctx.normalizedPath)) {
    const runGroupId = extractRunGroupId(ctx);
    return createEventView(ctx, {
      eventType: 'agent_backtest_run_detail',
      eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, `Agent 回放回测 ${runGroupId ?? '目标记录'} 详情`),
      moduleLabel: 'Agent 回放回测',
      targetLabel: runGroupId,
    });
  }

  return createEventView(ctx, {
    eventType: 'backtest_generic',
    eventSummary: buildReadSummary(ctx.actorLabel, ctx.input.success, '回测分析'),
    moduleLabel: '回测分析',
    targetLabel: extractBacktestCode(ctx),
  });
}

function buildFallbackEvent(ctx: AdminLogEventContext): AdminLogEventView {
  const moduleLabel = resolveModuleLabel(ctx.input.moduleCode);

  let eventType = 'generic_action';
  let successText = `处理了${moduleLabel}`;
  let failureText = `处理${moduleLabel}`;

  if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.input.method)) {
    eventType = 'generic_view';
    successText = `查看了${moduleLabel}`;
    failureText = `查看${moduleLabel}`;
  } else if (ctx.input.method === 'POST') {
    eventType = 'generic_submit';
    successText = `提交了${moduleLabel}相关操作`;
    failureText = `提交${moduleLabel}相关操作`;
  } else if (ctx.input.method === 'PUT' || ctx.input.method === 'PATCH') {
    eventType = 'generic_update';
    successText = `更新了${moduleLabel}`;
    failureText = `更新${moduleLabel}`;
  } else if (ctx.input.method === 'DELETE') {
    eventType = 'generic_delete';
    successText = `删除了${moduleLabel}相关内容`;
    failureText = `删除${moduleLabel}相关内容`;
  }

  return createEventView(ctx, {
    eventType,
    eventSummary: buildSummary(ctx.actorLabel, ctx.input.success, successText, failureText),
    moduleLabel,
  });
}

// 顶层分发器按路径前缀把请求路由到各模块专属的“可读化规则”，避免一个巨大 if 分支里混杂全部业务。
export function buildAdminLogEventView(input: AdminLogEventInput, lookup: AdminLogEventLookup = {}): AdminLogEventView {
  const ctx = createContext(input);

  if (ctx.normalizedPath.startsWith('/api/v1/analysis')) {
    return buildAnalysisEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/users/me/simulation-account')) {
    return buildBrokerAccountEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/users/me/trading')) {
    return buildTradingAccountEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/users/me/settings')) {
    return buildUserSettingsEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/stocks')) {
    return buildStocksEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/history')) {
    return buildHistoryEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/admin/users')) {
    return buildAdminUserEvent(ctx, lookup);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/admin/roles')) {
    return buildAdminRoleEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/admin/logs')) {
    return buildAdminLogEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/system/config')) {
    return buildSystemConfigEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/backtest')) {
    return buildBacktestEvent(ctx);
  }
  if (ctx.normalizedPath.startsWith('/api/v1/auth')) {
    return buildAuthEvent(ctx);
  }

  return buildFallbackEvent(ctx);
}

export function matchesAdminLogKeyword(view: AdminLogEventView, keyword: string, path: string): boolean {
  const normalizedKeyword = asString(keyword).toLowerCase();
  if (!normalizedKeyword) {
    return true;
  }

  return [
    view.actorLabel,
    view.username,
    view.eventSummary,
    view.moduleLabel,
    view.resultLabel,
    view.targetLabel,
    normalizePath(path),
    view.eventType,
  ].some(text => asString(text).toLowerCase().includes(normalizedKeyword));
}

export function collectAdminLogTargetUserIds(paths: string[]): number[] {
  return Array.from(new Set(
    paths
      .map(path => extractPathUserId(path))
      .filter((id): id is number => id != null),
  ));
}
