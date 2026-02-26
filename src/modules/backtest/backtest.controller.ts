import { Body, Controller, Get, HttpException, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Request } from 'express';

import { BacktestService } from './backtest.service';

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
}

class BacktestCompareRequestDto {
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
}

@Controller('/api/v1/backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

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
      return await this.backtestService.run({
        code: body.code,
        force: body.force,
        evalWindowDays: body.eval_window_days,
        minAgeDays: body.min_age_days,
        limit: body.limit,
        scope,
      });
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

    return await this.backtestService.listResults({
      code,
      evalWindowDays: evalWindowDays != null ? Number(evalWindowDays) : undefined,
      page: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
      limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 20,
      scope,
    });
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

    return summary;
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

    return summary;
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

    return await this.backtestService.getCurves({
      scope: query.scope,
      code: query.code,
      evalWindowDays: query.eval_window_days,
      requester: scope,
    });
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

    return await this.backtestService.getDistribution({
      scope: query.scope,
      code: query.code,
      evalWindowDays: query.eval_window_days,
      requester: scope,
    });
  }

  @Post('/compare')
  async compare(@Req() req: Request, @Body() body: BacktestCompareRequestDto): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    return await this.backtestService.compareWindows({
      code: body.code,
      evalWindowDaysList: body.eval_window_days_list,
      requester: scope,
    });
  }
}
