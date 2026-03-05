import { Module } from '@nestjs/common';

import { PersonalCryptoService } from '@/common/security/personal-crypto.service';
import { BrokerAccountsModule } from '@/modules/broker-accounts/broker-accounts.module';
import { TradingAccountModule } from '@/modules/trading-account/trading-account.module';

import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';

@Module({
  imports: [BrokerAccountsModule, TradingAccountModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, PersonalCryptoService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
