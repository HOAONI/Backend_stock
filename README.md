# Backend_stock

`Backend_stock` 是本系统的主后端服务，负责：

- 系统登录与 RBAC
- 分析任务提交与异步轮询
- Backtrader 本地模拟盘账户初始化/状态
- 交易查询与下单/撤单
- 自动下单（`execution_mode=auto`）

## 技术栈

- Node.js 22+
- NestJS
- Prisma + PostgreSQL
- pnpm

## 快速启动

```bash
cp .env.example .env
pnpm install
pnpm db:init
pnpm start:dev:all
```

`start:dev:all` 会在同一进程启 API + Worker。

若数据库是已存在实例且未跑 `db:init`，至少先执行一次：

```bash
pnpm db:push
pnpm prisma:generate
```

## 核心环境变量

```bash
# Agent service
AGENT_BASE_URL=http://127.0.0.1:8001
AGENT_SERVICE_AUTH_TOKEN=change_me
AGENT_REQUEST_TIMEOUT_MS=30000

# Agent task polling
AGENT_TASK_POLL_INTERVAL_MS=2000
AGENT_TASK_POLL_TIMEOUT_MS=600000
AGENT_TASK_POLL_MAX_RETRIES=3
AGENT_TASK_RETRY_BASE_DELAY_MS=1000

# Backtrader adapter (Backend -> Agent internal)
BACKTRADER_AGENT_BASE_URL=http://127.0.0.1:8001
BACKTRADER_AGENT_TOKEN=change_me
BACKTRADER_AGENT_TIMEOUT_MS=20000
BACKTRADER_DEFAULT_COMMISSION=0.0003
BACKTRADER_DEFAULT_SLIPPAGE_BPS=2

# Backtest adapter (Backend -> Agent internal)
BACKTEST_AGENT_BASE_URL=http://127.0.0.1:8001
BACKTEST_AGENT_TOKEN=change_me
BACKTEST_AGENT_TIMEOUT_MS=30000

# Simulation account defaults
SIMULATION_BIND_BROKER_CODE=backtrader_local
SIM_PROVIDER_DEFAULT_CODE=backtrader_local
BROKER_SNAPSHOT_CACHE_TTL_MS=60000
BROKER_SECRET_KEY=

# Auto order risk controls
ANALYSIS_AUTO_ORDER_ENABLED=true
ANALYSIS_AUTO_ORDER_TYPE=market
ANALYSIS_AUTO_ORDER_A_SHARE_ONLY=true
ANALYSIS_AUTO_ORDER_MAX_NOTIONAL=200000
ANALYSIS_AUTO_ORDER_MAX_QTY=20000
ANALYSIS_AUTO_ORDER_ENFORCE_SESSION=true
ANALYSIS_AUTO_ORDER_TIMEZONE=Asia/Shanghai
ANALYSIS_AUTO_ORDER_TRADING_SESSIONS=09:30-11:30,13:00-15:00

# Auth
ADMIN_AUTH_ENABLED=false
ADMIN_SELF_REGISTER_ENABLED=true
ADMIN_SESSION_MAX_AGE_HOURS=24
ADMIN_SESSION_SECRET=
ADMIN_INIT_USERNAME=admin
ADMIN_INIT_PASSWORD=
```

## API 基础信息

- Base: `http://127.0.0.1:8002`
- Health: `GET /api/health`
- OpenAPI: `GET /openapi.json`
- Swagger: `GET /docs`

## 主要接口

- `/api/v1/auth/*`
- `/api/v1/users/me/settings`
- `/api/v1/users/me/simulation-account/status|bind`
- `/api/v1/users/me/trading/*`
- `/api/v1/analysis/*`
- `/api/v1/history*`
- `/api/v1/backtest/*`
- `/api/v1/stocks/*`
- `/api/v1/system/*`
- `/api/v1/admin/users/*`
- `/api/v1/admin/roles/*`
- `/api/v1/admin/logs/*`

说明：`/api/v1/users/me/broker-accounts/*` 与 `/api/v1/internal/agent/*` 已下线。

`/api/v1/backtest/*` 仍由 Backend 对外提供，但回测计算由 Agent 内部接口执行，Backend 负责鉴权、数据落库与返回兼容字段。

## 启动前检查

应用启动前会执行策略回测存储检查。若缺失以下表，服务将拒绝启动：

- `strategy_backtest_run_groups`
- `strategy_backtest_runs`
- `strategy_backtest_trades`
- `strategy_backtest_equity_points`

典型错误消息：

- `strategy backtest tables missing; run db migration`

修复命令：

```bash
pnpm db:push
# 或（已启用 Prisma migrations 的环境）
pnpm prisma:deploy
```

## Simulation 语义

- `POST /api/v1/users/me/simulation-account/bind`
  - 语义：初始化本地 Backtrader 模拟账户（非第三方登录）
  - 入参：`initial_capital` 必填，`account_uid/account_display_name/commission_rate/slippage_bps` 可选
- `GET /api/v1/users/me/simulation-account/status`
  - 返回固定包含：`engine=backtrader`、`provider_code=backtrader_local`

## 交易语义

- `GET /api/v1/users/me/trading/account-summary|positions|orders|trades|performance`
- `POST /api/v1/users/me/trading/orders`
- `POST /api/v1/users/me/trading/orders/cancel`

返回元信息固定为本地通道语义：`order_channel=backtrader_local`。

## 分析执行语义

- `execution_mode=paper`：只分析，不下单
- `execution_mode=auto`：分析完成后由 Worker 自动提交本地模拟盘订单
- 两种模式都要求模拟账户“已初始化且已校验”，否则返回 `412 simulation_account_required`

## 数据清理脚本

```bash
pnpm cleanup:legacy-broker-data
```

用于清理历史 `gmtrade/cn_sim_gateway/simulation/futu` 账户及关联快照/票据/订单数据。
