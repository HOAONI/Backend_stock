/** 回测 AI 解读编排服务，负责把结构化回测结果交给 Agent 生成中文说明并回写到 JSON 字段。 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BacktestAgentClientService } from '@/common/agent/backtest-agent-client.service';
import { PrismaService } from '@/common/database/prisma.service';
import { AnalysisService } from '@/modules/analysis/analysis.service';

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

type InterpretationStatus = 'ready' | 'failed' | 'unavailable';
export type StrategyAiInterpretationJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

type InterpretationMeta = {
  source: string;
  provider: string;
  model: string;
  runtimeLlmPayload?: Record<string, unknown>;
};

interface InterpretationPersistenceError extends Error {
  code?: string;
}

type AgentInterpretationItem = {
  item_key: string;
  status: InterpretationStatus | string;
  verdict?: unknown;
  summary?: unknown;
  error_message?: unknown;
};

const DEFAULT_UNAVAILABLE_SUMMARY = 'AI 解读暂不可用，请先检查个人或系统 AI 配置。';
const DEFAULT_FAILED_SUMMARY = 'AI 解读生成失败，请稍后重试。';
export const STRATEGY_AI_INTERPRETATION_MAX_ATTEMPTS = 3;
const STRATEGY_AI_INTERPRETATION_RETRY_BASE_MS = 30_000;

function buildInterpretationPersistenceError(code: string, message: string): InterpretationPersistenceError {
  const error = new Error(message) as InterpretationPersistenceError;
  error.code = code;
  return error;
}

@Injectable()
export class BacktestAiInterpretationService {
  private readonly logger = new Logger(BacktestAiInterpretationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly backtestAgentClient: BacktestAgentClientService,
    private readonly analysisService: AnalysisService,
  ) {}

  async ensureStrategyRunGroupInterpretations(runGroupId: number): Promise<void> {
    const group = await this.prisma.strategyBacktestRunGroup.findUnique({
      where: { id: runGroupId },
      include: {
        runs: {
          orderBy: [{ strategyCode: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            savedStrategyName: true,
            strategyCode: true,
            strategyVersion: true,
            metricsJson: true,
            benchmarkJson: true,
          },
        },
      },
    });
    if (!group) {
      return;
    }

    const targets = group.runs.filter(run => !this.hasInterpretation(run.metricsJson));
    if (targets.length === 0) {
      return;
    }

    const meta = await this.resolveInterpretationMeta(group.ownerUserId);
    if ('unavailableMessage' in meta) {
      await this.persistStrategyInterpretations(
        targets.map(run => ({
          runId: run.id,
          metrics: asRecord(run.metricsJson),
          interpretation: this.buildInterpretationRecord(
            {
              source: 'system',
              provider: '',
              model: '',
            },
            {
              status: 'unavailable',
              summary: meta.unavailableMessage,
            },
          ),
        })),
      );
      return;
    }

    const payloadItems = targets.map(run => ({
      item_key: `strategy-run-${run.id}`,
      item_type: 'strategy',
      label: String(run.savedStrategyName ?? run.strategyCode ?? `策略 ${run.id}`),
      code: group.code,
      requested_range: {
        start_date: this.toIsoDay(group.startDate),
        end_date: this.toIsoDay(group.endDate),
      },
      effective_range: {
        start_date: this.toIsoDay(group.effectiveStartDate),
        end_date: this.toIsoDay(group.effectiveEndDate),
      },
      metrics: this.buildStrategyMetricSnapshot(run.metricsJson),
      benchmark: asRecord(run.benchmarkJson),
      context: {
        strategy_code: run.strategyCode,
        strategy_version: run.strategyVersion,
      },
    }));

    const items = await this.requestInterpretations(payloadItems, meta);
    const itemByKey = new Map(items.map(item => [String(item.item_key), item]));
    await this.persistStrategyInterpretations(
      targets.map(run => ({
        runId: run.id,
        metrics: asRecord(run.metricsJson),
        interpretation: this.buildInterpretationRecord(
          meta,
          itemByKey.get(`strategy-run-${run.id}`) ?? {
            status: 'failed',
            summary: DEFAULT_FAILED_SUMMARY,
            error_message: 'missing_item_in_agent_response',
          },
        ),
      })),
    );
  }

  async persistStrategyRunGroupInterpretationsFromAgent(input: {
    ownerUserId: number;
    runGroupId: number;
    items: Array<Record<string, unknown>>;
  }): Promise<Record<string, unknown>> {
    const group = await this.prisma.strategyBacktestRunGroup.findUnique({
      where: { id: input.runGroupId },
      include: {
        runs: {
          orderBy: [{ strategyCode: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            metricsJson: true,
          },
        },
      },
    });
    if (!group) {
      throw buildInterpretationPersistenceError('VALIDATION_ERROR', '策略回测分组不存在');
    }
    if (group.ownerUserId !== input.ownerUserId) {
      throw buildInterpretationPersistenceError('VALIDATION_ERROR', '策略回测分组不属于当前用户');
    }

    const meta = await this.resolveInterpretationMeta(group.ownerUserId);
    const recordMeta: Pick<InterpretationMeta, 'source' | 'provider' | 'model'> = 'unavailableMessage' in meta
      ? {
          source: 'system',
          provider: '',
          model: '',
        }
      : meta;
    const itemByKey = new Map<string, Partial<AgentInterpretationItem>>(
      input.items
        .filter(item => item && typeof item === 'object')
        .map((item) => {
          const row = asRecord(item);
          return [
            String(row.item_key ?? '').trim(),
            {
              item_key: String(row.item_key ?? '').trim(),
              status: String(row.status ?? '').trim(),
              verdict: row.verdict,
              summary: row.summary,
              error_message: row.error_message,
            },
          ] as const;
        })
        .filter(([itemKey]) => Boolean(itemKey)),
    );
    const completedAt = new Date();
    const updates = group.runs.map(run => ({
      runId: run.id,
      metrics: asRecord(run.metricsJson),
      interpretation: this.buildInterpretationRecord(
        recordMeta,
        itemByKey.get(`strategy-run-${run.id}`) ?? {
          status: 'failed',
          summary: DEFAULT_FAILED_SUMMARY,
          error_message: 'missing_item_in_agent_writeback',
        },
      ),
    }));

    await this.prisma.$transaction([
      ...updates.map(update => this.prisma.strategyBacktestRun.update({
        where: { id: update.runId },
        data: {
          metricsJson: toPrismaJson({
            ...update.metrics,
            ai_interpretation: update.interpretation,
          }),
        },
      })),
      this.prisma.strategyBacktestRunGroup.update({
        where: { id: input.runGroupId },
        data: {
          aiInterpretationStatus: 'completed',
          aiInterpretationStartedAt: completedAt,
          aiInterpretationCompletedAt: completedAt,
          aiInterpretationNextRetryAt: null,
          aiInterpretationErrorMessage: null,
        },
      }),
    ]);

    return {
      run_group_id: input.runGroupId,
      saved_count: updates.length,
      ai_interpretation_status: 'completed',
    };
  }

  async ensureAgentRunGroupInterpretation(runGroupId: number): Promise<void> {
    const group = await this.prisma.agentBacktestRunGroup.findUnique({
      where: { id: runGroupId },
      select: {
        id: true,
        ownerUserId: true,
        code: true,
        startDate: true,
        endDate: true,
        effectiveStartDate: true,
        effectiveEndDate: true,
        status: true,
        phase: true,
        summaryJson: true,
        diagnosticsJson: true,
      },
    });
    if (!group || group.status !== 'completed' || group.phase !== 'done') {
      return;
    }
    if (this.hasInterpretation(group.summaryJson)) {
      return;
    }

    const meta = await this.resolveInterpretationMeta(group.ownerUserId);
    if ('unavailableMessage' in meta) {
      await this.persistAgentInterpretation({
        runGroupId: group.id,
        summary: asRecord(group.summaryJson),
        interpretation: this.buildInterpretationRecord(
          {
            source: 'system',
            provider: '',
            model: '',
          },
          {
            status: 'unavailable',
            summary: meta.unavailableMessage,
          },
        ),
      });
      return;
    }

    const items = await this.requestInterpretations(
      [
        {
          item_key: `agent-run-${group.id}`,
          item_type: 'agent',
          label: `${group.code} Agent 回放`,
          code: group.code,
          requested_range: {
            start_date: this.toIsoDay(group.startDate),
            end_date: this.toIsoDay(group.endDate),
          },
          effective_range: {
            start_date: this.toIsoDay(group.effectiveStartDate),
            end_date: this.toIsoDay(group.effectiveEndDate),
          },
          metrics: this.buildAgentMetricSnapshot(group.summaryJson),
          benchmark: {},
          context: {
            diagnostics: this.buildAgentContext(group.diagnosticsJson),
          },
        },
      ],
      meta,
    );
    const matched = items.find(item => String(item.item_key) === `agent-run-${group.id}`);
    await this.persistAgentInterpretation({
      runGroupId: group.id,
      summary: asRecord(group.summaryJson),
      interpretation: this.buildInterpretationRecord(
        meta,
        matched ?? {
          status: 'failed',
          summary: DEFAULT_FAILED_SUMMARY,
          error_message: 'missing_item_in_agent_response',
        },
      ),
    });
  }

  async processNextStrategyRunGroupJob(): Promise<boolean> {
    const now = new Date();
    const readyWhere: Prisma.StrategyBacktestRunGroupWhereInput = {
      aiInterpretationStatus: 'pending',
      OR: [
        { aiInterpretationNextRetryAt: null },
        { aiInterpretationNextRetryAt: { lte: now } },
      ],
    };
    const candidate = await this.prisma.strategyBacktestRunGroup.findFirst({
      where: readyWhere,
      orderBy: [{ aiInterpretationRequestedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        aiInterpretationAttempts: true,
      },
    });
    if (!candidate) {
      return false;
    }

    const lock = await this.prisma.strategyBacktestRunGroup.updateMany({
      where: {
        id: candidate.id,
        ...readyWhere,
      },
      data: {
        aiInterpretationStatus: 'processing',
        aiInterpretationAttempts: {
          increment: 1,
        },
        aiInterpretationStartedAt: now,
        aiInterpretationCompletedAt: null,
        aiInterpretationNextRetryAt: null,
        aiInterpretationErrorMessage: null,
      },
    });
    if (lock.count === 0) {
      return false;
    }

    const attempt = Number(candidate.aiInterpretationAttempts ?? 0) + 1;
    try {
      await this.ensureStrategyRunGroupInterpretations(candidate.id);
      await this.prisma.strategyBacktestRunGroup.updateMany({
        where: { id: candidate.id },
        data: {
          aiInterpretationStatus: 'completed',
          aiInterpretationCompletedAt: new Date(),
          aiInterpretationNextRetryAt: null,
          aiInterpretationErrorMessage: null,
        },
      });
      return true;
    } catch (error: unknown) {
      const message = this.cleanText((error as Error)?.message, 500) || 'strategy_ai_interpretation_failed';
      const exhausted = attempt >= STRATEGY_AI_INTERPRETATION_MAX_ATTEMPTS;
      await this.prisma.strategyBacktestRunGroup.updateMany({
        where: { id: candidate.id },
        data: {
          aiInterpretationStatus: exhausted ? 'failed' : 'pending',
          aiInterpretationCompletedAt: exhausted ? new Date() : null,
          aiInterpretationNextRetryAt: exhausted ? null : new Date(Date.now() + this.retryDelayMs(attempt)),
          aiInterpretationErrorMessage: message,
        },
      });
      this.logger.warn(`Strategy AI interpretation job failed runGroupId=${candidate.id} attempt=${attempt}: ${message}`);
      return true;
    }
  }

  private async requestInterpretations(
    payloadItems: Array<Record<string, unknown>>,
    meta: InterpretationMeta,
  ): Promise<AgentInterpretationItem[]> {
    try {
      const payload = await this.backtestAgentClient.interpret({
        language: 'zh-CN',
        items: payloadItems,
        ...(meta.runtimeLlmPayload ? { runtime_llm: meta.runtimeLlmPayload } : {}),
      });
      return Array.isArray(payload.items)
        ? payload.items
          .filter(item => item && typeof item === 'object')
          .map(item => item as AgentInterpretationItem)
        : [];
    } catch (error: unknown) {
      const message = this.cleanText((error as Error)?.message, 280) || 'interpretation_request_failed';
      this.logger.warn(`Backtest interpretation request failed: ${message}`);
      return payloadItems.map((item) => ({
        item_key: String(item.item_key ?? ''),
        status: 'failed',
        summary: DEFAULT_FAILED_SUMMARY,
        error_message: message,
      }));
    }
  }

  private async resolveInterpretationMeta(userId: number | null): Promise<InterpretationMeta | { unavailableMessage: string }> {
    if (!userId) {
      return {
        unavailableMessage: '历史记录缺少所属用户，无法生成 AI 解读。',
      };
    }

    try {
      const runtime = await this.analysisService.buildRuntimeContext(userId, { includeApiToken: true });
      return {
        source: runtime.llmSource,
        provider: runtime.effectiveLlm.provider,
        model: runtime.effectiveLlm.model,
        runtimeLlmPayload: runtime.runtimeConfig.llm
          ? {
              provider: runtime.runtimeConfig.llm.provider,
              base_url: runtime.runtimeConfig.llm.base_url,
              model: runtime.runtimeConfig.llm.model,
              has_token: Boolean(runtime.runtimeConfig.llm.has_token || runtime.runtimeConfig.llm.api_token),
              ...(runtime.runtimeConfig.llm.api_token ? { api_token: runtime.runtimeConfig.llm.api_token } : {}),
            }
          : undefined,
      };
    } catch (error: unknown) {
      const message = this.cleanText((error as Error)?.message, 280) || DEFAULT_UNAVAILABLE_SUMMARY;
      this.logger.warn(`Backtest interpretation runtime unavailable userId=${userId}: ${message}`);
      return {
        unavailableMessage: message,
      };
    }
  }

  private async persistStrategyInterpretations(
    updates: Array<{ runId: number; metrics: Record<string, unknown>; interpretation: Record<string, unknown> }>,
  ): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    await this.prisma.$transaction(
      updates.map(update => this.prisma.strategyBacktestRun.update({
        where: { id: update.runId },
        data: {
          metricsJson: toPrismaJson({
            ...update.metrics,
            ai_interpretation: update.interpretation,
          }),
        },
      })),
    );
  }

  private async persistAgentInterpretation(input: {
    runGroupId: number;
    summary: Record<string, unknown>;
    interpretation: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.agentBacktestRunGroup.update({
      where: { id: input.runGroupId },
      data: {
        summaryJson: toPrismaJson({
          ...input.summary,
          ai_interpretation: input.interpretation,
        }),
      },
    });
  }

  private buildInterpretationRecord(
    meta: Pick<InterpretationMeta, 'source' | 'provider' | 'model'>,
    item: Partial<AgentInterpretationItem>,
  ): Record<string, unknown> {
    const status = this.normalizeStatus(item.status) ?? 'failed';
    return {
      version: 'v1',
      status,
      verdict: status === 'ready' ? (this.cleanText(item.verdict, 24) || null) : null,
      summary: this.cleanText(item.summary, 500)
        || (status === 'unavailable' ? DEFAULT_UNAVAILABLE_SUMMARY : DEFAULT_FAILED_SUMMARY),
      generated_at: status === 'ready' ? new Date().toISOString() : null,
      source: meta.source || 'system',
      provider: meta.provider || '',
      model: meta.model || '',
      error_message: this.cleanText(item.error_message, 500) || null,
    };
  }

  private hasInterpretation(value: unknown): boolean {
    const aiInterpretation = asRecord(asRecord(value).ai_interpretation);
    const status = this.normalizeStatus(aiInterpretation.status);
    return Boolean(status);
  }

  private normalizeStatus(value: unknown): InterpretationStatus | null {
    const text = String(value ?? '').trim();
    if (text === 'ready' || text === 'failed' || text === 'unavailable') {
      return text;
    }
    return null;
  }

  private buildStrategyMetricSnapshot(value: unknown): Record<string, unknown> {
    const metrics = { ...asRecord(value) };
    delete metrics.ai_interpretation;

    const totalReturnPct = this.toNumber(metrics.total_return_pct);
    const completedTradingDays = this.toNumber(metrics.completed_trading_days);
    const maxDrawdownPct = this.toNumber(metrics.max_drawdown_pct);
    return {
      initial_capital: this.toNumber(metrics.initial_capital),
      final_equity: this.toNumber(metrics.final_equity),
      total_return_pct: totalReturnPct,
      annualized_return_pct: this.computeAnnualizedReturn(totalReturnPct, completedTradingDays),
      benchmark_return_pct: this.toNumber(metrics.benchmark_return_pct),
      excess_return_pct: this.toNumber(metrics.excess_return_pct),
      max_drawdown_pct: maxDrawdownPct,
      max_drawdown_abs_pct: maxDrawdownPct != null ? Number(Math.abs(maxDrawdownPct).toFixed(4)) : null,
      total_trades: this.toNumber(metrics.total_trades),
      win_rate_pct: this.toNumber(metrics.win_rate_pct),
      sharpe_ratio: this.toNumber(metrics.sharpe_ratio),
      avg_trade_return_pct: this.toNumber(metrics.avg_trade_return_pct),
      completed_trading_days: completedTradingDays,
      no_trade_reason: this.cleanText(metrics.no_trade_reason, 64) || null,
      no_trade_reason_detail: this.cleanText(metrics.no_trade_reason_detail, 160) || null,
    };
  }

  private buildAgentMetricSnapshot(value: unknown): Record<string, unknown> {
    const summary = { ...asRecord(value) };
    delete summary.ai_interpretation;

    const maxDrawdownPct = this.toNumber(summary.max_drawdown_pct);
    return {
      initial_capital: this.toNumber(summary.initial_capital),
      final_equity: this.toNumber(summary.final_equity),
      total_return_pct: this.toNumber(summary.total_return_pct),
      benchmark_return_pct: this.toNumber(summary.benchmark_return_pct),
      excess_return_pct: this.toNumber(summary.excess_return_pct),
      max_drawdown_pct: maxDrawdownPct,
      max_drawdown_abs_pct: maxDrawdownPct != null ? Number(Math.abs(maxDrawdownPct).toFixed(4)) : null,
      total_trades: this.toNumber(summary.total_trades),
      win_rate_pct: this.toNumber(summary.win_rate_pct),
      snapshot_hit_rate: this.toNumber(summary.snapshot_hit_rate),
      llm_anchor_count: this.toNumber(summary.llm_anchor_count),
    };
  }

  private buildAgentContext(value: unknown): Record<string, unknown> {
    const diagnostics = asRecord(value);
    return {
      snapshot_hit_count: this.toNumber(diagnostics.snapshot_hit_count),
      snapshot_miss_count: this.toNumber(diagnostics.snapshot_miss_count),
      no_news_days: this.toNumber(diagnostics.no_news_days),
      fast_refined_divergence_days: this.toNumber(diagnostics.fast_refined_divergence_days),
      llm_anchor_count: this.toNumber(diagnostics.llm_anchor_count),
      decision_source_breakdown: asRecord(diagnostics.decision_source_breakdown),
    };
  }

  private computeAnnualizedReturn(totalReturnPct: number | null, tradingDays: number | null): number | null {
    if (totalReturnPct == null || tradingDays == null || tradingDays <= 0 || totalReturnPct <= -100) {
      return null;
    }
    const totalReturnFactor = 1 + (totalReturnPct / 100);
    const annualized = (Math.pow(totalReturnFactor, 252 / tradingDays) - 1) * 100;
    return Number.isFinite(annualized) ? Number(annualized.toFixed(4)) : null;
  }

  private toNumber(value: unknown): number | null {
    if (value == null || (typeof value === 'string' && value.trim().length === 0)) {
      return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  private cleanText(value: unknown, maxLength: number): string {
    const text = String(value ?? '').trim();
    if (!text) {
      return '';
    }
    return text.slice(0, maxLength);
  }

  private toIsoDay(value: Date | null): string | null {
    return value ? value.toISOString().slice(0, 10) : null;
  }

  private retryDelayMs(attempt: number): number {
    const safeAttempt = Math.max(1, Math.trunc(Number(attempt) || 1));
    return STRATEGY_AI_INTERPRETATION_RETRY_BASE_MS * (2 ** (safeAttempt - 1));
  }
}
