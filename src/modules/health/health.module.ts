/** 健康检查模块的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class HealthModule {}
