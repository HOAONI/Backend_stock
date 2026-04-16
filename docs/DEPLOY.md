# Deploy (Backtrader Local)

## 1. 环境准备

1. 复制并配置环境变量：

```bash
cp .env.example .env
```

2. 关键变量检查：

- `DATABASE_URL`
- `AGENT_BASE_URL`
- `AGENT_SERVICE_AUTH_TOKEN`
- `BACKTRADER_AGENT_BASE_URL`
- `BACKTRADER_AGENT_TOKEN`
- `BACKTRADER_AGENT_TIMEOUT_MS`
- `SIMULATION_BIND_BROKER_CODE=backtrader_local`
- `SIM_PROVIDER_DEFAULT_CODE=backtrader_local`
- `BROKER_SECRET_KEY`
- `PERSONAL_SECRET_KEY`（个人 AI 绑定必需，可用 `openssl rand -hex 32` 生成）
- `ANALYSIS_AUTO_ORDER_*`（风控参数）

3. 若启用后台登录鉴权：

- `ADMIN_AUTH_ENABLED=true`
- `ADMIN_INIT_USERNAME`
- `ADMIN_INIT_PASSWORD`

## 2. 安装与数据库

```bash
pnpm install
pnpm db:init
```

生产环境（新库）推荐：

```bash
pnpm prisma:deploy
pnpm db:constraints
```

如果是历史库（此前通过 `db push` 初始化，尚未接入 migrate history），先确保 schema 对齐：

```bash
pnpm db:push
pnpm prisma:generate
```

然后可将 baseline 标记为已应用（一次性）：

```bash
pnpm exec prisma migrate resolve --applied 20260305074500_baseline
```

## 3. 构建与启动

仅运行 Backend 开发模式（API+Worker 同进程）：

```bash
pnpm start:dev:all
```

整套系统启动（请在仓库根目录执行）：

```bash
bash scripts/system/start.sh
bash scripts/system/start.sh --dev-backend
# 首次建库 / 历史库补齐时再显式 prepare
bash scripts/system/start.sh --prepare-db
bash scripts/system/start.sh --dev-backend --prepare-db
```

停止整套系统：

```bash
bash scripts/system/stop.sh
```

生产模式（仅 Backend）：

```bash
pnpm build
pnpm start:api
pnpm start:worker
```

说明：

- 根目录 `bash scripts/system/start.sh` / `bash scripts/system/start.sh --dev-backend` 默认只做只读 schema 检查，日志写入聚合工作区根目录下的 `logs/system/backend-db-check.log`。
- 只有显式传入 `--prepare-db` 时，才会执行重型 schema prepare，日志写入聚合工作区根目录下的 `logs/system/backend-db-prepare.log`。
- 如果默认检查提示 migration history 未收尾但结构已经齐全，先进入 `Backend_stock` 执行一次 `pnpm db:repair:migration-history`。
- 直接运行 `pnpm start:all` / `pnpm start:dev:all` / `pnpm start:api` 时，仍需先手动完成 `pnpm prisma:deploy` 或 `pnpm db:push`。
- `start:*` 是 `Backend_stock` 进程级入口，根目录 `scripts/system/*.sh` 是整套系统入口。

## 4. 健康检查

- `GET /api/health`
- `GET /api/health/live`
- `GET /api/health/ready`

`/api/health/ready` 返回中包含 `backtest_storage_ready`。  
若策略回测持久化表缺失，后端在启动阶段会直接失败并给出：

- `strategy backtest tables missing; run db migration`

## 5. 关键业务校验

- `GET /api/v1/users/me/simulation-account/status`
  - 应包含 `engine=backtrader`、`provider_code=backtrader_local`
- `POST /api/v1/users/me/simulation-account/bind`
  - 仅本地初始化语义
- `GET /api/v1/users/me/trading/*`
  - 返回通道应为 `order_channel=backtrader_local`

## 6. 兼容性说明

以下接口已下线：

- `/api/v1/users/me/broker-accounts/*`
- `/api/v1/internal/agent/*`
