import { Module } from '@nestjs/common';

import { PersonalCryptoService } from '@/common/security/personal-crypto.service';
import { AgentBridgeModule } from '@/modules/agent-bridge/agent-bridge.module';

import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';

@Module({
  imports: [AgentBridgeModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, PersonalCryptoService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
