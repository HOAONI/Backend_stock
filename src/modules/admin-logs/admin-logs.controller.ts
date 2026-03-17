/** 后台审计日志模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import { Controller, Get, HttpException, HttpStatus, Param, ParseIntPipe, Query, Req } from '@nestjs/common';
import { Request } from 'express';

import { BUILTIN_ROLE_CODES } from '@/common/auth/rbac.constants';
import { ListAdminLogsQueryDto } from './admin-logs.dto';
import { AdminLogsService } from './admin-logs.service';

interface ServiceError extends Error {
  code?: string;
}

function toHttpException(error: unknown): HttpException {
  const err = error as ServiceError;
  if (err.code === 'NOT_FOUND') {
    return new HttpException({ error: 'not_found', message: err.message }, HttpStatus.NOT_FOUND);
  }

  return new HttpException(
    {
      error: 'internal_error',
      message: err.message || '操作日志请求失败',
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** 负责定义该领域的 HTTP 接口边界，把鉴权后的请求参数整理成服务层可消费的输入。 */
@Controller('/api/v1/admin/logs')
export class AdminLogsController {
  constructor(private readonly logsService: AdminLogsService) {}

  private resolveScope(req: Request): { userId: number; includeAll: boolean } {
    const user = req.authUser;
    if (!user) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }
    return {
      userId: user.id,
      includeAll: user.roleCodes.includes(BUILTIN_ROLE_CODES.admin),
    };
  }

  @Get('')
  async list(@Req() req: Request, @Query() query: ListAdminLogsQueryDto): Promise<Record<string, unknown>> {
    return await this.logsService.list(query, this.resolveScope(req));
  }

  @Get('/:id')
  async detail(@Param('id', ParseIntPipe) id: number, @Req() req: Request): Promise<Record<string, unknown>> {
    try {
      return await this.logsService.detail(id, this.resolveScope(req));
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
