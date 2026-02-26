import { Module } from '@nestjs/common';

import { StocksModule } from '@/modules/stocks/stocks.module';

import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';

@Module({
  imports: [StocksModule],
  controllers: [BacktestController],
  providers: [BacktestService],
  exports: [BacktestService],
})
export class BacktestModule {}
