/** 回测模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsObject,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Request } from 'express';

import { BUILTIN_ROLE_CODES } from '@/common/auth/rbac.constants';
import {
  AGENT_BACKTEST_SCHEMA_NOT_READY_MESSAGE,
  STRATEGY_BACKTEST_SCHEMA_NOT_READY_MESSAGE,
} from '@/common/backtest/backtest-storage-readiness';
import { AgentBacktestService } from './agent-backtest.service';
import { BacktestService } from './backtest.service';
import { BACKTEST_COMPARE_STRATEGY_CODES } from './backtest-compare-strategies';
import { BACKTEST_STRATEGY_CODES } from './backtest-strategy-strategies';
import { UserBacktestStrategyService } from './user-backtest-strategy.service';

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
  @ArrayMaxSize(20)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  strategy_ids?: number[];

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

export class BacktestStrategyCreateDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @IsIn(['ma_cross', 'rsi_threshold'])
  template_code!: string;

  @IsObject()
  params!: Record<string, unknown>;
}

export class BacktestStrategyUpdateDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsIn(['ma_cross', 'rsi_threshold'])
  template_code?: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
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

class AgentBacktestRuntimeStrategyDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  positionMaxPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  stopLossPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(500)
  takeProfitPct?: number;
}

export class AgentBacktestRunRequestDto {
  @IsString()
  code!: string;

  @IsString()
  start_date!: string;

  @IsString()
  end_date!: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  initial_capital?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  commission_rate?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1000)
  slippage_bps?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentBacktestRuntimeStrategyDto)
  runtime_strategy?: AgentBacktestRuntimeStrategyDto;

  @IsOptional()
  @IsBoolean()
  enable_refine = true;
}

export class AgentBacktestRunsQueryDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsIn(['refining', 'completed', 'failed'])
  status?: 'refining' | 'completed' | 'failed';

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

/** 负责定义回测相关 HTTP 接口边界，并把多种回测错误稳定映射成前端可消费的响应语义。 */
@Controller('/api/v1/backtest')
export class BacktestController {
  constructor(
    private readonly backtestService: BacktestService,
    private readonly userBacktestStrategyService: UserBacktestStrategyService,
    private readonly agentBacktestService: AgentBacktestService = {} as AgentBacktestService,
  ) {}

  // Prisma 缺表错误会被统一映射成 schema_not_ready，方便前端明确提示“先跑迁移”。
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

