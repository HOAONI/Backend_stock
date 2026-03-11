import { Module } from '@nestjs/common';

import { AiRuntimeModule } from '@/common/ai/ai-runtime.module';
import { PrismaModule } from '@/common/database/prisma.module';

import { UserSettingsController } from './user-settings.controller';
import { UserSettingsService } from './user-settings.service';

@Module({
  imports: [PrismaModule, AiRuntimeModule],
  controllers: [UserSettingsController],
  providers: [UserSettingsService],
})
export class UserSettingsModule {}
