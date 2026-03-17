/** 后台角色管理模块的模块装配文件，用于声明控制器、服务与依赖关系。 */

import { Module } from '@nestjs/common';

import { AdminRolesController } from './admin-roles.controller';
import { AdminRolesService } from './admin-roles.service';

@Module({
  controllers: [AdminRolesController],
  providers: [AdminRolesService],
  exports: [AdminRolesService],
})
/** 负责把该领域需要的控制器、服务与依赖声明组装到同一个 Nest 模块里。 */
export class AdminRolesModule {}
