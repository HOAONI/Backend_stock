import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Request } from 'express';

import { STRATEGY_BACKTEST_SCHEMA_NOT_READY_MESSAGE } from '@/common/backtest/backtest-storage-readiness';
import { BacktestService } from './backtest.service';
import { BACKTEST_COMPARE_STRATEGY_CODES } from './backtest-compare-strategies';
import { BACKTEST_STRATEGY_CODES } from './backtest-strategy-strategies';

class BacktestRunRequestDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsBoolean()
  force = false;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  eval_window_days?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  min_age_days?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2000)
  limit = 200;
}

class BacktestScopeQueryDto {
  @IsOptional()
  @IsIn(['overall', 'stock'])
  scope: 'overall' | 'stock' = 'overall';

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  eval_window_days?: number;

  @IsOptional()
  @IsIn(['portfolio', 'sequential'])
  equity_mode?: 'portfolio' | 'sequential';
}

export class BacktestCompareRequestDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(120, { each: true })
  eval_window_days_list!: number[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsIn([...BACKTEST_COMPARE_STRATEGY_CODES], { each: true })
  strategy_codes?: string[];
}

export class BacktestStrategyRunRequestDto {
  @IsString()
  code!: string;

  @IsString()
  start_date!: string;

  @IsString()
  end_date!: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsIn([...BACKTEST_STRATEGY_CODES], { each: true })
  strategy_codes?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  initial_capital?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(1)
  commission_rate?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(1000)
  slippage_bps?: number;
}

export class BacktestStrategyRunsQueryDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  strategy_code?: string;

  @IsOptional()
  @IsString()
  start_date?: string;

  @IsOptional()
  @IsString()
  end_date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 20;
}

