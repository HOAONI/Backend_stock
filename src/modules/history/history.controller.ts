import { Controller, Get, HttpException, HttpStatus, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';

import { BUILTIN_ROLE_CODES } from '@/common/auth/rbac.constants';
import { HistoryService } from './history.service';

@Controller('/api/v1/history')
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

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

  @Get('')
  async list(
    @Req() req: Request,
    @Query('stock_code') stockCode?: string,
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    const parsedPage = Number(page);
    const parsedLimit = Number(limit);

    const safePage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20;

    const result = await this.historyService.list({
      stockCode,
      startDate,
      endDate,
      page: safePage,
      limit: safeLimit,
      scope,
    });

    return {
      total: result.total,
      page: safePage,
      limit: safeLimit,
      items: result.items,
    };
  }

  @Get('/:query_id')
  async detail(@Param('query_id') queryId: string, @Req() req: Request): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    const result = await this.historyService.detail(queryId, scope);
    if (!result) {
      throw new HttpException(
        {
          error: 'not_found',
          message: `未找到 query_id=${queryId} 的分析记录`,
        },
        HttpStatus.NOT_FOUND,
      );
    }

    return result;
  }

  @Get('/:query_id/news')
  async news(@Param('query_id') queryId: string, @Req() req: Request, @Query('limit') limit = '20'): Promise<Record<string, unknown>> {
    const scope = this.resolveScope(req);
    const parsedLimit = Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20;

    const items = await this.historyService.getNews(queryId, safeLimit, scope);

    return {
      total: items.length,
      items,
    };
  }
}