  // 策略回测链路同时会抛业务错误和数据库就绪性错误，这里统一转换成稳定的 HTTP 响应。
  private throwStrategyBacktestHttpError(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }
    const err = error as Error & { code?: string };
    if (err.code === 'VALIDATION_ERROR') {
      throw new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
    }
    if (err.code === 'NOT_FOUND') {
      throw new HttpException({ error: 'not_found', message: err.message }, HttpStatus.NOT_FOUND);
    }
    if (err.code === 'CONFLICT') {
      throw new HttpException({ error: 'conflict', message: err.message }, HttpStatus.CONFLICT);
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

  private throwStrategyLibraryHttpError(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }
    const err = error as Error & { code?: string };
    if (err.code === 'VALIDATION_ERROR') {
      throw new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
    }
    if (err.code === 'NOT_FOUND') {
      throw new HttpException({ error: 'not_found', message: err.message }, HttpStatus.NOT_FOUND);
    }
    if (err.code === 'CONFLICT') {
      throw new HttpException({ error: 'conflict', message: err.message }, HttpStatus.CONFLICT);
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
        message: `用户回测策略操作失败: ${err.message || 'unknown error'}`,
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  private isAgentBacktestSchemaNotReady(error: unknown): boolean {
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
    return tableName.includes('agent_backtest_') || message.includes('agent_backtest_');
  }

  // Agent 回放回测与普通回测共享控制器，但错误来源不同，所以单独保留一套映射逻辑。
  private throwAgentBacktestHttpError(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }
    if (this.isAgentBacktestSchemaNotReady(error)) {
      throw new HttpException(
        {
          error: 'schema_not_ready',
          message: AGENT_BACKTEST_SCHEMA_NOT_READY_MESSAGE,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    throw new HttpException(
      {
        error: 'internal_error',
        message: `Agent 回放回测失败: ${(error as Error).message}`,
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
      includeAll: user.roleCodes.includes(BUILTIN_ROLE_CODES.admin),
    };
  }

  private resolveUserId(req: Request): number {
    const user = req.authUser;
    if (!user) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }
    return user.id;
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

  @Get('/strategies/templates')
  listStrategyTemplates(): Record<string, unknown> {
    return this.userBacktestStrategyService.listTemplates();
  }

  @Get('/strategies')
  async listUserStrategies(@Req() req: Request): Promise<Record<string, unknown>> {
    try {
      return await this.userBacktestStrategyService.listUserStrategies(this.resolveUserId(req));
    } catch (error: unknown) {
      this.throwStrategyLibraryHttpError(error);
    }
  }

  @Post('/strategies')
  async createUserStrategy(@Req() req: Request, @Body() body: BacktestStrategyCreateDto): Promise<Record<string, unknown>> {
    try {
      return await this.userBacktestStrategyService.createUserStrategy(this.resolveUserId(req), {
        name: body.name,
        description: body.description,
        templateCode: body.template_code,
        params: body.params,
      });
    } catch (error: unknown) {
      this.throwStrategyLibraryHttpError(error);
    }
  }

  @Get('/strategies/:strategy_id')
  async getUserStrategy(@Req() req: Request, @Param('strategy_id') strategyId: string): Promise<Record<string, unknown>> {
    const parsedId = Number(strategyId);
    if (!Number.isFinite(parsedId) || parsedId <= 0) {
      throw new HttpException({ error: 'validation_error', message: 'strategy_id 必须为正整数' }, HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.userBacktestStrategyService.getUserStrategy(this.resolveUserId(req), Math.trunc(parsedId));
    } catch (error: unknown) {
      this.throwStrategyLibraryHttpError(error);
    }
  }

  @Patch('/strategies/:strategy_id')
  async updateUserStrategy(
    @Req() req: Request,
    @Param('strategy_id') strategyId: string,
    @Body() body: BacktestStrategyUpdateDto,
  ): Promise<Record<string, unknown>> {
    const parsedId = Number(strategyId);
    if (!Number.isFinite(parsedId) || parsedId <= 0) {
      throw new HttpException({ error: 'validation_error', message: 'strategy_id 必须为正整数' }, HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.userBacktestStrategyService.updateUserStrategy(this.resolveUserId(req), Math.trunc(parsedId), {
        name: body.name,
        description: body.description,
        templateCode: body.template_code,
        params: body.params,
      });
    } catch (error: unknown) {
      this.throwStrategyLibraryHttpError(error);
    }
  }

  @Delete('/strategies/:strategy_id')
  async deleteUserStrategy(@Req() req: Request, @Param('strategy_id') strategyId: string): Promise<Record<string, unknown>> {
    const parsedId = Number(strategyId);
    if (!Number.isFinite(parsedId) || parsedId <= 0) {
      throw new HttpException({ error: 'validation_error', message: 'strategy_id 必须为正整数' }, HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.userBacktestStrategyService.deleteUserStrategy(this.resolveUserId(req), Math.trunc(parsedId));
    } catch (error: unknown) {
      this.throwStrategyLibraryHttpError(error);
    }
  }

  @Post('/strategy/run')
  async runStrategy(@Req() req: Request, @Body() body: BacktestStrategyRunRequestDto): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    try {
      return await this.backtestService.runStrategyRange({
        code: body.code,
        startDate: body.start_date,
        endDate: body.end_date,
        strategyIds: body.strategy_ids,
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
          message: 'run_group_id 必须为正整数',
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

  @Post('/agent/run')
  async runAgentBacktest(@Req() req: Request, @Body() body: AgentBacktestRunRequestDto): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    try {
      return await this.agentBacktestService.runAgentRange({
        code: body.code,
        startDate: body.start_date,
        endDate: body.end_date,
        initialCapital: body.initial_capital,
        commissionRate: body.commission_rate,
        slippageBps: body.slippage_bps,
        runtimeStrategy: body.runtime_strategy,
        enableRefine: body.enable_refine,
        requester: scope,
      });
    } catch (error: unknown) {
      this.throwAgentBacktestHttpError(error);
    }
  }

  @Get('/agent/runs')
  async listAgentRuns(@Req() req: Request, @Query() query: AgentBacktestRunsQueryDto): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    try {
      return await this.agentBacktestService.listAgentRuns({
        code: query.code,
        status: query.status,
        startDate: query.start_date,
        endDate: query.end_date,
        page: query.page,
        limit: query.limit,
        requester: scope,
      });
    } catch (error: unknown) {
      this.throwAgentBacktestHttpError(error);
    }
  }

  @Get('/agent/runs/:run_group_id')
  async getAgentRunDetail(@Req() req: Request, @Param('run_group_id') runGroupId: string): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    const parsedId = Number(runGroupId);
    if (!Number.isFinite(parsedId) || parsedId <= 0) {
      throw new HttpException(
        {
          error: 'validation_error',
          message: 'run_group_id 必须为正整数',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    let detail: Record<string, unknown> | null = null;
    try {
      detail = await this.agentBacktestService.getAgentRunDetail({
        runGroupId: Math.trunc(parsedId),
        requester: scope,
      });
    } catch (error: unknown) {
      this.throwAgentBacktestHttpError(error);
    }
    if (!detail) {
      throw new HttpException(
        {
          error: 'not_found',
          message: `未找到 Agent 回放回测记录: ${parsedId}`,
        },
        HttpStatus.NOT_FOUND,
      );
    }
    return detail;
  }
}
