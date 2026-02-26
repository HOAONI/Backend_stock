import { Controller, Get, HttpException, HttpStatus, Param, ParseIntPipe, Query, Req } from '@nestjs/common';
import { Request } from 'express';

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
      includeAll: user.roleCodes.includes('super_admin'),
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
