import { Body, Controller, Headers, HttpException, HttpStatus, Post } from '@nestjs/common';

import { AgentExecutionEventDto, ExchangeCredentialTicketDto, IssueCredentialTicketDto } from './agent-bridge.dto';
import { AgentBridgeService } from './agent-bridge.service';

interface ServiceError extends Error {
  code?: string;
}

function toHttpException(error: unknown): HttpException {
  const err = error as ServiceError;
  if (err.code === 'NOT_FOUND') {
    return new HttpException({ error: 'not_found', message: err.message }, HttpStatus.NOT_FOUND);
  }
  if (err.code === 'VALIDATION_ERROR') {
    return new HttpException({ error: 'validation_error', message: err.message }, HttpStatus.BAD_REQUEST);
  }
  if (err.code === 'GONE') {
    return new HttpException({ error: 'gone', message: err.message }, HttpStatus.GONE);
  }

  return new HttpException(
    {
      error: 'internal_error',
      message: err.message || 'agent bridge 请求失败',
    },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

@Controller('/api/v1/internal/agent')
export class AgentBridgeController {
  constructor(private readonly agentBridgeService: AgentBridgeService) {}

  private assertServiceToken(authorization: string | undefined): void {
    const expected = String(process.env.AGENT_SERVICE_AUTH_TOKEN ?? '').trim();
    if (!expected) {
      throw new HttpException(
        {
          error: 'internal_error',
          message: 'AGENT_SERVICE_AUTH_TOKEN 未配置',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const header = String(authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!token || token !== expected) {
      throw new HttpException({ error: 'unauthorized', message: 'Invalid service token' }, HttpStatus.UNAUTHORIZED);
    }
  }

  @Post('/credential-tickets')
  async issueCredentialTicket(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: IssueCredentialTicketDto,
  ): Promise<Record<string, unknown>> {
    this.assertServiceToken(authorization);
    try {
      return await this.agentBridgeService.issueCredentialTicket(body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/credential-tickets/exchange')
  async exchangeCredentialTicket(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: ExchangeCredentialTicketDto,
  ): Promise<Record<string, unknown>> {
    this.assertServiceToken(authorization);
    try {
      return await this.agentBridgeService.exchangeCredentialTicket(body.ticket);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/execution-events')
  async executionEvent(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AgentExecutionEventDto,
  ): Promise<Record<string, unknown>> {
    this.assertServiceToken(authorization);
    try {
      return await this.agentBridgeService.recordExecutionEvent(body);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
