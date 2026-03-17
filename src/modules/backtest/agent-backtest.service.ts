/** 回测模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import * as crypto from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BacktestAgentClientService } from '@/common/agent/backtest-agent-client.service';
import { AiRuntimeService } from '@/common/ai/ai-runtime.service';
import {
  AGENT_BACKTEST_SCHEMA_NOT_READY_MESSAGE,
  getAgentBacktestStorageReadiness,
} from '@/common/backtest/backtest-storage-readiness';
import { PrismaService } from '@/common/database/prisma.service';
import { safeJsonParse, safeJsonStringify } from '@/common/utils/json';
import { AnalysisService } from '@/modules/analysis/analysis.service';

type RequesterScope = { userId: number; includeAll: boolean };

type AgentRuntimeStrategy = {
  position_max_pct: number;
  stop_loss_pct: number;
  take_profit_pct: number;
};

type AgentRuntimeLlm = {
  provider: string;
  base_url: string;
  model: string;
  has_token: boolean;
  api_token?: string;
};

type AgentBacktestNormalizedResult = {
  code: string;
  engineVersion: string;
  phase: 'fast' | 'refine';
  requestedRange: { startDate: string | null; endDate: string | null };
  effectiveRange: { startDate: string | null; endDate: string | null };
  summary: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  dailySteps: Array<{
    tradeDate: string;
    decisionSource: string;
    aiUsed: boolean;
    dataPayload: Record<string, unknown>;
    signalPayload: Record<string, unknown>;
    riskPayload: Record<string, unknown>;
    executionPayload: Record<string, unknown>;
  }>;
  trades: Array<Record<string, unknown>>;
  equity: Array<Record<string, unknown>>;
  signalSnapshots: Array<Record<string, unknown>>;
  pendingAnchorDates: string[];
};

type AgentBacktestConfigRow = {
  initial_capital: number;
  commission_rate: number;
  slippage_bps: number;
  enable_refine: boolean;
  runtime_strategy: AgentRuntimeStrategy;
  signal_profile_hash: string;
  signal_profile_version: string;
  snapshot_version: number;
  runtime_llm: AgentRuntimeLlm;
  runtime_llm_source: 'system' | 'personal';
};

type AgentBacktestLlmMeta = {
  source: 'system' | 'personal';
  provider: string;
  base_url: string;
  model: string;
};

type AgentBacktestGroupRow = {
  id: number;
  owner_user_id: number | null;
  code: string;
  start_date: Date | string;
  end_date: Date | string;
  effective_start_date: Date | string | null;
  effective_end_date: Date | string | null;
  engine_version: string;
  status: string;
  phase: string;
  request_hash: string;
  active_result_version: number;
  latest_result_version: number;
  progress_pct: number;
  message: string | null;
  config_json: unknown;
  summary_json: unknown;
  diagnostics_json: unknown;
  fast_ready_at: Date | string | null;
  completed_at: Date | string | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type TxClient = Prisma.TransactionClient;

const ENGINE_VERSION = 'agent_replay_v1';
const SIGNAL_PROFILE_VERSION = 'agent_signal_profile_v1';
const SNAPSHOT_VERSION = 1;
const PERSONAL_REFINE_RUNTIME_MISSING_MESSAGE = '为避免静默回退到系统 AI，本次精修已终止，请重新绑定个人 AI 后重新发起回放回测';
const DEFAULT_AGENT_BACKTEST_CONFIG_ROW: AgentBacktestConfigRow = {
  initial_capital: 100000,
  commission_rate: 0.0003,
  slippage_bps: 2,
  enable_refine: true,
  runtime_strategy: { position_max_pct: 30, stop_loss_pct: 8, take_profit_pct: 15 },
  signal_profile_hash: '',
  signal_profile_version: SIGNAL_PROFILE_VERSION,
  snapshot_version: SNAPSHOT_VERSION,
  runtime_llm: {
    provider: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    has_token: false,
  },
  runtime_llm_source: 'system',
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => item as Record<string, unknown>);
}

function truncateText(value: unknown, maxLength: number): string {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function sanitizeRuntimeLlm(runtimeLlm: AgentRuntimeLlm): AgentRuntimeLlm {
  return {
    provider: runtimeLlm.provider,
    base_url: runtimeLlm.base_url,
    model: runtimeLlm.model,
    has_token: runtimeLlm.has_token,
  };
}

function mapAgentRuntimeProvider(provider: unknown): string {
  const normalized = String(provider ?? '').trim().toLowerCase();
  if (normalized === 'siliconflow') {
    return 'custom';
  }
  return normalized;
}

function createSchemaNotReadyError(tableName: string): Error & {
  code: string;
  meta: { table: string };
} {
  const error = new Error(AGENT_BACKTEST_SCHEMA_NOT_READY_MESSAGE) as Error & {
    code: string;
    meta: { table: string };
  };
  error.code = 'P2021';
  error.meta = { table: tableName };
  return error;
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class AgentBacktestService {
  private readonly logger = new Logger(AgentBacktestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly backtestAgentClient: BacktestAgentClientService,
    private readonly analysisService: AnalysisService,
    private readonly aiRuntimeService: AiRuntimeService = {} as AiRuntimeService,
  ) {}

  // Agent 回放回测依赖一组独立的持久化表，启动前先显式校验，避免中途跑到一半才发现表缺失。
  private async assertStorageReady(): Promise<void> {
    const readiness = await getAgentBacktestStorageReadiness(this.prisma);
    if (readiness.ready) {
      return;
    }
    const firstMissing = readiness.missingTables[0] ?? 'agent_backtest_run_groups';
    throw createSchemaNotReadyError(`public.${firstMissing}`);
  }

  private async isStorageReady(): Promise<boolean> {
    try {
      const readiness = await getAgentBacktestStorageReadiness(this.prisma);
      return readiness.ready;
    } catch {
      return false;
    }
  }

  private toNumber(value: unknown, fallback: number | null = null): number | null {
    if (value == null) {
      return fallback;
    }
    if (typeof value === 'string' && value.trim().length === 0) {
      return fallback;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return num;
  }

  private toBoolean(value: unknown, fallback = false): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return fallback;
  }

  private toDay(value: unknown): Date | null {
    if (value == null) {
      return null;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : new Date(Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
      ));
    }
    const text = String(value).trim();
    if (!text) {
      return null;
    }
    const parsed = new Date(`${text.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  private toIsoDay(value: unknown): string | null {
    const date = this.toDay(value);
    return date ? date.toISOString().slice(0, 10) : null;
  }

  private toIsoDateTime(value: unknown): string | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  private normalizeCode(code: string): string {
    return String(code ?? '').trim().toUpperCase();
  }

  private stableHash(value: unknown): string {
    return crypto.createHash('sha1').update(safeJsonStringify(value)).digest('hex');
  }

  private parseConfigRow(configJson: unknown): AgentBacktestConfigRow {
    return safeJsonParse<AgentBacktestConfigRow>(
      typeof configJson === 'string' ? configJson : safeJsonStringify(configJson),
      DEFAULT_AGENT_BACKTEST_CONFIG_ROW,
    );
  }

  private buildPublicLlmMeta(config: AgentBacktestConfigRow): AgentBacktestLlmMeta | null {
    const provider = String(config.runtime_llm?.provider ?? '').trim();
    const baseUrl = String(config.runtime_llm?.base_url ?? '').trim();
    const model = String(config.runtime_llm?.model ?? '').trim();
    if (!provider && !baseUrl && !model) {
      return null;
    }

    return {
      source: config.runtime_llm_source === 'personal' ? 'personal' : 'system',
      provider,
      base_url: baseUrl,
      model,
    };
  }

  private toRuntimeLlmPayload(input: {
    provider: string;
    baseUrl: string;
    model: string;
    hasToken: boolean;
    apiToken?: string | null;
  }): AgentRuntimeLlm | null {
    const provider = mapAgentRuntimeProvider(input.provider);
    const baseUrl = String(input.baseUrl ?? '').trim();
    const model = String(input.model ?? '').trim();
    const apiToken = String(input.apiToken ?? '').trim();
    if (!provider || !baseUrl || !model) {
      return null;
    }

    return {
      provider,
      base_url: baseUrl,
      model,
      has_token: Boolean(input.hasToken || apiToken),
      ...(apiToken ? { api_token: apiToken } : {}),
    };
  }

  private async resolveRefineRuntimeLlmPayload(
    userId: number,
    source: 'system' | 'personal',
  ): Promise<AgentRuntimeLlm | null> {
    const profile = await this.prisma.adminUserProfile.findUnique({ where: { userId } });

    if (source === 'personal') {
      const resolved = await this.aiRuntimeService.resolveEffectiveLlmFromProfile(profile, {
        includeApiToken: true,
        requireSystemDefault: true,
      });
      if (resolved.source !== 'personal') {
        return null;
      }

      return this.toRuntimeLlmPayload({
        provider: resolved.effective.provider,
        baseUrl: resolved.effective.baseUrl,
        model: resolved.effective.model,
        hasToken: resolved.hasPersonalToken,
        apiToken: resolved.apiToken,
      });
    }

    const strippedProfile = profile
      ? {
          ...profile,
          aiProvider: '',
          aiBaseUrl: '',
          aiModel: '',
          aiTokenCiphertext: null,
          aiTokenIv: null,
          aiTokenTag: null,
        }
      : null;
    const resolved = await this.aiRuntimeService.resolveEffectiveLlmFromProfile(strippedProfile as any, {
      includeApiToken: true,
      requireSystemDefault: true,
    });
    if (resolved.source !== 'system' || !resolved.forwardRuntimeLlm) {
      return null;
    }

    return this.toRuntimeLlmPayload({
      provider: resolved.effective.provider,
      baseUrl: resolved.effective.baseUrl,
      model: resolved.effective.model,
      hasToken: resolved.hasSystemToken,
      apiToken: resolved.apiToken,
    });
  }

  private normalizeRuntimeStrategy(input: {
    requested?: {
      positionMaxPct?: number | null;
      stopLossPct?: number | null;
      takeProfitPct?: number | null;
    };
    defaults: AgentRuntimeStrategy;
  }): AgentRuntimeStrategy {
    const requested = input.requested ?? {};
    return {
      position_max_pct: Math.max(
        0,
        Math.min(100, this.toNumber(requested.positionMaxPct, input.defaults.position_max_pct) ?? input.defaults.position_max_pct),
      ),
      stop_loss_pct: Math.max(
        0,
        Math.min(100, this.toNumber(requested.stopLossPct, input.defaults.stop_loss_pct) ?? input.defaults.stop_loss_pct),
      ),
      take_profit_pct: Math.max(
        0,
        Math.min(500, this.toNumber(requested.takeProfitPct, input.defaults.take_profit_pct) ?? input.defaults.take_profit_pct),
      ),
    };
  }

  private async resolveUserDefaults(userId: number): Promise<{
    runtimeStrategy: AgentRuntimeStrategy;
    runtimeLlm: AgentRuntimeLlm;
    runtimeLlmPayload: AgentRuntimeLlm | null;
    runtimeLlmSource: 'system' | 'personal';
  }> {
    const runtime = await this.analysisService.buildRuntimeContext(userId, { includeApiToken: true });
    const strategy = runtime.runtimeConfig.strategy;
    const llm = runtime.runtimeConfig.llm;
    return {
      runtimeStrategy: {
        position_max_pct: this.toNumber(strategy?.position_max_pct, 30) ?? 30,
        stop_loss_pct: this.toNumber(strategy?.stop_loss_pct, 8) ?? 8,
        take_profit_pct: this.toNumber(strategy?.take_profit_pct, 15) ?? 15,
      },
      runtimeLlm: {
        provider: String(runtime.effectiveLlm.provider ?? ''),
        base_url: String(runtime.effectiveLlm.baseUrl ?? ''),
        model: String(runtime.effectiveLlm.model ?? ''),
        has_token: Boolean(llm?.has_token),
        ...(llm?.api_token ? { api_token: String(llm.api_token) } : {}),
      },
      runtimeLlmPayload: llm
        ? {
            provider: String(llm.provider),
            base_url: String(llm.base_url),
            model: String(llm.model),
            has_token: Boolean(llm.has_token),
            ...(llm.api_token ? { api_token: String(llm.api_token) } : {}),
          }
        : null,
      runtimeLlmSource: runtime.llmSource,
    };
  }

  private buildSignalProfileHash(input: {
    ownerUserId: number;
    runtimeLlm: AgentRuntimeLlm;
    runtimeLlmSource: 'system' | 'personal';
    signalProfileVersion: string;
  }): string {
    return this.stableHash({
      owner_user_id: input.ownerUserId,
      signal_profile_version: input.signalProfileVersion,
      engine_version: ENGINE_VERSION,
      llm_source: input.runtimeLlmSource,
      llm: {
        provider: input.runtimeLlm.provider,
        base_url: input.runtimeLlm.base_url,
        model: input.runtimeLlm.model,
        has_token: input.runtimeLlm.has_token,
      },
    });
  }

  private buildRequestHash(input: {
    ownerUserId: number;
    code: string;
    startDate: string;
    endDate: string;
    initialCapital: number;
    commissionRate: number;
    slippageBps: number;
    runtimeStrategy: AgentRuntimeStrategy;
    signalProfileVersion: string;
  }): string {
    return this.stableHash({
      owner_user_id: input.ownerUserId,
      code: input.code,
      start_date: input.startDate,
      end_date: input.endDate,
      initial_capital: input.initialCapital,
      commission_rate: input.commissionRate,
      slippage_bps: input.slippageBps,
      runtime_strategy: input.runtimeStrategy,
      signal_profile_version: input.signalProfileVersion,
      engine_version: ENGINE_VERSION,
    });
  }

  private async findRunGroupByRequestHash(input: {
    requestHash: string;
    requester: RequesterScope;
  }): Promise<{ id: number } | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: number }>>(
      `
      SELECT "id"
      FROM "agent_backtest_run_groups"
      WHERE "request_hash" = $1
      ${input.requester.includeAll ? '' : 'AND "owner_user_id" = $2'}
      LIMIT 1
      `,
      ...(input.requester.includeAll
        ? [input.requestHash]
        : [input.requestHash, input.requester.userId]),
    );
    return rows[0] ?? null;
  }

  private async loadArchivedNews(input: {
    userId: number;
    code: string;
    startDate: Date;
    endDate: Date;
  }): Promise<Record<string, Array<Record<string, unknown>>>> {
    const lookbackStart = new Date(input.startDate.getTime() - 3 * 24 * 3600 * 1000);
    const rows = await this.prisma.newsIntel.findMany({
      where: {
        code: input.code,
        publishedDate: {
          gte: lookbackStart,
          lte: input.endDate,
        },
        OR: [
          { ownerUserId: input.userId },
          { ownerUserId: null },
        ],
      },
      orderBy: [{ publishedDate: 'desc' }, { fetchedAt: 'desc' }],
      select: {
        title: true,
        snippet: true,
        source: true,
        publishedDate: true,
      },
    });

    const grouped: Record<string, Array<Record<string, unknown>>> = {};
    for (const row of rows) {
      const published = this.toIsoDay(row.publishedDate);
      if (!published) {
        continue;
      }
      if (!grouped[published]) {
        grouped[published] = [];
      }
      if (grouped[published].length >= 3) {
        continue;
      }
      grouped[published].push({
        title: truncateText(row.title, 300),
        snippet: truncateText(row.snippet ?? '', 200),
        source: truncateText(row.source ?? '', 100),
        published_date: published,
      });
    }
    return grouped;
  }

  private async loadCachedSnapshots(input: {
    userId: number;
    code: string;
    startDate: string;
    endDate: string;
    signalProfileHash: string;
    snapshotVersion: number;
  }): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `
      SELECT
        "trade_date",
        "decision_source",
        "llm_used",
        "confidence",
        "factor_payload_json",
        "archived_news_payload_json",
        "signal_payload_json",
        "ai_overlay_json"
      FROM "agent_backtest_signal_snapshots"
      WHERE "owner_user_id" = $1
        AND "code" = $2
        AND "trade_date" BETWEEN $3::date AND $4::date
        AND "signal_profile_hash" = $5
        AND "snapshot_version" = $6
      ORDER BY "trade_date" ASC
      `,
      input.userId,
      input.code,
      input.startDate,
      input.endDate,
      input.signalProfileHash,
      input.snapshotVersion,
    );

    return rows.map((row) => ({
      trade_date: this.toIsoDay(row.trade_date),
      decision_source: String(row.decision_source ?? 'fast_rule'),
      llm_used: Boolean(row.llm_used),
      confidence: this.toNumber(row.confidence),
      factor_payload: asRecord(row.factor_payload_json),
      archived_news_payload: asRecord(row.archived_news_payload_json),
      signal_payload: asRecord(row.signal_payload_json),
      ai_overlay: asRecord(row.ai_overlay_json),
    }));
  }

  private normalizeSummary(summaryRaw: Record<string, unknown>, diagnostics: Record<string, unknown>, totalDays: number): Record<string, unknown> {
    const snapshotHitCount = this.toNumber(diagnostics.snapshot_hit_count, 0) ?? 0;
    const llmAnchorCount = this.toNumber(diagnostics.llm_anchor_count, 0) ?? 0;
    const snapshotHitRate = totalDays > 0 ? Number(((snapshotHitCount / totalDays) * 100).toFixed(2)) : 0;
    return {
      total_return_pct: this.toNumber(summaryRaw.total_return_pct, 0) ?? 0,
      benchmark_return_pct: this.toNumber(summaryRaw.benchmark_return_pct, 0) ?? 0,
      excess_return_pct: this.toNumber(summaryRaw.excess_return_pct, 0) ?? 0,
      max_drawdown_pct: this.toNumber(summaryRaw.max_drawdown_pct, 0) ?? 0,
      total_trades: this.toNumber(summaryRaw.total_trades, 0) ?? 0,
      win_rate_pct: this.toNumber(summaryRaw.win_rate_pct, 0) ?? 0,
      llm_anchor_count: llmAnchorCount,
      snapshot_hit_rate: snapshotHitRate,
      ...(summaryRaw.final_equity != null ? { final_equity: this.toNumber(summaryRaw.final_equity) } : {}),
      ...(summaryRaw.initial_capital != null ? { initial_capital: this.toNumber(summaryRaw.initial_capital) } : {}),
    };
  }

  private normalizeDiagnostics(diagnosticsRaw: Record<string, unknown>, dailySteps: AgentBacktestNormalizedResult['dailySteps']): Record<string, unknown> {
    const decisionSourceBreakdown = asRecord(diagnosticsRaw.decision_source_breakdown);
    if (Object.keys(decisionSourceBreakdown).length === 0) {
      for (const row of dailySteps) {
        const key = row.decisionSource || 'unknown';
        const current = Number(decisionSourceBreakdown[key] ?? 0);
        decisionSourceBreakdown[key] = current + 1;
      }
    }
    return {
      snapshot_hit_count: this.toNumber(diagnosticsRaw.snapshot_hit_count, 0) ?? 0,
      snapshot_miss_count: this.toNumber(diagnosticsRaw.snapshot_miss_count, 0) ?? 0,
      llm_anchor_count: this.toNumber(diagnosticsRaw.llm_anchor_count, 0) ?? 0,
      no_news_days: this.toNumber(diagnosticsRaw.no_news_days, 0) ?? 0,
      fast_refined_divergence_days: this.toNumber(diagnosticsRaw.fast_refined_divergence_days, 0) ?? 0,
      pending_anchor_dates: Array.isArray(diagnosticsRaw.pending_anchor_dates)
        ? diagnosticsRaw.pending_anchor_dates.map(item => String(item))
        : [],
      decision_source_breakdown: decisionSourceBreakdown,
    };
  }

  // Agent 返回结构会随着 phase 不同而略有差异，这里统一规整成 Backend 持久化使用的标准形态。
  private normalizeResult(payload: Record<string, unknown>, phase: 'fast' | 'refine'): AgentBacktestNormalizedResult {
    const requestedRange = asRecord(payload.requested_range);
    const effectiveRange = asRecord(payload.effective_range);
    const dailySteps = asRecordArray(payload.daily_steps).map((row) => ({
      tradeDate: String(row.trade_date ?? ''),
      decisionSource: String(row.decision_source ?? 'fast_rule'),
      aiUsed: Boolean(row.ai_used),
      dataPayload: asRecord(row.data_payload),
      signalPayload: asRecord(row.signal_payload),
      riskPayload: asRecord(row.risk_payload),
      executionPayload: asRecord(row.execution_payload),
    })).filter(row => row.tradeDate.length >= 10);
    const diagnostics = this.normalizeDiagnostics(asRecord(payload.diagnostics), dailySteps);
    const summary = this.normalizeSummary(asRecord(payload.summary), diagnostics, dailySteps.length);

    return {
      code: this.normalizeCode(String(payload.code ?? '')),
      engineVersion: String(payload.engine_version ?? ENGINE_VERSION),
      phase,
      requestedRange: {
        startDate: this.toIsoDay(requestedRange.start_date),
        endDate: this.toIsoDay(requestedRange.end_date),
      },
      effectiveRange: {
        startDate: this.toIsoDay(effectiveRange.start_date),
        endDate: this.toIsoDay(effectiveRange.end_date),
      },
      summary,
      diagnostics,
      dailySteps,
      trades: asRecordArray(payload.trades),
      equity: asRecordArray(payload.equity),
      signalSnapshots: asRecordArray(payload.signal_snapshots),
      pendingAnchorDates: Array.isArray(payload.pending_anchor_dates)
        ? payload.pending_anchor_dates.map(item => String(item))
        : (Array.isArray(diagnostics.pending_anchor_dates) ? diagnostics.pending_anchor_dates.map(item => String(item)) : []),
    };
  }

  private async insertRunGroup(
    tx: TxClient,
    input: {
      ownerUserId: number;
      code: string;
      startDate: string;
      endDate: string;
      effectiveStartDate: string | null;
      effectiveEndDate: string | null;
      requestHash: string;
      status: string;
      phase: string;
      progressPct: number;
      message: string | null;
      configJson: AgentBacktestConfigRow;
      summaryJson: Record<string, unknown>;
      diagnosticsJson: Record<string, unknown>;
      fastReadyAt: string | null;
      completedAt: string | null;
      activeResultVersion: number;
      latestResultVersion: number;
    },
  ): Promise<number | null> {
    const rows = await tx.$queryRawUnsafe<Array<{ id: number }>>(
      `
      INSERT INTO "agent_backtest_run_groups" (
        "owner_user_id",
        "code",
        "start_date",
        "end_date",
        "effective_start_date",
        "effective_end_date",
        "engine_version",
        "status",
        "phase",
        "request_hash",
        "active_result_version",
        "latest_result_version",
        "progress_pct",
        "message",
        "config_json",
        "summary_json",
        "diagnostics_json",
        "fast_ready_at",
        "completed_at",
        "created_at",
        "updated_at"
      )
      VALUES (
        $1, $2, $3::date, $4::date, $5::date, $6::date, $7, $8, $9, $10, $11, $12, $13, $14,
        CAST($15 AS JSONB), CAST($16 AS JSONB), CAST($17 AS JSONB), $18::timestamp, $19::timestamp,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT ("request_hash") DO NOTHING
      RETURNING "id"
      `,
      input.ownerUserId,
      input.code,
      input.startDate,
      input.endDate,
      input.effectiveStartDate,
      input.effectiveEndDate,
      ENGINE_VERSION,
      input.status,
      input.phase,
      input.requestHash,
      input.activeResultVersion,
      input.latestResultVersion,
      input.progressPct,
      input.message,
      safeJsonStringify(input.configJson),
      safeJsonStringify(input.summaryJson),
      safeJsonStringify(input.diagnosticsJson),
      input.fastReadyAt,
      input.completedAt,
    );
    return rows[0]?.id ?? null;
  }

  private async updateRunGroup(
    tx: TxClient,
    input: {
      runGroupId: number;
      effectiveStartDate: string | null;
      effectiveEndDate: string | null;
      status: string;
      phase: string;
      progressPct: number;
      message: string | null;
      summaryJson: Record<string, unknown>;
      diagnosticsJson: Record<string, unknown>;
      activeResultVersion: number;
      latestResultVersion: number;
      fastReadyAt?: string | null;
      completedAt?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `
      UPDATE "agent_backtest_run_groups"
      SET
        "effective_start_date" = $2::date,
        "effective_end_date" = $3::date,
        "status" = $4,
        "phase" = $5,
        "progress_pct" = $6,
        "message" = $7,
        "summary_json" = CAST($8 AS JSONB),
        "diagnostics_json" = CAST($9 AS JSONB),
        "active_result_version" = $10,
        "latest_result_version" = $11,
        "fast_ready_at" = COALESCE($12::timestamp, "fast_ready_at"),
        "completed_at" = $13::timestamp,
        "error_message" = $14,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = $1
      `,
      input.runGroupId,
      input.effectiveStartDate,
      input.effectiveEndDate,
      input.status,
      input.phase,
      input.progressPct,
      input.message,
      safeJsonStringify(input.summaryJson),
      safeJsonStringify(input.diagnosticsJson),
      input.activeResultVersion,
      input.latestResultVersion,
      input.fastReadyAt ?? null,
      input.completedAt ?? null,
      input.errorMessage ?? null,
    );
  }

  private async deleteResultVersionRows(tx: TxClient, runGroupId: number, resultVersion: number): Promise<void> {
    await tx.$executeRawUnsafe(
      `DELETE FROM "agent_backtest_daily_steps" WHERE "run_group_id" = $1 AND "result_version" = $2`,
      runGroupId,
      resultVersion,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "agent_backtest_trades" WHERE "run_group_id" = $1 AND "result_version" = $2`,
      runGroupId,
      resultVersion,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "agent_backtest_equity_points" WHERE "run_group_id" = $1 AND "result_version" = $2`,
      runGroupId,
      resultVersion,
    );
  }

  private async persistResultVersion(
    tx: TxClient,
    input: {
      runGroupId: number;
      resultVersion: number;
      result: AgentBacktestNormalizedResult;
    },
  ): Promise<void> {
    await this.deleteResultVersionRows(tx, input.runGroupId, input.resultVersion);

    for (const row of input.result.dailySteps) {
      await tx.$executeRawUnsafe(
        `
        INSERT INTO "agent_backtest_daily_steps" (
          "run_group_id",
          "result_version",
          "trade_date",
          "decision_source",
          "ai_used",
          "data_payload_json",
          "signal_payload_json",
          "risk_payload_json",
          "execution_payload_json"
        )
        VALUES ($1, $2, $3::date, $4, $5, CAST($6 AS JSONB), CAST($7 AS JSONB), CAST($8 AS JSONB), CAST($9 AS JSONB))
        `,
        input.runGroupId,
        input.resultVersion,
        row.tradeDate,
        row.decisionSource,
        row.aiUsed,
        safeJsonStringify(row.dataPayload),
        safeJsonStringify(row.signalPayload),
        safeJsonStringify(row.riskPayload),
        safeJsonStringify(row.executionPayload),
      );
    }

    for (const trade of input.result.trades) {
      await tx.$executeRawUnsafe(
        `
        INSERT INTO "agent_backtest_trades" (
          "run_group_id",
          "result_version",
          "entry_date",
          "exit_date",
          "entry_price",
          "exit_price",
          "qty",
          "gross_return_pct",
          "net_return_pct",
          "fees",
          "exit_reason"
        )
        VALUES ($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11)
        `,
        input.runGroupId,
        input.resultVersion,
        this.toIsoDay(trade.entry_date),
        this.toIsoDay(trade.exit_date),
        this.toNumber(trade.entry_price),
        this.toNumber(trade.exit_price),
        this.toNumber(trade.qty),
        this.toNumber(trade.gross_return_pct),
        this.toNumber(trade.net_return_pct),
        this.toNumber(trade.fees),
        trade.exit_reason == null ? null : String(trade.exit_reason),
      );
    }

    for (const point of input.result.equity) {
      await tx.$executeRawUnsafe(
        `
        INSERT INTO "agent_backtest_equity_points" (
          "run_group_id",
          "result_version",
          "trade_date",
          "equity",
          "drawdown_pct",
          "benchmark_equity",
          "position_ratio",
          "cash"
        )
        VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)
        `,
        input.runGroupId,
        input.resultVersion,
        this.toIsoDay(point.trade_date),
        this.toNumber(point.equity, 0) ?? 0,
        this.toNumber(point.drawdown_pct),
        this.toNumber(point.benchmark_equity),
        this.toNumber(point.position_ratio),
        this.toNumber(point.cash),
      );
    }
  }

  private async upsertSignalSnapshots(
    tx: TxClient,
    input: {
      ownerUserId: number;
      code: string;
      signalProfileHash: string;
      snapshotVersion: number;
      snapshots: Array<Record<string, unknown>>;
    },
  ): Promise<void> {
    for (const snapshot of input.snapshots) {
      const tradeDate = this.toIsoDay(snapshot.trade_date);
      if (!tradeDate) {
        continue;
      }
      await tx.$executeRawUnsafe(
        `
        INSERT INTO "agent_backtest_signal_snapshots" (
          "owner_user_id",
          "code",
          "trade_date",
          "signal_profile_hash",
          "snapshot_version",
          "decision_source",
          "llm_used",
          "confidence",
          "factor_payload_json",
          "archived_news_payload_json",
          "signal_payload_json",
          "ai_overlay_json",
          "created_at",
          "updated_at"
        )
        VALUES (
          $1, $2, $3::date, $4, $5, $6, $7, $8,
          CAST($9 AS JSONB), CAST($10 AS JSONB), CAST($11 AS JSONB), CAST($12 AS JSONB),
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("owner_user_id", "code", "trade_date", "signal_profile_hash", "snapshot_version")
        DO UPDATE SET
          "decision_source" = EXCLUDED."decision_source",
          "llm_used" = EXCLUDED."llm_used",
          "confidence" = EXCLUDED."confidence",
          "factor_payload_json" = EXCLUDED."factor_payload_json",
          "archived_news_payload_json" = EXCLUDED."archived_news_payload_json",
          "signal_payload_json" = EXCLUDED."signal_payload_json",
          "ai_overlay_json" = EXCLUDED."ai_overlay_json",
          "updated_at" = CURRENT_TIMESTAMP
        `,
        input.ownerUserId,
        input.code,
        tradeDate,
        input.signalProfileHash,
        input.snapshotVersion,
        String(snapshot.decision_source ?? 'fast_rule'),
        Boolean(snapshot.llm_used),
        this.toNumber(snapshot.confidence),
        safeJsonStringify(asRecord(snapshot.factor_payload)),
        safeJsonStringify(asRecord(snapshot.archived_news_payload)),
        safeJsonStringify(asRecord(snapshot.signal_payload)),
        safeJsonStringify(asRecord(snapshot.ai_overlay)),
      );
    }
  }

  private mapGroupRow(row: AgentBacktestGroupRow): Record<string, unknown> {
    const summary = asRecord(row.summary_json);
    const diagnostics = asRecord(row.diagnostics_json);
    const decisionSourceBreakdown = asRecord(diagnostics.decision_source_breakdown);
    const config = this.parseConfigRow(row.config_json);
    return {
      run_group_id: row.id,
      code: row.code,
      engine_version: row.engine_version,
      requested_range: {
        start_date: this.toIsoDay(row.start_date),
        end_date: this.toIsoDay(row.end_date),
      },
      effective_range: {
        start_date: this.toIsoDay(row.effective_start_date),
        end_date: this.toIsoDay(row.effective_end_date),
      },
      status: row.status,
      phase: row.phase,
      progress_pct: row.progress_pct,
      message: row.message,
      created_at: this.toIsoDateTime(row.created_at),
      completed_at: this.toIsoDateTime(row.completed_at),
      summary,
      diagnostics,
      decision_source_breakdown: decisionSourceBreakdown,
      llm_meta: this.buildPublicLlmMeta(config),
      legacy_event_backtest: false,
    };
  }

  private async loadGroupRow(input: {
    runGroupId: number;
    requester: RequesterScope;
  }): Promise<AgentBacktestGroupRow | null> {
    const rows = await this.prisma.$queryRawUnsafe<AgentBacktestGroupRow[]>(
      `
      SELECT *
      FROM "agent_backtest_run_groups"
      WHERE "id" = $1
      ${input.requester.includeAll ? '' : 'AND "owner_user_id" = $2'}
      LIMIT 1
      `,
      ...(input.requester.includeAll
        ? [input.runGroupId]
        : [input.runGroupId, input.requester.userId]),
    );
    return rows[0] ?? null;
  }

  private async loadDailySteps(runGroupId: number, resultVersion: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `
      SELECT *
      FROM "agent_backtest_daily_steps"
      WHERE "run_group_id" = $1 AND "result_version" = $2
      ORDER BY "trade_date" ASC
      `,
      runGroupId,
      resultVersion,
    );

    return rows.map((row) => ({
      trade_date: this.toIsoDay(row.trade_date),
      decision_source: String(row.decision_source ?? 'fast_rule'),
      ai_used: Boolean(row.ai_used),
      data_payload: asRecord(row.data_payload_json),
      signal_payload: asRecord(row.signal_payload_json),
      risk_payload: asRecord(row.risk_payload_json),
      execution_payload: asRecord(row.execution_payload_json),
    }));
  }

  private async loadTrades(runGroupId: number, resultVersion: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `
      SELECT *
      FROM "agent_backtest_trades"
      WHERE "run_group_id" = $1 AND "result_version" = $2
      ORDER BY COALESCE("entry_date", "exit_date") ASC, "id" ASC
      `,
      runGroupId,
      resultVersion,
    );

    return rows.map((row) => ({
      entry_date: this.toIsoDay(row.entry_date),
      exit_date: this.toIsoDay(row.exit_date),
      entry_price: this.toNumber(row.entry_price),
      exit_price: this.toNumber(row.exit_price),
      qty: this.toNumber(row.qty),
      gross_return_pct: this.toNumber(row.gross_return_pct),
      net_return_pct: this.toNumber(row.net_return_pct),
      fees: this.toNumber(row.fees),
      exit_reason: row.exit_reason == null ? null : String(row.exit_reason),
    }));
  }

  private async loadEquity(runGroupId: number, resultVersion: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `
      SELECT *
      FROM "agent_backtest_equity_points"
      WHERE "run_group_id" = $1 AND "result_version" = $2
      ORDER BY "trade_date" ASC
      `,
      runGroupId,
      resultVersion,
    );

    return rows.map((row) => ({
      trade_date: this.toIsoDay(row.trade_date),
      equity: this.toNumber(row.equity, 0) ?? 0,
      drawdown_pct: this.toNumber(row.drawdown_pct),
      benchmark_equity: this.toNumber(row.benchmark_equity),
      position_ratio: this.toNumber(row.position_ratio),
      cash: this.toNumber(row.cash),
    }));
  }

  async runAgentRange(input: {
    code: string;
    startDate: string;
    endDate: string;
    initialCapital?: number;
    commissionRate?: number;
    slippageBps?: number;
    runtimeStrategy?: {
      positionMaxPct?: number;
      stopLossPct?: number;
      takeProfitPct?: number;
    };
    enableRefine?: boolean;
    requester: RequesterScope;
  }): Promise<Record<string, unknown>> {
    await this.assertStorageReady();

    const code = this.normalizeCode(input.code);
    if (!code) {
      throw new Error('code is required');
    }

    const startDate = this.toDay(input.startDate);
    const endDate = this.toDay(input.endDate);
    if (!startDate || !endDate) {
      throw new Error('start_date and end_date are required');
    }
    if (startDate.getTime() > endDate.getTime()) {
      throw new Error('start_date must be <= end_date');
    }

    const initialCapital = Math.max(1, this.toNumber(input.initialCapital, 100000) ?? 100000);
    const commissionRate = Math.max(0, this.toNumber(input.commissionRate, 0.0003) ?? 0.0003);
    const slippageBps = Math.max(0, this.toNumber(input.slippageBps, 2) ?? 2);
    const enableRefine = input.enableRefine !== false;

    const defaults = await this.resolveUserDefaults(input.requester.userId);
    const runtimeStrategy = this.normalizeRuntimeStrategy({
      requested: input.runtimeStrategy,
      defaults: defaults.runtimeStrategy,
    });
    const signalProfileHash = this.buildSignalProfileHash({
      ownerUserId: input.requester.userId,
      runtimeLlm: defaults.runtimeLlm,
      runtimeLlmSource: defaults.runtimeLlmSource,
      signalProfileVersion: SIGNAL_PROFILE_VERSION,
    });
    const requestHash = this.buildRequestHash({
      ownerUserId: input.requester.userId,
      code,
      startDate: this.toIsoDay(startDate) ?? input.startDate,
      endDate: this.toIsoDay(endDate) ?? input.endDate,
      initialCapital,
      commissionRate,
      slippageBps,
      runtimeStrategy,
      signalProfileVersion: SIGNAL_PROFILE_VERSION,
    });

    const existing = await this.findRunGroupByRequestHash({
      requestHash,
      requester: input.requester,
    });
    if (existing) {
      const detail = await this.getAgentRunDetail({
        runGroupId: existing.id,
        requester: input.requester,
      });
      if (detail) {
        return detail;
      }
    }

    const archivedNewsByDate = await this.loadArchivedNews({
      userId: input.requester.userId,
      code,
      startDate,
      endDate,
    });
    const cachedSnapshots = await this.loadCachedSnapshots({
      userId: input.requester.userId,
      code,
      startDate: this.toIsoDay(startDate) ?? input.startDate,
      endDate: this.toIsoDay(endDate) ?? input.endDate,
      signalProfileHash,
      snapshotVersion: SNAPSHOT_VERSION,
    });

    const payload = await this.backtestAgentClient.agentRun({
      code,
      start_date: this.toIsoDay(startDate),
      end_date: this.toIsoDay(endDate),
      phase: 'fast',
      initial_capital: initialCapital,
      commission_rate: commissionRate,
      slippage_bps: slippageBps,
      runtime_strategy: runtimeStrategy,
      signal_profile_hash: signalProfileHash,
      snapshot_version: SNAPSHOT_VERSION,
      archived_news_by_date: archivedNewsByDate,
      cached_snapshots: cachedSnapshots,
      ...(defaults.runtimeLlmPayload ? { runtime_llm: defaults.runtimeLlmPayload } : {}),
    });

    const normalized = this.normalizeResult(payload, 'fast');
    if (normalized.dailySteps.length === 0) {
      throw new Error('agent historical backtest returned empty daily_steps');
    }

    const pendingAnchorDates = normalized.pendingAnchorDates;
    const shouldRefine = enableRefine && pendingAnchorDates.length > 0;
    const configRow: AgentBacktestConfigRow = {
      initial_capital: initialCapital,
      commission_rate: commissionRate,
      slippage_bps: slippageBps,
      enable_refine: enableRefine,
      runtime_strategy: runtimeStrategy,
      signal_profile_hash: signalProfileHash,
      signal_profile_version: SIGNAL_PROFILE_VERSION,
      snapshot_version: SNAPSHOT_VERSION,
      runtime_llm: sanitizeRuntimeLlm(defaults.runtimeLlm),
      runtime_llm_source: defaults.runtimeLlmSource,
    };

    const runGroupId = await this.prisma.$transaction(async (tx) => {
      const insertedId = await this.insertRunGroup(tx, {
        ownerUserId: input.requester.userId,
        code,
        startDate: this.toIsoDay(startDate) ?? input.startDate,
        endDate: this.toIsoDay(endDate) ?? input.endDate,
        effectiveStartDate: normalized.effectiveRange.startDate,
        effectiveEndDate: normalized.effectiveRange.endDate,
        requestHash,
        status: shouldRefine ? 'refining' : 'completed',
        phase: shouldRefine ? 'fast' : 'done',
        progressPct: shouldRefine ? 55 : 100,
        message: shouldRefine ? 'fast_completed_waiting_refine' : 'completed',
        configJson: configRow,
        summaryJson: normalized.summary,
        diagnosticsJson: normalized.diagnostics,
        fastReadyAt: new Date().toISOString(),
        completedAt: shouldRefine ? null : new Date().toISOString(),
        activeResultVersion: 1,
        latestResultVersion: 1,
      });

      if (insertedId == null) {
        const raceExisting = await this.findRunGroupByRequestHash({
          requestHash,
          requester: input.requester,
        });
        if (!raceExisting) {
          throw new Error('failed to create or resolve existing agent backtest run');
        }
        return raceExisting.id;
      }

      await this.persistResultVersion(tx, {
        runGroupId: insertedId,
        resultVersion: 1,
        result: normalized,
      });
      await this.upsertSignalSnapshots(tx, {
        ownerUserId: input.requester.userId,
        code,
        signalProfileHash,
        snapshotVersion: SNAPSHOT_VERSION,
        snapshots: normalized.signalSnapshots,
      });
      await this.updateRunGroup(tx, {
        runGroupId: insertedId,
        effectiveStartDate: normalized.effectiveRange.startDate,
        effectiveEndDate: normalized.effectiveRange.endDate,
        status: shouldRefine ? 'refining' : 'completed',
        phase: shouldRefine ? 'fast' : 'done',
        progressPct: shouldRefine ? 55 : 100,
        message: shouldRefine ? 'fast_completed_waiting_refine' : 'completed',
        summaryJson: normalized.summary,
        diagnosticsJson: normalized.diagnostics,
        activeResultVersion: 1,
        latestResultVersion: 1,
        fastReadyAt: new Date().toISOString(),
        completedAt: shouldRefine ? null : new Date().toISOString(),
        errorMessage: null,
      });
      return insertedId;
    });

    const detail = await this.getAgentRunDetail({
      runGroupId,
      requester: input.requester,
    });
    if (!detail) {
      throw new Error('agent backtest detail missing after persistence');
    }
    return detail;
  }

  async listAgentRuns(input: {
    code?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    page: number;
    limit: number;
    requester: RequesterScope;
  }): Promise<Record<string, unknown>> {
    await this.assertStorageReady();

    const clauses = ['1 = 1'];
    const values: unknown[] = [];

    if (!input.requester.includeAll) {
      values.push(input.requester.userId);
      clauses.push(`"owner_user_id" = $${values.length}`);
    }
    if (String(input.code ?? '').trim()) {
      values.push(this.normalizeCode(String(input.code)));
      clauses.push(`"code" = $${values.length}`);
    }
    if (String(input.status ?? '').trim()) {
      values.push(String(input.status).trim());
      clauses.push(`"status" = $${values.length}`);
    }
    if (String(input.startDate ?? '').trim()) {
      const startDate = this.toDay(String(input.startDate));
      if (!startDate) {
        throw new Error('invalid start_date');
      }
      values.push(this.toIsoDay(startDate));
      clauses.push(`"start_date" = $${values.length}::date`);
    }
    if (String(input.endDate ?? '').trim()) {
      const endDate = this.toDay(String(input.endDate));
      if (!endDate) {
        throw new Error('invalid end_date');
      }
      values.push(this.toIsoDay(endDate));
      clauses.push(`"end_date" = $${values.length}::date`);
    }

    const whereClause = clauses.join(' AND ');
    const totalRows = await this.prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
      `SELECT COUNT(*)::bigint AS count FROM "agent_backtest_run_groups" WHERE ${whereClause}`,
      ...values,
    );
    const total = Number(totalRows[0]?.count ?? 0);

    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit)));
    const page = Math.max(1, Math.trunc(input.page));
    values.push(limit);
    values.push((page - 1) * limit);

    const rows = await this.prisma.$queryRawUnsafe<AgentBacktestGroupRow[]>(
      `
      SELECT *
      FROM "agent_backtest_run_groups"
      WHERE ${whereClause}
      ORDER BY "created_at" DESC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
      `,
      ...values,
    );

    return {
      total,
      page,
      limit,
      items: rows.map((row) => {
        const base = this.mapGroupRow(row);
        return {
          run_group_id: base.run_group_id,
          code: base.code,
          requested_range: base.requested_range,
          effective_range: base.effective_range,
          status: base.status,
          phase: base.phase,
          created_at: base.created_at,
          completed_at: base.completed_at,
          llm_meta: base.llm_meta,
          summary: base.summary,
        };
      }),
      legacy_event_backtest: false,
    };
  }

  async getAgentRunDetail(input: {
    runGroupId: number;
    requester: RequesterScope;
  }): Promise<Record<string, unknown> | null> {
    await this.assertStorageReady();

    const row = await this.loadGroupRow(input);
    if (!row) {
      return null;
    }

    const base = this.mapGroupRow(row);
    const activeResultVersion = Math.max(1, Number(row.active_result_version ?? 1));
    const [dailySteps, trades, equity] = await Promise.all([
      this.loadDailySteps(row.id, activeResultVersion),
      this.loadTrades(row.id, activeResultVersion),
      this.loadEquity(row.id, activeResultVersion),
    ]);

    return {
      ...base,
      active_result_version: activeResultVersion,
      daily_steps: dailySteps,
      trades,
      equity,
    };
  }

  // refine worker 通过“先挑一条 fast、再条件更新加锁”的方式串行补精修，避免多实例重复精修同一组结果。
  async processNextRefineJob(): Promise<boolean> {
    if (!(await this.isStorageReady())) {
      return false;
    }

    const pickedRows = await this.prisma.$queryRawUnsafe<Array<{ id: number }>>(
      `
      SELECT "id"
      FROM "agent_backtest_run_groups"
      WHERE "status" = 'refining' AND "phase" = 'fast'
      ORDER BY "created_at" ASC
      LIMIT 1
      `,
    );
    const picked = pickedRows[0];
    if (!picked) {
      return false;
    }

    const lockCount = await this.prisma.$executeRawUnsafe(
      `
      UPDATE "agent_backtest_run_groups"
      SET "phase" = 'refine', "message" = 'refining', "progress_pct" = 75, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "status" = 'refining' AND "phase" = 'fast'
      `,
      picked.id,
    );
    if (!lockCount) {
      return false;
    }

    const workerScope: RequesterScope = { userId: 0, includeAll: true };
    const row = await this.loadGroupRow({
      runGroupId: picked.id,
      requester: workerScope,
    });
    if (!row) {
      return false;
    }

    const config = this.parseConfigRow(row.config_json);

    try {
      const startDate = this.toDay(row.start_date);
      const endDate = this.toDay(row.end_date);
      if (!startDate || !endDate) {
        throw new Error('invalid stored run range');
      }

      const archivedNewsByDate = await this.loadArchivedNews({
        userId: row.owner_user_id ?? 0,
        code: row.code,
        startDate,
        endDate,
      });
      const cachedSnapshots = await this.loadCachedSnapshots({
        userId: row.owner_user_id ?? 0,
        code: row.code,
        startDate: this.toIsoDay(startDate) ?? '',
        endDate: this.toIsoDay(endDate) ?? '',
        signalProfileHash: config.signal_profile_hash,
        snapshotVersion: config.snapshot_version,
      });
      // 如果 fast 阶段要求精修时使用个人 AI，则这里必须再次回源真实 token，不能静默回退系统默认模型。
      const runtimeLlmPayload = row.owner_user_id != null
        ? await this.resolveRefineRuntimeLlmPayload(row.owner_user_id, config.runtime_llm_source)
        : null;
      if (config.runtime_llm_source === 'personal' && !runtimeLlmPayload) {
        throw new Error(PERSONAL_REFINE_RUNTIME_MISSING_MESSAGE);
      }

      const payload = await this.backtestAgentClient.agentRun({
        code: row.code,
        start_date: this.toIsoDay(startDate),
        end_date: this.toIsoDay(endDate),
        phase: 'refine',
        initial_capital: config.initial_capital,
        commission_rate: config.commission_rate,
        slippage_bps: config.slippage_bps,
        runtime_strategy: config.runtime_strategy,
        signal_profile_hash: config.signal_profile_hash,
        snapshot_version: config.snapshot_version,
        archived_news_by_date: archivedNewsByDate,
        cached_snapshots: cachedSnapshots,
        ...(runtimeLlmPayload ? { runtime_llm: runtimeLlmPayload } : {}),
      });

      const normalized = this.normalizeResult(payload, 'refine');
      await this.prisma.$transaction(async (tx) => {
        await this.persistResultVersion(tx, {
          runGroupId: row.id,
          resultVersion: 2,
          result: normalized,
        });
        if (row.owner_user_id != null) {
          await this.upsertSignalSnapshots(tx, {
            ownerUserId: row.owner_user_id,
            code: row.code,
            signalProfileHash: config.signal_profile_hash,
            snapshotVersion: config.snapshot_version,
            snapshots: normalized.signalSnapshots,
          });
        }
        await this.updateRunGroup(tx, {
          runGroupId: row.id,
          effectiveStartDate: normalized.effectiveRange.startDate,
          effectiveEndDate: normalized.effectiveRange.endDate,
          status: 'completed',
          phase: 'done',
          progressPct: 100,
          message: 'completed',
          summaryJson: normalized.summary,
          diagnosticsJson: normalized.diagnostics,
          activeResultVersion: 2,
          latestResultVersion: 2,
          completedAt: new Date().toISOString(),
          errorMessage: null,
        });
      });
      return true;
    } catch (error: unknown) {
      const message = truncateText((error as Error)?.message ?? error, 500);
      this.logger.error(`Agent backtest refine failed runGroupId=${row.id}: ${message}`);
      await this.prisma.$executeRawUnsafe(
        `
        UPDATE "agent_backtest_run_groups"
        SET
          "status" = 'failed',
          "phase" = 'done',
          "progress_pct" = 100,
          "message" = 'failed',
          "error_message" = $2,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = $1
        `,
        row.id,
        message,
      );
      return true;
    }
  }
}
