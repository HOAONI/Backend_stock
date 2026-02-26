import { Module } from '@nestjs/common';

import { AdminLogsController } from './admin-logs.controller';
import { AdminLogsService } from './admin-logs.service';

@Module({
  controllers: [AdminLogsController],
  providers: [AdminLogsService],
  exports: [AdminLogsService],
})
export class AdminLogsModule {}
