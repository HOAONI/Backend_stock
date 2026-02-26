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
} from '@nestjs/common';

import { AdminRolesService } from './admin-roles.service';
import { CreateAdminRoleDto, ListAdminRolesQueryDto, UpdateAdminRoleDto } from './admin-roles.dto';

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
      message: err.message || '角色管理请求失败',
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

@Controller('/api/v1/admin/roles')
export class AdminRolesController {
  constructor(private readonly rolesService: AdminRolesService) {}

  @Get('')
  async list(@Query() query: ListAdminRolesQueryDto): Promise<Record<string, unknown>> {
    return await this.rolesService.list(query);
  }

  @Post('')
  async create(@Body() body: CreateAdminRoleDto): Promise<Record<string, unknown>> {
    try {
      return await this.rolesService.create(body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/:id')
  async detail(@Param('id', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    try {
      return await this.rolesService.detail(id);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Put('/:id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateAdminRoleDto,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.rolesService.update(id, body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Delete('/:id')
  async remove(@Param('id', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    try {
      return await this.rolesService.softDelete(id);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
