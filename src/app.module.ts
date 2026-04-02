/** 应用根模块，统一装配业务模块并挂载全局中间件。 */

import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AgentClientModule } from './common/agent/agent-client.module';
import { BrokerModule } from './common/broker/broker.module';
import { PrismaModule } from './common/database/prisma.module';
import { AuthGuardMiddleware } from './common/auth/auth-guard.middleware';
import { AuditLogMiddleware } from './common/auth/audit-log.middleware';
import { WorkerModule } from './common/worker/worker.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { AgentChatModule } from './modules/agent-chat/agent-chat.module';
import { AdminLogsModule } from './modules/admin-logs/admin-logs.module';
import { AdminRolesModule } from './modules/admin-roles/admin-roles.module';
import { AdminUsersModule } from './modules/admin-users/admin-users.module';
import { AuthModule } from './modules/auth/auth.module';
import { BacktestModule } from './modules/backtest/backtest.module';
import { BrokerAccountsModule } from './modules/broker-accounts/broker-accounts.module';
import { HealthModule } from './modules/health/health.module';
import { HistoryModule } from './modules/history/history.module';
import { StocksModule } from './modules/stocks/stocks.module';
import { SystemConfigModule } from './modules/system-config/system-config.module';
import { TradingAccountModule } from './modules/trading-account/trading-account.module';
import { UserSettingsModule } from './modules/user-settings/user-settings.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    BrokerModule,
    AgentClientModule,
    WorkerModule,
    HealthModule,
    AuthModule,
    BrokerAccountsModule,
    TradingAccountModule,
    SystemConfigModule,
    AnalysisModule,
    HistoryModule,
    BacktestModule,
    StocksModule,
    UserSettingsModule,
    AgentChatModule,
    AdminUsersModule,
    AdminRolesModule,
    AdminLogsModule,
  ],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 审计日志放在鉴权之前，这样登录失败、权限不足等请求也能留下完整轨迹。
    consumer
      .apply(AuditLogMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });

    // 这些接口必须允许匿名访问，否则健康检查、认证入口和文档页都会被鉴权中间件拦住。
    consumer
      .apply(AuthGuardMiddleware)
      .exclude(
        { path: '/api/health', method: RequestMethod.GET },
        { path: '/api/health/live', method: RequestMethod.GET },
        { path: '/api/health/ready', method: RequestMethod.GET },
        { path: '/api/v1/auth/status', method: RequestMethod.GET },
        { path: '/api/v1/auth/login', method: RequestMethod.POST },
        { path: '/api/v1/auth/register', method: RequestMethod.POST },
        { path: '/api/v1/auth/logout', method: RequestMethod.POST },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
