import { Module } from '@nestjs/common';

import { PrismaModule } from '@/common/database/prisma.module';
import { PersonalCryptoService } from '@/common/security/personal-crypto.service';

import { UserSettingsController } from './user-settings.controller';
import { UserSettingsService } from './user-settings.service';

@Module({
  imports: [PrismaModule],
  controllers: [UserSettingsController],
  providers: [UserSettingsService, PersonalCryptoService],
})
export class UserSettingsModule {}
