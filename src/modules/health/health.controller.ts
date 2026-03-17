/** 健康检查模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import { Controller, Get } from '@nestjs/common';

import {
  getAgentBacktestStorageReadiness,
  getBacktestStorageReadiness,
} from '@/common/backtest/backtest-storage-readiness';
import { PrismaService } from '@/common/database/prisma.service';

/** 负责定义该领域的 HTTP 接口边界，把鉴权后的请求参数整理成服务层可消费的输入。 */
@Controller('/api/health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  health(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('/live')
  live(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('/ready')
  async ready(): Promise<{
    status: string;
    timestamp: string;
    backtest_storage_ready: boolean;
    agent_backtest_storage_ready: boolean;
    missing_backtest_tables?: string[];
    missing_agent_backtest_tables?: string[];
  }> {
    const timestamp = new Date().toISOString();
    try {
      const [readiness, agentReadiness] = await Promise.all([
        getBacktestStorageReadiness(this.prisma),
        getAgentBacktestStorageReadiness(this.prisma),
      ]);
      return {
        status: readiness.ready && agentReadiness.ready ? 'ok' : 'degraded',
        timestamp,
        backtest_storage_ready: readiness.ready,
        agent_backtest_storage_ready: agentReadiness.ready,
        ...(readiness.ready ? {} : { missing_backtest_tables: readiness.missingTables }),
        ...(agentReadiness.ready ? {} : { missing_agent_backtest_tables: agentReadiness.missingTables }),
      };
    } catch {
      return {
        status: 'degraded',
        timestamp,
        backtest_storage_ready: false,
        agent_backtest_storage_ready: false,
      };
    }
  }
}
