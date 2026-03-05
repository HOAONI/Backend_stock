import { Body, Controller, Get, HttpException, HttpStatus, Post, Req } from '@nestjs/common';
import { Request } from 'express';

import { BindSimulationAccountDto } from './broker-accounts.dto';
import { BrokerAccountsService } from './broker-accounts.service';

interface ServiceError extends Error {
  code?: string;
  statusCode?: number;
}

function toHttpException(error: unknown): HttpException {
  const err = error as ServiceError;
  if (err.code === 'VALIDATION_ERROR') {
    return new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
  }
  if (err.code === 'UPSTREAM_ERROR') {
    return new HttpException(
      { error: 'upstream_error', message: err.message },
      err.statusCode && err.statusCode >= 400 ? err.statusCode : HttpStatus.BAD_GATEWAY,
    );
  }
  if (err.code === 'SIMULATION_ACCOUNT_REQUIRED') {
    return new HttpException(
      { error: 'simulation_account_required', message: err.message },
      HttpStatus.PRECONDITION_FAILED,
    );
  }

  return new HttpException(
    {
      error: 'internal_error',
      message: err.message || '模拟盘账户请求失败',
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

@Controller('/api/v1/users/me/simulation-account')
export class SimulationAccountController {
  constructor(private readonly brokerAccountsService: BrokerAccountsService) {}

  private requireUserId(req: Request): number {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }
    return userId;
  }

  @Get('/status')
  async status(@Req() req: Request): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    return await this.brokerAccountsService.getMySimulationAccountStatus(userId);
  }

  @Post('/bind')
  async bind(@Req() req: Request, @Body() body: BindSimulationAccountDto): Promise<Record<string, unknown>> {
    const userId = this.requireUserId(req);
    try {
      return await this.brokerAccountsService.bindMySimulationAccount(userId, body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
