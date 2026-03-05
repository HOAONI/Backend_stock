import { Controller, Get } from '@nestjs/common';

import { getBacktestStorageReadiness } from '@/common/backtest/backtest-storage-readiness';
import { PrismaService } from '@/common/database/prisma.service';

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
    missing_backtest_tables?: string[];
  }> {
    const timestamp = new Date().toISOString();
    try {
      const readiness = await getBacktestStorageReadiness(this.prisma);
      return {
        status: readiness.ready ? 'ok' : 'degraded',
        timestamp,
        backtest_storage_ready: readiness.ready,
        ...(readiness.ready ? {} : { missing_backtest_tables: readiness.missingTables }),
      };
    } catch {
      return {
        status: 'degraded',
        timestamp,
        backtest_storage_ready: false,
      };
    }
  }
}
