/** Agent 问股模块控制器。 */

import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

import { AgentChatRequestDto } from './agent-chat.dto';
import { AgentChatService } from './agent-chat.service';

interface ServiceError extends Error {
  code?: string;
  statusCode?: number;
}

function toHttpException(error: unknown): HttpException {
  const err = error as ServiceError;
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
  if (err.statusCode && err.statusCode >= 400) {
    const mappedCode = err.statusCode === 404 ? 'not_found' : 'upstream_error';
    return new HttpException({ error: mappedCode, message: err.message }, err.statusCode);
  }
  return new HttpException(
    { error: 'internal_error', message: err.message || 'Agent 问股请求失败' },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** 负责定义 Agent 问股公开接口边界。 */
@Controller('/api/v1/agent/chat')
export class AgentChatController {
  constructor(private readonly agentChatService: AgentChatService) {}

  private requireUser(req: Request): { userId: number; username: string } {
    const user = req.authUser;
    if (!user) {
      throw new HttpException({ error: 'unauthorized', message: 'Login required' }, HttpStatus.UNAUTHORIZED);
    }
    return {
      userId: user.id,
      username: user.username,
    };
  }

  @Post('')
  async chat(@Req() req: Request, @Body() body: AgentChatRequestDto): Promise<Record<string, unknown>> {
    try {
      const user = this.requireUser(req);
      return await this.agentChatService.chat(user.userId, user.username, body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/stream')
  async stream(@Req() req: Request, @Body() body: AgentChatRequestDto, @Res() res: Response): Promise<void> {
    const user = this.requireUser(req);
    try {
      const upstream = await this.agentChatService.openChatStream(user.userId, user.username, body);
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstream.body?.getReader();
      if (!reader) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Agent stream is unavailable' })}\n\n`);
        res.end();
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (error: unknown) {
      if (!res.headersSent) {
        const httpError = toHttpException(error);
        res.status(httpError.getStatus()).json(httpError.getResponse());
        return;
      }
      res.write(`event: error\ndata: ${JSON.stringify({ message: (error as Error).message || 'stream failed' })}\n\n`);
      res.end();
    }
  }

  @Get('/sessions')
  async listSessions(@Req() req: Request, @Query('limit') limit = '50'): Promise<Record<string, unknown>> {
    try {
      const user = this.requireUser(req);
      const parsed = Number(limit);
      const safeLimit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 50;
      return await this.agentChatService.listSessions(user.userId, safeLimit);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/sessions/:session_id')
  async getSession(@Req() req: Request, @Param('session_id') sessionId: string): Promise<Record<string, unknown>> {
    try {
      const user = this.requireUser(req);
      return await this.agentChatService.getSession(user.userId, sessionId);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Delete('/sessions/:session_id')
  async deleteSession(@Req() req: Request, @Param('session_id') sessionId: string): Promise<Record<string, unknown>> {
    try {
      const user = this.requireUser(req);
      return await this.agentChatService.deleteSession(user.userId, sessionId);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/monitor')
  async getMonitor(@Req() req: Request): Promise<Record<string, unknown>> {
    try {
      const user = this.requireUser(req);
      return await this.agentChatService.getMonitorSnapshot(user.userId);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Get('/monitor/stream')
  async streamMonitor(@Req() req: Request, @Res() res: Response): Promise<void> {
    const user = this.requireUser(req);
    try {
      const upstream = await this.agentChatService.openMonitorStream(user.userId);
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstream.body?.getReader();
      if (!reader) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Agent monitor stream is unavailable' })}\n\n`);
        res.end();
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (error: unknown) {
      if (!res.headersSent) {
        const httpError = toHttpException(error);
        res.status(httpError.getStatus()).json(httpError.getResponse());
        return;
      }
      res.write(`event: error\ndata: ${JSON.stringify({ message: (error as Error).message || 'monitor stream failed' })}\n\n`);
      res.end();
    }
  }
}
