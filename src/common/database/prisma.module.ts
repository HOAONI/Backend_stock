/** 数据库基础设施的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class PrismaModule {}
