/** 交易账户模块的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Module } from '@nestjs/common';

import { BrokerAccountsModule } from '@/modules/broker-accounts/broker-accounts.module';

import { TradingAccountController } from './trading-account.controller';
import { TradingAccountService } from './trading-account.service';

@Module({
  imports: [BrokerAccountsModule],
  controllers: [TradingAccountController],
  providers: [TradingAccountService],
  exports: [TradingAccountService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class TradingAccountModule {}
