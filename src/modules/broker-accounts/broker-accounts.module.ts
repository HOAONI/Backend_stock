/** 模拟账户模块的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Module } from '@nestjs/common';

import { BrokerAccountsService } from './broker-accounts.service';
import { SimulationAccountController } from './simulation-account.controller';

@Module({
  controllers: [SimulationAccountController],
  providers: [BrokerAccountsService],
  exports: [BrokerAccountsService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class BrokerAccountsModule {}
