import { Body, Controller, Get, HttpException, HttpStatus, Param, Patch, Post, Query, Req, Res, Sse } from '@nestjs/common';
import { Request, Response } from 'express';
import { interval, Observable, of, startWith, switchMap } from 'rxjs';

import { BUILTIN_ROLE_CODES } from '@/common/auth/rbac.constants';
import { AnalyzeRequestDto } from './analysis.dto';
import { AnalysisSchedulerService } from './analysis-scheduler.service';
import { AnalysisService } from './analysis.service';

interface MessageEvent {
  data: unknown;
  type?: string;
}

@Controller('/api/v1/analysis')
export class AnalysisController {
  constructor(
    private readonly analysisService: AnalysisService,
    private readonly analysisSchedulerService: AnalysisSchedulerService,
  ) {}

  private getRequesterScope(req: Request): { userId: number; includeAll: boolean } {
    const user = req.authUser;
    if (!user) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }
    return {
      userId: user.id,
      includeAll: user.roleCodes.includes(BUILTIN_ROLE_CODES.admin),
    };
  }

  private parseBooleanFlag(value: string | boolean | null | undefined): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    return String(value ?? '').trim().toLowerCase() === 'true';
  }

  private throwSchedulerError(error: unknown): never {
    const err = error as Error & { code?: string };
    if (err.code === 'VALIDATION_ERROR') {
      throw new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
    }
    if (err.code === 'FORBIDDEN') {
      throw new HttpException({ error: 'forbidden', message: err.message }, HttpStatus.FORBIDDEN);
    }
    if (err.code === 'INVALID_TASK_STATUS' || err.code === 'DUPLICATE_TASK') {
      throw new HttpException({ error: 'conflict', message: err.message }, HttpStatus.CONFLICT);
    }
    throw new HttpException(
      {
        error: 'internal_error',
        message: err.message || '调度中心请求失败',
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Post('/analyze')
  async analyze(@Body() request: AnalyzeRequestDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const scope = this.getRequesterScope(req);
      const normalized = this.analysisService.normalizeRequest(request);
      if (request.async_mode) {
        try {
          const task = await this.analysisService.submitAsync({
            stockCode: normalized.stockCode,
            reportType: normalized.reportType,
            forceRefresh: normalized.forceRefresh,
            userId: scope.userId,
            executionMode: normalized.executionMode,
          });
          res.status(202).json(task);
          return;
        } catch (error: unknown) {
          const err = error as Error & { code?: string; stockCode?: string; existingTaskId?: string };
          if (err.code === 'DUPLICATE_TASK') {
            res.status(409).json({
              error: 'duplicate_task',
              message: err.message,
              stock_code: err.stockCode,
              existing_task_id: err.existingTaskId,
            });
            return;
          }
          throw error;
        }
      }

      const result = await this.analysisService.runSync({
        stockCode: normalized.stockCode,
        reportType: normalized.reportType,
        userId: scope.userId,
        executionMode: normalized.executionMode,
      });
      res.status(200).json(result);
    } catch (error: unknown) {
      const err = error as Error & { code?: string };
      if (err.code === 'VALIDATION_ERROR') {
        throw new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
      }
      if (err.code === 'SIMULATION_ACCOUNT_REQUIRED') {
        throw new HttpException(
          { error: 'simulation_account_required', message: err.message },
          HttpStatus.PRECONDITION_FAILED,
        );
      }

      throw new HttpException(
        {
          error: 'internal_error',
          message: `分析过程发生错误: ${err.message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('/tasks')
  async tasks(
    @Req() req: Request,
    @Query('status') status: string | null = null,
    @Query('limit') limit = '20',
  ): Promise<Record<string, unknown>> {
    const scope = this.getRequesterScope(req);
    const parsedLimit = Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 20;
    return await this.analysisService.getTaskList(status, safeLimit, scope);
  }

  @Sse('/tasks/stream')
  taskStream(@Req() req: Request): Observable<MessageEvent> {
    const scope = this.getRequesterScope(req);
    const knownStatuses = new Map<string, string>();
    let ticks = 0;

    return interval(2000).pipe(
      startWith(0),
      switchMap(async () => {
        ticks += 1;
        const taskList = await this.analysisService.getTaskList(null, 100, scope);
        const tasks = (taskList.tasks as Array<Record<string, unknown>>) ?? [];

        const events: MessageEvent[] = [];

        if (ticks === 1) {
          events.push({ type: 'connected', data: { message: 'Connected to task stream' } });
          for (const task of tasks.filter((x) => ['pending', 'processing'].includes(String(x.status)))) {
            events.push({ type: 'task_created', data: task });
            knownStatuses.set(String(task.task_id), String(task.status));
          }
        } else {
          for (const task of tasks) {
            const taskId = String(task.task_id);
            const status = String(task.status);
            const previous = knownStatuses.get(taskId);

            if (!previous) {
              events.push({ type: 'task_created', data: task });
              if (status === 'processing') events.push({ type: 'task_started', data: task });
              if (status === 'completed') events.push({ type: 'task_completed', data: task });
              if (status === 'failed') events.push({ type: 'task_failed', data: task });
              if (status === 'cancelled') events.push({ type: 'task_cancelled', data: task });
            } else if (previous !== status) {
              if (status === 'processing') events.push({ type: 'task_started', data: task });
              if (status === 'completed') events.push({ type: 'task_completed', data: task });
              if (status === 'failed') events.push({ type: 'task_failed', data: task });
              if (status === 'cancelled') events.push({ type: 'task_cancelled', data: task });
            }

            knownStatuses.set(taskId, status);
          }

          if (ticks % 15 === 0) {
            events.push({ type: 'heartbeat', data: { timestamp: new Date().toISOString() } });
          }
        }

        return events;
      }),
      switchMap((events) => (events.length ? of(...events) : of({ type: 'heartbeat', data: { timestamp: new Date().toISOString() } }))),
    );
  }

  @Get('/scheduler/overview')
  async schedulerOverview(
    @Req() req: Request,
    @Query('scope') requestedScope: string | null = null,
  ): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      return await this.analysisSchedulerService.getOverview(scope, requestedScope);
    } catch (error: unknown) {
      this.throwSchedulerError(error);
    }
  }

  @Get('/scheduler/health')
  async schedulerHealth(): Promise<Record<string, unknown>> {
    try {
      return await this.analysisSchedulerService.getHealth();
    } catch (error: unknown) {
      this.throwSchedulerError(error);
    }
  }

  @Get('/scheduler/tasks')
  async schedulerTasks(
    @Req() req: Request,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status: string | null = null,
    @Query('stock_code') stockCode: string | null = null,
    @Query('username') username: string | null = null,
    @Query('execution_mode') executionMode: string | null = null,
    @Query('stale_only') staleOnly: string | null = null,
    @Query('start_date') startDate: string | null = null,
    @Query('end_date') endDate: string | null = null,
    @Query('scope') requestedScope: string | null = null,
  ): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      return await this.analysisSchedulerService.listTasks(
        {
          page: Number(page),
          limit: Number(limit),
          status,
          stockCode,
          username,
          executionMode,
          staleOnly: this.parseBooleanFlag(staleOnly),
          startDate,
          endDate,
          scope: requestedScope as 'mine' | 'all' | null,
        },
        scope,
      );
    } catch (error: unknown) {
      this.throwSchedulerError(error);
    }
  }

  @Get('/scheduler/tasks/:task_id')
  async schedulerTaskDetail(@Param('task_id') taskId: string, @Req() req: Request): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      const result = await this.analysisSchedulerService.getTaskDetail(taskId, scope);
      if (!result) {
        throw new HttpException(
          {
            error: 'not_found',
            message: `任务 ${taskId} 不存在或无权限访问`,
          },
          HttpStatus.NOT_FOUND,
        );
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.throwSchedulerError(error);
    }
  }

  @Post('/scheduler/tasks/:task_id/retry')
  async schedulerRetryTask(@Param('task_id') taskId: string, @Req() req: Request): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      const result = await this.analysisSchedulerService.retryTask(taskId, scope);
      if (!result) {
        throw new HttpException(
          {
            error: 'not_found',
            message: `任务 ${taskId} 不存在或无权限访问`,
          },
          HttpStatus.NOT_FOUND,
        );
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.throwSchedulerError(error);
    }
  }

  @Post('/scheduler/tasks/:task_id/rerun')
  async schedulerRerunTask(@Param('task_id') taskId: string, @Req() req: Request): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      const result = await this.analysisSchedulerService.rerunTask(taskId, scope);
      if (!result) {
        throw new HttpException(
          {
            error: 'not_found',
            message: `任务 ${taskId} 不存在或无权限访问`,
          },
          HttpStatus.NOT_FOUND,
        );
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.throwSchedulerError(error);
    }
  }

  @Post('/scheduler/tasks/:task_id/cancel')
  async schedulerCancelTask(@Param('task_id') taskId: string, @Req() req: Request): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      const result = await this.analysisSchedulerService.cancelTask(taskId, scope);
      if (!result) {
        throw new HttpException(
          {
            error: 'not_found',
            message: `任务 ${taskId} 不存在或无权限访问`,
          },
          HttpStatus.NOT_FOUND,
        );
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.throwSchedulerError(error);
    }
  }

  @Patch('/scheduler/tasks/:task_id/priority')
  async schedulerUpdatePriority(
    @Param('task_id') taskId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      const result = await this.analysisSchedulerService.updatePriority(taskId, body.priority, scope);
      if (!result) {
        throw new HttpException(
          {
            error: 'not_found',
            message: `任务 ${taskId} 不存在或无权限访问`,
          },
          HttpStatus.NOT_FOUND,
        );
      }
      return result;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }
      this.throwSchedulerError(error);
    }
  }

  @Get('/status/:task_id')
  async taskStatus(@Param('task_id') taskId: string, @Req() req: Request): Promise<Record<string, unknown>> {
    const scope = this.getRequesterScope(req);
    const status = await this.analysisService.getTaskStatus(taskId, scope);
    if (!status) {
      throw new HttpException(
        {
          error: 'not_found',
          message: `任务 ${taskId} 不存在或已过期`,
        },
        HttpStatus.NOT_FOUND,
      );
    }

    return status;
  }

  @Get('/tasks/:task_id/stages')
  async taskStages(@Param('task_id') taskId: string, @Req() req: Request): Promise<Record<string, unknown>> {
    const scope = this.getRequesterScope(req);
    const result = await this.analysisService.getTaskStages(taskId, scope);
    if (!result) {
      throw new HttpException(
        {
          error: 'not_found',
          message: `任务 ${taskId} 不存在或无权限访问`,
        },
        HttpStatus.NOT_FOUND,
      );
    }

    return result;
  }

  @Sse('/tasks/:task_id/stages/stream')
  taskStagesStream(@Param('task_id') taskId: string, @Req() req: Request): Observable<MessageEvent> {
    const scope = this.getRequesterScope(req);
    let ticks = 0;
    let lastStagesJson = '';

    return interval(2000).pipe(
      startWith(0),
      switchMap(async () => {
        ticks += 1;
        const events: MessageEvent[] = [];
        if (ticks === 1) {
          events.push({
            type: 'connected',
            data: { task_id: taskId, message: 'Connected to stage stream' },
          });
        }

        const payload = await this.analysisService.getTaskStages(taskId, scope);
        if (payload) {
          const stagesJson = JSON.stringify(payload.stages ?? []);
          if (stagesJson !== lastStagesJson) {
            lastStagesJson = stagesJson;
            events.push({
              type: 'stage_update',
              data: payload,
            });
          }
        }

        if (ticks % 15 === 0) {
          events.push({ type: 'heartbeat', data: { timestamp: new Date().toISOString() } });
        }

        return events;
      }),
      switchMap((events) => (events.length ? of(...events) : of({ type: 'heartbeat', data: { timestamp: new Date().toISOString() } }))),
    );
  }
}
