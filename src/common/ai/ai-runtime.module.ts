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
export class AiRuntimeModule {}
