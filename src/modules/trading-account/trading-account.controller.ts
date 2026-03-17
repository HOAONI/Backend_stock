/** 交易账户模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import { Controller, Get, Post, HttpException, HttpStatus, Query, Req, Body, Headers } from '@nestjs/common';
import { Request } from 'express';

import { AddFundsDto, TradingAccountQueryDto, PlaceOrderDto, CancelOrderDto } from './trading-account.dto';
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
  if (err.code === 'SIMULATION_ACCOUNT_REQUIRED') {
    return new HttpException(
      { error: 'simulation_account_required', message: err.message },
      HttpStatus.PRECONDITION_FAILED,
    );
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

/** 负责定义该领域的 HTTP 接口边界，把鉴权后的请求参数整理成服务层可消费的输入。 */
@Controller('/api/v1/users/me/trading')
export class TradingAccountController {
  constructor(private readonly tradingAccountService: TradingAccountService) {}

  // 交易接口底层完全依赖当前用户绑定的模拟盘上下文，因此必须先拿到稳定的 userId。
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
      return await this.tradingAccountService.getAccountSummary(userId, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/positions')
  async positions(@Req() req: Request, @Query() query: TradingAccountQueryDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.getPositions(userId, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/orders')
  async orders(@Req() req: Request, @Query() query: TradingAccountQueryDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.getOrders(userId, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/trades')
  async trades(@Req() req: Request, @Query() query: TradingAccountQueryDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.getTrades(userId, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/performance')
  async performance(@Req() req: Request, @Query() query: TradingAccountQueryDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.getPerformance(userId, query.refresh);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/funds/add')
  async addFunds(@Req() req: Request, @Body() body: AddFundsDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.addFunds(userId, {
        amount: body.amount,
        note: body.note,
      });
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  // 下单支持 body/header 两种幂等键入口，便于前端和自动化任务分别接入。
  @Post('/orders')
  async placeOrder(
    @Req() req: Request,
    @Body() body: PlaceOrderDto,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
  ): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.placeOrder(userId, {
        stock_code: body.stock_code,
        stock_name: body.stock_name,
        direction: body.direction,
        type: body.type,
        price: body.price,
        quantity: body.quantity,
        idempotency_key: body.idempotency_key || idempotencyKeyHeader,
      });
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/orders/cancel')
  async cancelOrder(
    @Req() req: Request,
    @Body() body: CancelOrderDto,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
  ): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.tradingAccountService.cancelOrder(userId, body.order_id, body.idempotency_key || idempotencyKeyHeader);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
