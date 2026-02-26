import { Controller, Get, Post, HttpException, HttpStatus, Query, Req, Body } from '@nestjs/common';
import { Request } from 'express';

import { TradingAccountQueryDto, PlaceOrderDto, CancelOrderDto } from './trading-account.dto';
import { TradingAccountService } from './trading-account.service';

interface ServiceError extends Error {
  code?: string;
  statusCode?: number;
}

function toHttpException(error: unknown): HttpException {
  const err = error as ServiceError;
  if (err.code === 'NOT_FOUND') {
    return new HttpException({ error: 'not_found', message: err.message }, HttpStatus.NOT_FOUND);
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
  if (err.code === 'NOT_SUPPORTED') {
    return new HttpException({ error: 'not_supported', message: err.message }, HttpStatus.METHOD_NOT_ALLOWED);
  }

  return new HttpException(
    {
      error: 'internal_error',
      message: err.message || '交易账户请求失败',
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

@Controller('/api/v1/users/me/trading')
export class TradingAccountController {
  constructor(private readonly tradingAccountService: TradingAccountService) {}

  private requireUserId(req: Request): number {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }
    return userId;
  }

  @Get('/account-summary')
  async accountSummary(@Req() req: Request, @Query() query: TradingAccountQueryDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.getAccountSummary(userId, query.broker_account_id, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/positions')
  async positions(@Req() req: Request, @Query() query: TradingAccountQueryDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.getPositions(userId, query.broker_account_id, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/orders')
  async orders(@Req() req: Request, @Query() query: TradingAccountQueryDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.getOrders(userId, query.broker_account_id, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/trades')
  async trades(@Req() req: Request, @Query() query: TradingAccountQueryDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.getTrades(userId, query.broker_account_id, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/performance')
  async performance(@Req() req: Request, @Query() query: TradingAccountQueryDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.getPerformance(userId, query.broker_account_id, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/orders')
  async placeOrder(@Req() req: Request, @Body() body: PlaceOrderDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.placeOrder(userId, body.broker_account_id, {
        stock_code: body.stock_code,
        stock_name: body.stock_name,
        direction: body.direction,
        type: body.type,
        price: body.price,
        quantity: body.quantity,
      });
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/orders/cancel')
  async cancelOrder(@Req() req: Request, @Body() body: CancelOrderDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.cancelOrder(userId, body.broker_account_id, body.order_id);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
