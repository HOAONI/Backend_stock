import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';

import {
  CreateBrokerAccountDto,
  ListBrokerAccountsQueryDto,
  UpdateBrokerAccountDto,
} from './broker-accounts.dto';
import { BrokerAccountsService } from './broker-accounts.service';

interface ServiceError extends Error {
  code?: string;
  statusCode?: number;
}

function toHttpException(error: unknown): HttpException {
  const err = error as ServiceError;
  if (err.code === 'NOT_FOUND') {
    return new HttpException({ error: 'not_found', message: err.message }, HttpStatus.NOT_FOUND);
  }
  if (err.code === 'CONFLICT') {
    return new HttpException({ error: 'conflict', message: err.message }, HttpStatus.CONFLICT);
  }
  if (err.code === 'VALIDATION_ERROR') {
    return new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
  }
  if (err.code === 'UPSTREAM_ERROR') {
    return new HttpException(
      { error: 'upstream_error', message: err.message },
      err.statusCode && err.statusCode >= 400 ? err.statusCode : HttpStatus.BAD_GATEWAY,
    );
  }

  return new HttpException(
    {
      error: 'internal_error',
      message: err.message || '券商账户请求失败',
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

@Controller('/api/v1/users/me/broker-accounts')
export class BrokerAccountsController {
  constructor(private readonly brokerAccountsService: BrokerAccountsService) {}

  private requireUserId(req: Request): number {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }
    return userId;
  }

  @Get('')
  async list(
    @Req() req: Request,
    @Query() query: ListBrokerAccountsQueryDto,
  ): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    return await this.brokerAccountsService.listMyAccounts(userId, query.limit);
  }

  @Post('')
  async create(@Req() req: Request, @Body() body: CreateBrokerAccountDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.brokerAccountsService.createMyAccount(userId, body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Put('/:id')
  async update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateBrokerAccountDto,
  ): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.brokerAccountsService.updateMyAccount(userId, id, body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/:id/verify')
  async verify(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.brokerAccountsService.verifyMyAccount(userId, id);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Delete('/:id')
  async remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.brokerAccountsService.deleteMyAccount(userId, id);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
