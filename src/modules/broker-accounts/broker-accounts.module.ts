import { Module } from '@nestjs/common';

import { BrokerAccountsService } from './broker-accounts.service';
import { SimulationAccountController } from './simulation-account.controller';

@Module({
  controllers: [SimulationAccountController],
  providers: [BrokerAccountsService],
  exports: [BrokerAccountsService],
})
export class BrokerAccountsModule {}
