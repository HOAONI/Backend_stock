/** Agent 问股内部工具控制器。 */

import { Body, Controller, Headers, HttpException, HttpStatus, Post } from '@nestjs/common';

import {
  AgentChatInternalAccountStateDto,
  AgentChatInternalBacktestDto,
  AgentChatInternalHistoryDto,
  AgentChatInternalPlaceOrderDto,
  AgentChatInternalPortfolioHealthDto,
  AgentChatInternalRuntimeContextDto,
  AgentChatInternalSaveAnalysisDto,
  AgentChatInternalUserPreferencesDto,
} from './agent-chat.dto';
import { AgentChatService } from './agent-chat.service';

interface ServiceError extends Error {
  code?: string;
  statusCode?: number;
}

function requireInternalToken(authorization?: string): void {
  const expected = String(process.env.AGENT_SERVICE_AUTH_TOKEN ?? '').trim();
  const raw = String(authorization ?? '').trim();
  const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : '';
  if (!expected || token !== expected) {
    throw new HttpException({ error: 'unauthorized', message: 'Invalid internal bearer token' }, HttpStatus.UNAUTHORIZED);
  }
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
  return new HttpException(
    { error: 'internal_error', message: err.message || 'Agent 内部工具请求失败' },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

/** 负责暴露给 Agent_stock 的内部工具接口。 */
@Controller('/internal/v1/agent-chat')
export class AgentChatInternalController {
  constructor(private readonly agentChatService: AgentChatService) {}

  @Post('/runtime-context')
  async runtimeContext(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AgentChatInternalRuntimeContextDto,
  ): Promise<Record<string, unknown>> {
    requireInternalToken(authorization);
    try {
      return await this.agentChatService.getRuntimeContextForAgent(body.owner_user_id, Boolean(body.refresh ?? true));
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/account-state')
  async accountState(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AgentChatInternalAccountStateDto,
  ): Promise<Record<string, unknown>> {
    requireInternalToken(authorization);
    try {
      return await this.agentChatService.getAccountStateForAgent(body.owner_user_id, Boolean(body.refresh ?? true));
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/portfolio-health')
  async portfolioHealth(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AgentChatInternalPortfolioHealthDto,
  ): Promise<Record<string, unknown>> {
    requireInternalToken(authorization);
    try {
      return await this.agentChatService.getPortfolioHealthForAgent(body.owner_user_id, Boolean(body.refresh ?? true));
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/user-preferences')
  async userPreferences(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AgentChatInternalUserPreferencesDto,
  ): Promise<Record<string, unknown>> {
    requireInternalToken(authorization);
    try {
      return await this.agentChatService.getUserPreferencesForAgent(body.owner_user_id, body.session_overrides);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/analysis-history')
  async analysisHistory(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AgentChatInternalHistoryDto,
  ): Promise<Record<string, unknown>> {
    requireInternalToken(authorization);
    try {
      return await this.agentChatService.getAnalysisHistoryForAgent(body.owner_user_id, body.stock_codes ?? [], body.limit);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/analysis-records')
  async saveAnalysisRecords(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AgentChatInternalSaveAnalysisDto,
  ): Promise<Record<string, unknown>> {
    requireInternalToken(authorization);
    try {
      return await this.agentChatService.saveAnalysisHistoryFromAgent(
        body.owner_user_id,
        body.session_id,
        body.assistant_message_id,
        body.analysis_result,
      );
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/backtest-summary')
  async backtestSummary(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AgentChatInternalBacktestDto,
  ): Promise<Record<string, unknown>> {
    requireInternalToken(authorization);
    try {
      return await this.agentChatService.getBacktestSummaryForAgent(body.owner_user_id, body.stock_codes ?? [], body.limit);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }

  @Post('/place-simulated-order')
  async placeSimulatedOrder(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AgentChatInternalPlaceOrderDto,
  ): Promise<Record<string, unknown>> {
    requireInternalToken(authorization);
    try {
      return await this.agentChatService.placeSimulatedOrderForAgent(body.owner_user_id, body.session_id, body.candidate_order);
    } catch (error: unknown) {
      throw toHttpException(error);
    }
  }
}
