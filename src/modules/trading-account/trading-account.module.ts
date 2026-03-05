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
export class TradingAccountModule {}
