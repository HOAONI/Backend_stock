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
