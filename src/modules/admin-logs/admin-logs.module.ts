/** 后台审计日志模块的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Module } from '@nestjs/common';

import { AdminLogsController } from './admin-logs.controller';
import { AdminLogsService } from './admin-logs.service';

@Module({
  controllers: [AdminLogsController],
  providers: [AdminLogsService],
  exports: [AdminLogsService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class AdminLogsModule {}
