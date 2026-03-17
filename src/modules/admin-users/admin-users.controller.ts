/** 后台用户管理模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';

import {
  CreateAdminUserDto,
  ListAdminUsersQueryDto,
  ResetAdminUserPasswordDto,
  UpdateAdminUserDto,
  UpdateAdminUserStatusDto,
} from './admin-users.dto';
import { AdminUsersService } from './admin-users.service';

interface ServiceError extends Error {
  code?: string;
}

function toHttpException(error: unknown): HttpException {
  const err = error as ServiceError;
  if (err.code === 'NOT_FOUND') {
    return new HttpException({ error: 'not_found', message: err.message }, HttpStatus.NOT_FOUND);
  }
  if (err.code === 'CONFLICT') {
    return new HttpException({ error: 'conflict', message: err.message }, HttpStatus.CONFLICT);
  }
  if (err.code === 'FORBIDDEN') {
    return new HttpException({ error: 'forbidden', message: err.message }, HttpStatus.FORBIDDEN);
  }
  if (err.code === 'VALIDATION_ERROR') {
    return new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
  }

  return new HttpException(
    {
      error: 'internal_error',
      message: err.message || '用户管理请求失败',
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** 负责定义该领域的 HTTP 接口边界，把鉴权后的请求参数整理成服务层可消费的输入。 */
@Controller('/api/v1/admin/users')
export class AdminUsersController {
  constructor(private readonly usersService: AdminUsersService) {}

  @Get('')
  async list(@Query() query: ListAdminUsersQueryDto): Promise<Record<string, unknown>> {
    return await this.usersService.list(query);
  }

  @Post('')
  async create(@Body() body: CreateAdminUserDto): Promise<Record<string, unknown>> {
    try {
      return await this.usersService.create(body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/:id')
  async detail(@Param('id', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    try {
      return await this.usersService.detail(id);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Put('/:id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateAdminUserDto,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.usersService.update(id, body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Put('/:id/status')
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateAdminUserStatusDto,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.usersService.updateStatus(id, body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/:id/reset-password')
  async resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ResetAdminUserPasswordDto,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.usersService.resetPassword(id, body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Delete('/:id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    const operatorId = req.authUser?.id;
    if (!operatorId) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }

    try {
      return await this.usersService.softDelete(id, operatorId);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
