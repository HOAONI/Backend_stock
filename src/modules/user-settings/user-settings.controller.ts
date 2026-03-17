/** 用户个人设置模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import { Body, Controller, Get, HttpException, HttpStatus, Put, Req } from '@nestjs/common';
import { Request } from 'express';

import { UpdateUserSettingsDto } from './user-settings.dto';
import { UserSettingsService } from './user-settings.service';

interface ServiceError extends Error {
  code?: string;
}

function toHttpException(error: unknown): HttpException {
  const err = error as ServiceError;
  if (err.code === 'VALIDATION_ERROR') {
    return new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
  }

  return new HttpException(
    {
      error: 'internal_error',
      message: err.message || '用户个人设置操作失败',
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** 负责定义该领域的 HTTP 接口边界，把鉴权后的请求参数整理成服务层可消费的输入。 */
@Controller('/api/v1/users/me/settings')
export class UserSettingsController {
  constructor(private readonly userSettingsService: UserSettingsService) {}

  @Get('')
  async getMySettings(@Req() req: Request): Promise<Record<string, unknown>> {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }

    return await this.userSettingsService.getMySettings(userId);
  }

  @Put('')
  async updateMySettings(@Req() req: Request, @Body() body: UpdateUserSettingsDto): Promise<Record<string, unknown>> {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }

    try {
      return await this.userSettingsService.updateMySettings(userId, body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