@Controller('/api/v1/backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  private isStrategyBacktestSchemaNotReady(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const row = error as {
      code?: unknown;
      message?: unknown;
      meta?: { table?: unknown };
    };

    if (String(row.code ?? '') !== 'P2021') {
      return false;
    }

    const tableName = String(row.meta?.table ?? '').toLowerCase();
    const message = String(row.message ?? '').toLowerCase();
    return tableName.includes('strategy_backtest_') || message.includes('strategy_backtest_');
  }

  private throwStrategyBacktestHttpError(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }
    if (this.isStrategyBacktestSchemaNotReady(error)) {
      throw new HttpException(
        {
          error: 'schema_not_ready',
          message: STRATEGY_BACKTEST_SCHEMA_NOT_READY_MESSAGE,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    throw new HttpException(
      {
        error: 'internal_error',
        message: `策略回测失败: ${(error as Error).message}`,
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

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

  @Post('/run')
  async run(@Body() body: BacktestRunRequestDto, @Req() req: Request): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    try {
      const data = await this.backtestService.run({
        code: body.code,
        force: body.force,
        evalWindowDays: body.eval_window_days,
        minAgeDays: body.min_age_days,
        limit: body.limit,
        scope,
      });
      return { ...data, legacy_event_backtest: true };
    } catch (error: unknown) {
      throw new HttpException(
        {
          error: 'internal_error',
          message: `回测执行失败: ${(error as Error).message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('/results')
  async results(
    @Req() req: Request,
    @Query('code') code?: string,
    @Query('eval_window_days') evalWindowDays?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    const parsedPage = Number(page);
    const parsedLimit = Number(limit);

    const data = await this.backtestService.listResults({
      code,
      evalWindowDays: evalWindowDays != null ? Number(evalWindowDays) : undefined,
      page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 20,
      scope,
    });
    return { ...data, legacy_event_backtest: true };
  }

  @Get('/performance')
  async performance(@Req() req: Request, @Query('eval_window_days') evalWindowDays?: string): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    const summary = await this.backtestService.getSummary(
      'overall',
      undefined,
      evalWindowDays ? Number(evalWindowDays) : undefined,
      scope,
    );
    if (!summary) {
      throw new HttpException(
        {
          error: 'not_found',
          message: '未找到整体回测汇总',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      ...summary,
      warnings: evalWindowDays == null ? ['eval_window_days not provided, default window applied'] : [],
      legacy_event_backtest: true,
    };
  }

  @Get('/performance/:code')
  async stockPerformance(
    @Param('code') code: string,
    @Req() req: Request,
    @Query('eval_window_days') evalWindowDays?: string,
  ): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    const summary = await this.backtestService.getSummary('stock', code, evalWindowDays ? Number(evalWindowDays) : undefined, scope);
    if (!summary) {
      throw new HttpException(
        {
          error: 'not_found',
          message: `未找到 ${code} 的回测汇总`,
        },
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      ...summary,
      warnings: evalWindowDays == null ? ['eval_window_days not provided, default window applied'] : [],
      legacy_event_backtest: true,
    };
  }

  @Get('/curves')
  async curves(@Req() req: Request, @Query() query: BacktestScopeQueryDto): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    if (query.scope === 'stock' && !String(query.code ?? '').trim()) {
      throw new HttpException(
        {
          error: 'validation_error',
          message: 'scope=stock requires code',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const data = await this.backtestService.getCurves({
      scope: query.scope,
      code: query.code,
      evalWindowDays: query.eval_window_days,
      equityMode: query.equity_mode,
      requester: scope,
    });
    return { ...data, legacy_event_backtest: true };
  }

  @Get('/distribution')
  async distribution(@Req() req: Request, @Query() query: BacktestScopeQueryDto): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    if (query.scope === 'stock' && !String(query.code ?? '').trim()) {
      throw new HttpException(
        {
          error: 'validation_error',
          message: 'scope=stock requires code',
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const data = await this.backtestService.getDistribution({
      scope: query.scope,
      code: query.code,
      evalWindowDays: query.eval_window_days,
      requester: scope,
    });
    return { ...data, legacy_event_backtest: true };
  }

  @Post('/compare')
  async compare(@Req() req: Request, @Body() body: BacktestCompareRequestDto): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    const data = await this.backtestService.compareWindows({
      code: body.code,
      evalWindowDaysList: body.eval_window_days_list,
      strategyCodes: body.strategy_codes,
      requester: scope,
    });
    return { ...data, legacy_event_backtest: true };
  }

  @Post('/strategy/run')
  async runStrategy(@Req() req: Request, @Body() body: BacktestStrategyRunRequestDto): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    try {
      return await this.backtestService.runStrategyRange({
        code: body.code,
        startDate: body.start_date,
        endDate: body.end_date,
        strategyCodes: body.strategy_codes,
        initialCapital: body.initial_capital,
        commissionRate: body.commission_rate,
        slippageBps: body.slippage_bps,
        requester: scope,
      });
    } catch (error: unknown) {
      this.throwStrategyBacktestHttpError(error);
    }
  }

  @Get('/strategy/runs')
  async listStrategyRuns(@Req() req: Request, @Query() query: BacktestStrategyRunsQueryDto): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    try {
      return await this.backtestService.listStrategyRuns({
        code: query.code,
        strategyCode: query.strategy_code,
        startDate: query.start_date,
        endDate: query.end_date,
        page: query.page,
        limit: query.limit,
        requester: scope,
      });
    } catch (error: unknown) {
      this.throwStrategyBacktestHttpError(error);
    }
  }

  @Get('/strategy/runs/:run_group_id')
  async getStrategyRunDetail(@Req() req: Request, @Param('run_group_id') runGroupId: string): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    const parsedId = Number(runGroupId);
    if (!Number.isFinite(parsedId) || parsedId <= 0) {
      throw new HttpException(
        {
          error: 'validation_error',
          message: 'run_group_id must be positive integer',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    let detail: Record<string, unknown> | null = null;
    try {
      detail = await this.backtestService.getStrategyRunDetail({
        runGroupId: Math.trunc(parsedId),
        requester: scope,
      });
    } catch (error: unknown) {
      this.throwStrategyBacktestHttpError(error);
    }
    if (!detail) {
      throw new HttpException(
        {
          error: 'not_found',
          message: `未找到策略回测记录: ${parsedId}`,
        },
        HttpStatus.NOT_FOUND,
      );
    }
    return detail;
  }
}
