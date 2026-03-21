/** 股票分析模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Patch, Post, Query, Req, Res, Sse } from '@nestjs/common';
import { Request, Response } from 'express';
import { interval, Observable, of, startWith, switchMap } from 'rxjs';

import { BUILTIN_ROLE_CODES } from '@/common/auth/rbac.constants';
import { AnalyzeRequestDto, CreateAnalysisScheduleDto, UpdateAnalysisScheduleDto } from './analysis.dto';
import { AnalysisSchedulerService } from './analysis-scheduler.service';
import { AnalysisService } from './analysis.service';

interface MessageEvent {
  data: unknown;
  type?: string;
}

/** 负责定义该领域的 HTTP 接口边界，把鉴权后的请求参数整理成服务层可消费的输入。 */
@Controller('/api/v1/analysis')
export class AnalysisController {
  constructor(
    private readonly analysisService: AnalysisService,
    private readonly analysisSchedulerService: AnalysisSchedulerService,
  ) {}

  // 管理员可以切到全局视角查看所有任务，普通用户只能在自己的任务空间里操作。
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

  private throwSchedulerError(error: unknown): never {
    const err = error as Error & { code?: string };
    if (err.code === 'VALIDATION_ERROR') {
      throw new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
    }
    if (err.code === 'FORBIDDEN') {
      throw new HttpException({ error: 'forbidden', message: err.message }, HttpStatus.FORBIDDEN);
    }
    if (err.code === 'INVALID_TASK_STATUS' || err.code === 'DUPLICATE_TASK' || err.code === 'DUPLICATE_SCHEDULE') {
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

  // 同一个分析入口同时承载同步直返和异步入队，前端只需要切 async_mode 就能复用参数结构。
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

  // SSE 只推状态变化和心跳，前端据此做增量更新，避免高频全量轮询任务列表。
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

  @Get('/scheduler/schedules')
  async schedulerSchedules(@Req() req: Request): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      return await this.analysisSchedulerService.listSchedules(scope);
    } catch (error: unknown) {
      this.throwSchedulerError(error);
    }
  }

  @Post('/scheduler/schedules')
  async schedulerCreateSchedule(
    @Body() body: CreateAnalysisScheduleDto,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      return await this.analysisSchedulerService.createSchedule(body as unknown as Record<string, unknown>, scope);
    } catch (error: unknown) {
      this.throwSchedulerError(error);
    }
  }

  @Get('/scheduler/schedules/:schedule_id')
  async schedulerScheduleDetail(@Param('schedule_id') scheduleId: string, @Req() req: Request): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      const result = await this.analysisSchedulerService.getScheduleDetail(scheduleId, scope);
      if (!result) {
        throw new HttpException(
          {
            error: 'not_found',
            message: `定时任务 ${scheduleId} 不存在或无权限访问`,
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

  @Patch('/scheduler/schedules/:schedule_id')
  async schedulerUpdateSchedule(
    @Param('schedule_id') scheduleId: string,
    @Body() body: UpdateAnalysisScheduleDto,
    @Req() req: Request,
  ): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      const result = await this.analysisSchedulerService.updateSchedule(
        scheduleId,
        body as unknown as Record<string, unknown>,
        scope,
      );
      if (!result) {
        throw new HttpException(
          {
            error: 'not_found',
            message: `定时任务 ${scheduleId} 不存在或无权限访问`,
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

  @Delete('/scheduler/schedules/:schedule_id')
  async schedulerDeleteSchedule(@Param('schedule_id') scheduleId: string, @Req() req: Request): Promise<Record<string, unknown>> {
    try {
      const scope = this.getRequesterScope(req);
      const result = await this.analysisSchedulerService.deleteSchedule(scheduleId, scope);
      if (!result) {
        throw new HttpException(
          {
            error: 'not_found',
            message: `定时任务 ${scheduleId} 不存在或无权限访问`,
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
