import { Module } from '@nestjs/common';

import { BrokerAccountsController } from './broker-accounts.controller';
import { BrokerAccountsService } from './broker-accounts.service';

@Module({
  controllers: [BrokerAccountsController],
  providers: [BrokerAccountsService],
  exports: [BrokerAccountsService],
})
export class BrokerAccountsModule {}
