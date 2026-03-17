/** AI 运行时基础设施的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Module } from '@nestjs/common';

import { AgentClientModule } from '@/common/agent/agent-client.module';
import { PersonalCryptoService } from '@/common/security/personal-crypto.service';
import { SystemConfigModule } from '@/modules/system-config/system-config.module';

import { AiRuntimeService } from './ai-runtime.service';

@Module({
  imports: [SystemConfigModule, AgentClientModule],
  providers: [AiRuntimeService, PersonalCryptoService],
  exports: [AiRuntimeService, PersonalCryptoService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class AiRuntimeModule {}
