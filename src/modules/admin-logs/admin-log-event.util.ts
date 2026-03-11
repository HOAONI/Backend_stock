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

function normalizePath(path: string): string {
  return String(path ?? '').split('?')[0] || '';
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

function extractStockCodes(bodyMasked: unknown, queryMasked: unknown): string[] {
  const body = asRecord(bodyMasked);
  const query = asRecord(queryMasked);
  const stockCodes = [
    getString(body?.stock_code),
    ...asArray(body?.stock_codes).map(item => getString(item)),
    getString(query?.stock_code),
    ...asArray(query?.stock_codes).map(item => getString(item)),
  ].filter((item): item is string => Boolean(item));

  return Array.from(new Set(stockCodes));
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

function buildAnalysisEvent(input: AdminLogEventInput, actorLabel: string): AdminLogEventView {
  const stockCodes = extractStockCodes(input.bodyMasked, input.queryMasked);
  const targetLabel = stockCodes.length > 0 ? formatList(stockCodes) : null;
  if (stockCodes.length > 1) {
    return {
      eventType: 'analysis_batch',
      eventSummary: input.success
        ? `${actorLabel}批量分析了 ${stockCodes.length} 只股票`
        : `${actorLabel}尝试批量分析 ${stockCodes.length} 只股票但失败了`,
      moduleLabel: '股票分析',
      resultLabel: input.success ? '成功' : '失败',
      targetLabel,
      actorLabel,
      username: resolveUsername(input),
    };
  }

  if (stockCodes.length === 1) {
    return {
      eventType: 'analysis_stock',
      eventSummary: input.success
        ? `${actorLabel}分析了股票 ${stockCodes[0]}`
        : `${actorLabel}尝试分析股票 ${stockCodes[0]} 但失败了`,
      moduleLabel: '股票分析',
      resultLabel: input.success ? '成功' : '失败',
      targetLabel: stockCodes[0],
      actorLabel,
      username: resolveUsername(input),
    };
  }

  return {
    eventType: 'analysis_request',
    eventSummary: input.success ? `${actorLabel}发起了一次股票分析` : `${actorLabel}尝试发起股票分析但失败了`,
    moduleLabel: '股票分析',
    resultLabel: input.success ? '成功' : '失败',
    targetLabel: null,
    actorLabel,
    username: resolveUsername(input),
  };
}

function buildFundsEvent(input: AdminLogEventInput, actorLabel: string): AdminLogEventView {
  const body = asRecord(input.bodyMasked);
  const amount = formatAmount(getNumber(body?.amount));
  const amountLabel = amount ? `${amount} 元` : null;
  return {
    eventType: 'trading_add_funds',
    eventSummary: input.success
      ? `${actorLabel}${amountLabel ? `充值了 ${amountLabel}` : '完成了一笔资金充值'}`
      : `${actorLabel}尝试充值${amountLabel ? ` ${amountLabel}` : ''}但失败了`,
    moduleLabel: '交易账户',
    resultLabel: input.success ? '成功' : '失败',
    targetLabel: amountLabel,
    actorLabel,
    username: resolveUsername(input),
  };
}

function buildPlaceOrderEvent(input: AdminLogEventInput, actorLabel: string): AdminLogEventView {
  const body = asRecord(input.bodyMasked);
  const stockCode = getString(body?.stock_code);
  const direction = getString(body?.direction) === 'sell' ? '卖出' : '买入';
  const quantity = getNumber(body?.quantity);
  const quantityLabel = quantity != null ? `${quantity} 股` : '';
  const targetLabel = stockCode ? `${stockCode}${quantityLabel ? ` ${quantityLabel}` : ''}` : null;

  return {
    eventType: 'trading_place_order',
    eventSummary: input.success
      ? `${actorLabel}提交了${direction}委托${targetLabel ? `：${targetLabel}` : ''}`
      : `${actorLabel}尝试提交${direction}委托${targetLabel ? `：${targetLabel}` : ''}但失败了`,
    moduleLabel: '交易账户',
    resultLabel: input.success ? '成功' : '失败',
    targetLabel,
    actorLabel,
    username: resolveUsername(input),
  };
}

function buildCancelOrderEvent(input: AdminLogEventInput, actorLabel: string): AdminLogEventView {
  const body = asRecord(input.bodyMasked);
  const orderId = getString(body?.order_id);
  return {
    eventType: 'trading_cancel_order',
    eventSummary: input.success
      ? `${actorLabel}撤销了订单${orderId ? ` ${orderId}` : ''}`
      : `${actorLabel}尝试撤销订单${orderId ? ` ${orderId}` : ''}但失败了`,
    moduleLabel: '交易账户',
    resultLabel: input.success ? '成功' : '失败',
    targetLabel: orderId,
    actorLabel,
    username: resolveUsername(input),
  };
}

function buildAdminUserEvent(input: AdminLogEventInput, actorLabel: string, lookup: AdminLogEventLookup): AdminLogEventView {
  const normalizedPath = normalizePath(input.path);
  const targetLabel = findAdminTargetLabel(input, lookup);
  const body = asRecord(input.bodyMasked);

  if (input.method === 'POST' && normalizedPath === '/api/v1/admin/users') {
    return {
      eventType: 'admin_user_create',
      eventSummary: input.success
        ? `${actorLabel}创建了用户 ${targetLabel ?? '新用户'}`
        : `${actorLabel}尝试创建用户${targetLabel ? ` ${targetLabel}` : ''}但失败了`,
      moduleLabel: '用户管理',
      resultLabel: input.success ? '成功' : '失败',
      targetLabel,
      actorLabel,
      username: resolveUsername(input),
    };
  }

  if (input.method === 'PUT' && /\/status$/.test(normalizedPath)) {
    const status = getString(body?.status) === 'disabled' ? '禁用' : '启用';
    return {
      eventType: 'admin_user_status',
      eventSummary: input.success
        ? `${actorLabel}将用户 ${targetLabel ?? '目标用户'} 设置为${status}`
        : `${actorLabel}尝试将用户 ${targetLabel ?? '目标用户'} 设置为${status}但失败了`,
      moduleLabel: '用户管理',
      resultLabel: input.success ? '成功' : '失败',
      targetLabel,
      actorLabel,
      username: resolveUsername(input),
    };
  }

  if (input.method === 'POST' && /\/reset-password$/.test(normalizedPath)) {
    return {
      eventType: 'admin_user_reset_password',
      eventSummary: input.success
        ? `${actorLabel}重置了用户 ${targetLabel ?? '目标用户'} 的密码`
        : `${actorLabel}尝试重置用户 ${targetLabel ?? '目标用户'} 的密码但失败了`,
      moduleLabel: '用户管理',
      resultLabel: input.success ? '成功' : '失败',
      targetLabel,
      actorLabel,
      username: resolveUsername(input),
    };
  }

  if (input.method === 'DELETE') {
    return {
      eventType: 'admin_user_delete',
      eventSummary: input.success
        ? `${actorLabel}删除了用户 ${targetLabel ?? '目标用户'}`
        : `${actorLabel}尝试删除用户 ${targetLabel ?? '目标用户'} 但失败了`,
      moduleLabel: '用户管理',
      resultLabel: input.success ? '成功' : '失败',
      targetLabel,
      actorLabel,
      username: resolveUsername(input),
    };
  }

  return {
    eventType: 'admin_user_update',
    eventSummary: input.success
      ? `${actorLabel}更新了用户 ${targetLabel ?? '目标用户'}`
      : `${actorLabel}尝试更新用户 ${targetLabel ?? '目标用户'} 但失败了`,
    moduleLabel: '用户管理',
    resultLabel: input.success ? '成功' : '失败',
    targetLabel,
    actorLabel,
    username: resolveUsername(input),
  };
}

function buildSystemConfigEvent(input: AdminLogEventInput, actorLabel: string): AdminLogEventView {
  const changedKeys = extractConfigKeys(input.bodyMasked);
  const changedLabels = changedKeys.map(labelConfigKey);
  const targetLabel = formatList(changedLabels) || null;
  const isStrategyConfig = changedKeys.length > 0 && changedKeys.every(key => {
    const category = inferConfigCategory(key);
    return category === 'base' || category === 'backtest';
  });
  const moduleLabel = isStrategyConfig ? '策略参数' : '配置管理';

  if (normalizePath(input.path) === '/api/v1/system/config/validate') {
    return {
      eventType: isStrategyConfig ? 'strategy_config_validate' : 'system_config_validate',
      eventSummary: `${actorLabel}校验了${moduleLabel}${changedKeys.length ? `（${changedKeys.length} 项）` : ''}`,
      moduleLabel,
      resultLabel: input.success ? '成功' : '失败',
      targetLabel,
      actorLabel,
      username: resolveUsername(input),
    };
  }

  return {
    eventType: isStrategyConfig ? 'strategy_config_update' : 'system_config_update',
    eventSummary: input.success
      ? `${actorLabel}${isStrategyConfig ? '调整了策略参数' : '修改了系统配置'}${targetLabel ? `：${targetLabel}` : changedKeys.length ? `（${changedKeys.length} 项）` : ''}`
      : `${actorLabel}尝试${isStrategyConfig ? '调整策略参数' : '修改系统配置'}但失败了`,
    moduleLabel,
    resultLabel: input.success ? '成功' : '失败',
    targetLabel,
    actorLabel,
    username: resolveUsername(input),
  };
}

function buildAuthEvent(input: AdminLogEventInput, actorLabel: string): AdminLogEventView {
  const normalizedPath = normalizePath(input.path);
  const body = asRecord(input.bodyMasked);

  if (normalizedPath === '/api/v1/auth/login') {
    return {
      eventType: 'auth_login',
      eventSummary: input.success ? `${actorLabel}登录了系统` : `${actorLabel}尝试登录系统但失败了`,
      moduleLabel: '认证',
      resultLabel: input.success ? '成功' : '失败',
      targetLabel: getString(body?.username),
      actorLabel,
      username: resolveUsername(input),
    };
  }

  if (normalizedPath === '/api/v1/auth/register') {
    const accountType = getString(body?.accountType) === 'admin' ? '管理员账号' : '普通用户账号';
    return {
      eventType: 'auth_register',
      eventSummary: input.success
        ? `${actorLabel}注册了${accountType}`
        : `${actorLabel}尝试注册${accountType}但失败了`,
      moduleLabel: '认证',
      resultLabel: input.success ? '成功' : '失败',
      targetLabel: getString(body?.username),
      actorLabel,
      username: resolveUsername(input),
    };
  }

  if (normalizedPath === '/api/v1/auth/change-password') {
    return {
      eventType: 'auth_change_password',
      eventSummary: input.success ? `${actorLabel}修改了登录密码` : `${actorLabel}尝试修改登录密码但失败了`,
      moduleLabel: '认证',
      resultLabel: input.success ? '成功' : '失败',
      targetLabel: null,
      actorLabel,
      username: resolveUsername(input),
    };
  }

  return {
    eventType: 'auth_request',
    eventSummary: input.success ? `${actorLabel}执行了认证操作` : `${actorLabel}尝试执行认证操作但失败了`,
    moduleLabel: '认证',
    resultLabel: input.success ? '成功' : '失败',
    targetLabel: null,
    actorLabel,
    username: resolveUsername(input),
  };
}

function buildFallbackEvent(input: AdminLogEventInput, actorLabel: string): AdminLogEventView {
  const moduleLabel = resolveModuleLabel(input.moduleCode);
  return {
    eventType: `generic_${asString(input.method).toLowerCase() || 'request'}`,
    eventSummary: `${actorLabel}在 ${moduleLabel} 执行了 ${asString(input.method) || 'REQUEST'} ${normalizePath(input.path)}`,
    moduleLabel,
    resultLabel: input.success ? '成功' : '失败',
    targetLabel: null,
    actorLabel,
    username: resolveUsername(input),
  };
}

export function buildAdminLogEventView(input: AdminLogEventInput, lookup: AdminLogEventLookup = {}): AdminLogEventView {
  const actorLabel = resolveActorLabel(input);
  const normalizedPath = normalizePath(input.path);

  if (normalizedPath === '/api/v1/analysis/analyze') {
    return buildAnalysisEvent(input, actorLabel);
  }
  if (normalizedPath === '/api/v1/users/me/trading/funds/add') {
    return buildFundsEvent(input, actorLabel);
  }
  if (normalizedPath === '/api/v1/users/me/trading/orders') {
    return buildPlaceOrderEvent(input, actorLabel);
  }
  if (normalizedPath === '/api/v1/users/me/trading/orders/cancel') {
    return buildCancelOrderEvent(input, actorLabel);
  }
  if (normalizedPath.startsWith('/api/v1/admin/users')) {
    return buildAdminUserEvent(input, actorLabel, lookup);
  }
  if (normalizedPath.startsWith('/api/v1/system/config')) {
    return buildSystemConfigEvent(input, actorLabel);
  }
  if (normalizedPath.startsWith('/api/v1/auth/')) {
    return buildAuthEvent(input, actorLabel);
  }

  return buildFallbackEvent(input, actorLabel);
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
  ].some(text => asString(text).toLowerCase().includes(normalizedKeyword));
}

export function collectAdminLogTargetUserIds(paths: string[]): number[] {
  return Array.from(new Set(
    paths
      .map(path => extractPathUserId(path))
      .filter((id): id is number => id != null),
  ));
}
