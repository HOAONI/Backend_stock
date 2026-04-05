/** 交易账户模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';
import { UserBrokerSnapshotCache } from '@prisma/client';

import { BrokerAdapterRegistry } from '@/common/broker/broker-adapter.registry';
import { isBrokerGatewayError } from '@/common/broker/broker.errors';
import { BrokerAccessContext, OrderRequest } from '@/common/broker/broker.types';
import { PrismaService } from '@/common/database/prisma.service';
import { safeJsonParse, safeJsonStringify } from '@/common/utils/json';
import { BrokerAccountsService } from '@/modules/broker-accounts/broker-accounts.service';

interface ServiceError extends Error {
  code?: string;
  statusCode?: number;
}

type NormalizedPositionItem = Record<string, unknown> & {
  code: string;
  stock_name: string | null;
  quantity: number;
  available_qty: number;
  avg_cost: number | null;
  last_price: number | null;
  market_value: number | null;
  industry_name: string | null;
};

type PortfolioHealthPositionItem = NormalizedPositionItem & {
  cost_basis: number | null;
  unrealized_pnl: number | null;
  unrealized_return_pct: number | null;
  weight_pct: number | null;
  invested_weight_pct: number | null;
};

function createServiceError(code: string, message: string, statusCode?: number): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value: unknown, max = 128): string | null {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  return text.slice(0, max);
}

function asString(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizePositionItem(item: Record<string, unknown>): NormalizedPositionItem {
  const quantity = asNumber(item.quantity ?? item.qty ?? item.volume) ?? 0;
  const availableQty = asNumber(item.available_qty ?? item.availableQty ?? item.available ?? quantity) ?? quantity;
  const avgCost = asNumber(item.avg_cost ?? item.avgCost ?? item.cost_price ?? item.costPrice);
  const lastPrice = asNumber(item.last_price ?? item.lastPrice ?? item.price);
  const marketValue = asNumber(item.market_value ?? item.marketValue) ?? (
    lastPrice != null && quantity > 0 ? Number((lastPrice * quantity).toFixed(4)) : null
  );
  const industryName = normalizeText(
    item.industry
    ?? item.industry_name
    ?? item.industryName
    ?? item.sector
    ?? item.sector_name
    ?? item.sectorName
    ?? item.board_name
    ?? item.boardName
    ?? item.category
    ?? item.category_name
    ?? item.categoryName,
  );

  return {
    ...item,
    code: String(item.code ?? item.stock_code ?? item.stockCode ?? item.symbol ?? '').trim(),
    stock_name: String(item.stock_name ?? item.stockName ?? item.name ?? '').trim() || null,
    quantity: Math.max(0, Math.floor(quantity)),
    available_qty: Math.max(0, Math.floor(Math.min(availableQty, quantity))),
    avg_cost: avgCost,
    last_price: lastPrice,
    market_value: marketValue,
    industry_name: industryName,
  };
}

function pickFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = asNumber(value);
    if (parsed != null) {
      return parsed;
    }
  }
  return null;
}

function extractDateTimestamp(item: Record<string, unknown>): number {
  for (const key of ['closed_at', 'closedAt', 'trade_date', 'tradeDate', 'submitted_at', 'submittedAt', 'created_at', 'createdAt', 'date']) {
    const raw = item[key];
    if (raw == null) {
      continue;
    }
    const ts = new Date(String(raw)).getTime();
    if (Number.isFinite(ts)) {
      return ts;
    }
  }
  return 0;
}

function normalizeTradeItem(item: Record<string, unknown>): Record<string, unknown> {
  const quantity = Math.max(0, Math.floor(asNumber(item.quantity ?? item.qty ?? item.volume) ?? 0));
  const entryPrice = asNumber(item.entry_price ?? item.entryPrice ?? item.avg_cost ?? item.avgCost ?? item.cost_price);
  const exitPrice = asNumber(item.exit_price ?? item.exitPrice ?? item.price ?? item.last_price ?? item.lastPrice);
  const realizedPnl = pickFiniteNumber(
    item.realized_pnl,
    item.realizedPnl,
    item.pnl,
    item.net_pnl,
    item.netPnl,
    item.profit,
    item.gross_profit,
    item.grossProfit,
  );
  const costBasis = pickFiniteNumber(
    item.cost_basis,
    item.costBasis,
    item.turnover,
    item.amount,
    quantity > 0 && entryPrice != null ? quantity * entryPrice : null,
  );
  const returnPct = pickFiniteNumber(
    item.return_pct,
    item.returnPct,
    item.net_return_pct,
    item.netReturnPct,
    item.profit_rate,
    realizedPnl != null && costBasis != null && costBasis > 0 ? (realizedPnl / costBasis) * 100 : null,
  );

  return {
    ...item,
    code: String(item.code ?? item.stock_code ?? item.stockCode ?? item.symbol ?? '').trim(),
    stock_name: normalizeText(item.stock_name ?? item.stockName ?? item.name),
    quantity,
    entry_price: entryPrice,
    exit_price: exitPrice,
    realized_pnl: realizedPnl,
    return_pct: returnPct,
    cost_basis: costBasis,
    trade_timestamp: extractDateTimestamp(item),
  };
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: number[] = [];
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item)) {
      items.push(item);
      continue;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const candidate = pickFiniteNumber(record.equity, record.value, record.total_asset, record.totalAsset, record.balance, record.nav);
      if (candidate != null) {
        items.push(candidate);
      }
    }
  }
  return items;
}

function deriveReturnsFromEquity(equityPoints: number[]): number[] {
  if (equityPoints.length < 2) {
    return [];
  }
  const returns: number[] = [];
  for (let index = 1; index < equityPoints.length; index += 1) {
    const prev = equityPoints[index - 1];
    const next = equityPoints[index];
    if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0) {
      continue;
    }
    returns.push((next - prev) / prev);
  }
  return returns;
}

function computeMaxDrawdownPctFromEquity(equityPoints: number[]): number | null {
  if (equityPoints.length < 2) {
    return null;
  }
  let peak = 0;
  let maxDrawdown = 0;
  for (const point of equityPoints) {
    if (!Number.isFinite(point) || point <= 0) {
      continue;
    }
    if (point > peak) {
      peak = point;
      continue;
    }
    if (peak <= 0) {
      continue;
    }
    const drawdown = ((peak - point) / peak) * 100;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }
  return maxDrawdown > 0 ? Number(maxDrawdown.toFixed(4)) : null;
}

function computeSharpeRatio(returns: number[], annualizationFactor = Math.sqrt(252)): number | null {
  if (returns.length < 2) {
    return null;
  }
  const mean = returns.reduce((sum, item) => sum + item, 0) / returns.length;
  const variance = returns.reduce((sum, item) => sum + ((item - mean) ** 2), 0) / (returns.length - 1);
  if (!Number.isFinite(variance) || variance <= 0) {
    return null;
  }
  const std = Math.sqrt(variance);
  if (std <= 0) {
    return null;
  }
  return Number(((mean / std) * annualizationFactor).toFixed(4));
}

function extractItemDateText(item: Record<string, unknown>): string | null {
  for (const key of ['trade_date', 'tradeDate', 'submitted_at', 'submittedAt', 'created_at', 'createdAt', 'date']) {
    const text = normalizeText(item[key], 32);
    if (text && text.length >= 10) {
      return text.slice(0, 10);
    }
  }
  return null;
}

function resolveProviderOrderId(value: Record<string, unknown>): string | null {
  return normalizeText(value.provider_order_id ?? value.providerOrderId ?? value.order_id ?? value.orderId);
}

function resolveProviderStatus(value: Record<string, unknown>): string | null {
  return normalizeText(value.provider_status ?? value.providerStatus ?? value.status, 64);
}

function resolveSubmittedAt(value: Record<string, unknown>): string {
  const raw = normalizeText(value.submitted_at ?? value.submittedAt ?? value.created_at ?? value.createdAt, 64);
  return raw ?? new Date().toISOString();
}

function resolveAuditStatus(value: Record<string, unknown>): 'submitted' | 'failed' {
  const status = String(value.provider_status ?? value.providerStatus ?? value.status ?? '')
    .trim()
    .toLowerCase();
  return status === 'rejected' || status === 'failed' ? 'failed' : 'submitted';
}

function defaultProviderCode(): string {
  return 'backtrader_local';
}

function defaultProviderName(providerCode: string | null | undefined): string | null {
  const code = String(providerCode ?? defaultProviderCode()).trim().toLowerCase();
  if (!code) {
    return null;
  }
  if (code === 'backtrader_local') {
    return 'Backtrader Local Sim';
  }
  return 'Backtrader Local Sim';
}

interface SnapshotPayload {
  account: {
    broker_account_id: number;
    broker_code: string;
    provider_code: string | null;
    provider_name: string | null;
    order_channel: 'backtrader_local';
    environment: string;
    account_uid: string;
    account_display_name: string | null;
  };
  snapshot_at: string;
  data_source: 'cache' | 'upstream';
  summary: Record<string, unknown>;
  positions: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  performance: Record<string, unknown>;
}

export interface TradingRuntimeContextPayload {
  broker_account_id: number;
  broker_code: string;
  provider_code: string | null;
  provider_name: string | null;
  account_uid: string;
  account_display_name: string | null;
  snapshot_at: string;
  data_source: 'cache' | 'upstream';
  summary: Record<string, unknown>;
  positions: Array<Record<string, unknown>>;
}

export interface TradingAccountStatePayload extends TradingRuntimeContextPayload {
  available_cash: number | null;
  total_market_value: number | null;
  total_asset: number | null;
  order_count: number;
  trade_count: number;
  today_order_count: number;
  today_trade_count: number;
}

export interface TradingPortfolioHealthPayload extends TradingAccountStatePayload {
  performance: Record<string, unknown>;
  recent_trades: Array<Record<string, unknown>>;
  metrics: Record<string, unknown>;
  exposures: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class TradingAccountService {
  private readonly cacheTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerAccountsService: BrokerAccountsService,
    private readonly brokerRegistry: BrokerAdapterRegistry,
  ) {
    this.cacheTtlMs = Math.max(5000, Number(process.env.BROKER_SNAPSHOT_CACHE_TTL_MS ?? '60000'));
  }

  private parseCacheRow(row: UserBrokerSnapshotCache, dataSource: 'cache' | 'upstream'): SnapshotPayload {
    return {
      account: {
        broker_account_id: row.brokerAccountId,
        broker_code: '',
        provider_code: null,
        provider_name: null,
        order_channel: 'backtrader_local',
        environment: 'simulation',
        account_uid: '',
        account_display_name: null,
      },
      snapshot_at: row.snapshotAt.toISOString(),
      data_source: dataSource,
      summary: safeJsonParse<Record<string, unknown>>(row.summaryJson, {}),
      positions: safeJsonParse<Array<Record<string, unknown>>>(row.positionsJson, []),
      orders: safeJsonParse<Array<Record<string, unknown>>>(row.ordersJson, []),
      trades: safeJsonParse<Array<Record<string, unknown>>>(row.tradesJson, []),
      performance: safeJsonParse<Record<string, unknown>>(row.performanceJson, {}),
    };
  }

  private buildPerformance(summary: Record<string, unknown>): Record<string, unknown> {
    const totalAsset = asNumber(summary.total_asset ?? summary.totalAsset ?? summary.total_equity);
    const cash = asNumber(summary.cash ?? summary.available_cash ?? summary.availableCash);
    const marketValue = asNumber(summary.market_value ?? summary.total_market_value ?? summary.marketValue);
    const pnlDaily = asNumber(summary.pnl_daily ?? summary.daily_pnl ?? summary.today_pnl);
    const pnlTotal = asNumber(summary.pnl_total ?? summary.total_pnl ?? summary.profit_total);
    const returnPct = asNumber(summary.return_pct ?? summary.total_return_pct ?? summary.profit_rate);

    return {
      total_asset: totalAsset,
      cash,
      market_value: marketValue,
      pnl_daily: pnlDaily,
      pnl_total: pnlTotal,
      return_pct: returnPct,
      raw_summary: summary,
    };
  }

  private async loadCachedSnapshot(userId: number, brokerAccountId: number): Promise<UserBrokerSnapshotCache | null> {
    return await this.prisma.userBrokerSnapshotCache.findUnique({
      where: {
        userId_brokerAccountId: {
          userId,
          brokerAccountId,
        },
      },
    });
  }

  private toPublicAccountMeta(
    access: Pick<
      BrokerAccessContext,
      'brokerAccountId' | 'brokerCode' | 'providerCode' | 'providerName' | 'environment' | 'accountUid' | 'accountDisplayName'
    >,
  ): SnapshotPayload['account'] {
    const providerCode = access.providerCode ?? defaultProviderCode();
    return {
      broker_account_id: access.brokerAccountId,
      broker_code: access.brokerCode,
      provider_code: providerCode,
      provider_name: access.providerName ?? defaultProviderName(providerCode),
      order_channel: 'backtrader_local',
      environment: access.environment,
      account_uid: access.accountUid,
      account_display_name: access.accountDisplayName,
    };
  }

  private async fetchAndCache(userId: number): Promise<SnapshotPayload> {
    const access = await this.brokerAccountsService.resolveSimulationAccess(userId, { requireVerified: true });
    const adapter = this.brokerRegistry.getAdapter(access.brokerCode);

    try {
      const [summary, positions, orders, trades] = await Promise.all([
        adapter.getAccountSummary(access),
        adapter.getPositions(access),
        adapter.getOrders(access),
        adapter.getTrades(access),
      ]);

      const performance = this.buildPerformance(summary);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.cacheTtlMs);

      await this.prisma.userBrokerSnapshotCache.upsert({
        where: {
          userId_brokerAccountId: {
            userId,
            brokerAccountId: access.brokerAccountId,
          },
        },
        update: {
          summaryJson: safeJsonStringify(summary),
          positionsJson: safeJsonStringify(positions),
          ordersJson: safeJsonStringify(orders),
          tradesJson: safeJsonStringify(trades),
          performanceJson: safeJsonStringify(performance),
          snapshotAt: now,
          expiresAt,
        },
        create: {
          userId,
          brokerAccountId: access.brokerAccountId,
          summaryJson: safeJsonStringify(summary),
          positionsJson: safeJsonStringify(positions),
          ordersJson: safeJsonStringify(orders),
          tradesJson: safeJsonStringify(trades),
          performanceJson: safeJsonStringify(performance),
          snapshotAt: now,
          expiresAt,
        },
      });

      return {
        account: this.toPublicAccountMeta(access),
        snapshot_at: now.toISOString(),
        data_source: 'upstream',
        summary,
        positions,
        orders,
        trades,
        performance,
      };
    } catch (error: unknown) {
      if (isBrokerGatewayError(error)) {
        throw createServiceError('UPSTREAM_ERROR', error.message, error.statusCode);
      }
      throw error;
    }
  }

  private async resolveSnapshot(
    userId: number,
    options?: { refresh?: boolean },
  ): Promise<SnapshotPayload> {
    const access = await this.brokerAccountsService.resolveSimulationAccess(userId, { requireVerified: true });

    const cached = await this.loadCachedSnapshot(userId, access.brokerAccountId);
    const now = Date.now();
    const isCacheFresh = cached ? cached.expiresAt.getTime() > now : false;
    if (!options?.refresh && cached && isCacheFresh) {
      // 缓存命中时仍要用最新 access 元信息覆盖展示字段，避免 provider/account 名称过期。
      const parsed = this.parseCacheRow(cached, 'cache');
      parsed.account = this.toPublicAccountMeta(access);
      return parsed;
    }

    return await this.fetchAndCache(userId);
  }

  private normalizeIdempotencyKey(value: unknown): string | null {
    const text = String(value ?? '').trim();
    if (!text) {
      return null;
    }
    return text.slice(0, 128);
  }

  // 提供给分析链路的 runtime context 只保留下单决策真正需要的摘要和持仓，避免上下文过重。
  async getRuntimeContext(userId: number, refresh = false): Promise<TradingRuntimeContextPayload> {
    const snapshot = await this.resolveSnapshot(userId, { refresh });
    return {
      broker_account_id: snapshot.account.broker_account_id,
      broker_code: snapshot.account.broker_code,
      provider_code: snapshot.account.provider_code,
      provider_name: snapshot.account.provider_name,
      account_uid: snapshot.account.account_uid,
      account_display_name: snapshot.account.account_display_name,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      summary: snapshot.summary,
      positions: snapshot.positions,
    };
  }

  async getAccountState(userId: number, refresh = false): Promise<TradingAccountStatePayload> {
    const snapshot = await this.resolveSnapshot(userId, { refresh });
    const summary = asRecord(snapshot.summary);
    const snapshotDate = String(snapshot.snapshot_at ?? '').slice(0, 10);
    const normalizedPositions = snapshot.positions.map(normalizePositionItem);
    const countForDate = (items: Array<Record<string, unknown>>): number =>
      items.reduce((total, item) => (extractItemDateText(item) === snapshotDate ? total + 1 : total), 0);

    return {
      broker_account_id: snapshot.account.broker_account_id,
      broker_code: snapshot.account.broker_code,
      provider_code: snapshot.account.provider_code,
      provider_name: snapshot.account.provider_name,
      account_uid: snapshot.account.account_uid,
      account_display_name: snapshot.account.account_display_name,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      summary,
      positions: normalizedPositions,
      available_cash: asNumber(summary.cash ?? summary.available_cash ?? summary.availableCash),
      total_market_value: asNumber(summary.market_value ?? summary.total_market_value ?? summary.marketValue),
      total_asset: asNumber(summary.total_asset ?? summary.total_equity ?? summary.totalAsset),
      order_count: snapshot.orders.length,
      trade_count: snapshot.trades.length,
      today_order_count: countForDate(snapshot.orders),
      today_trade_count: countForDate(snapshot.trades),
    };
  }

  private resolvePortfolioMetric(
    summary: Record<string, unknown>,
    performance: Record<string, unknown>,
    ...keys: string[]
  ): number | null {
    const rawSummary = asRecord(performance.raw_summary);
    for (const key of keys) {
      const camelKey = key.replace(/_([a-z])/g, (_matched, letter: string) => letter.toUpperCase());
      const value = pickFiniteNumber(
        summary[key],
        summary[camelKey],
        performance[key],
        performance[camelKey],
        rawSummary[key],
        rawSummary[camelKey],
      );
      if (value != null) {
        return value;
      }
    }
    return null;
  }

  private resolvePortfolioEquitySeries(
    summary: Record<string, unknown>,
    performance: Record<string, unknown>,
    normalizedTrades: Array<Record<string, unknown>>,
    initialCapital: number | null,
    totalAsset: number | null,
  ): number[] {
    const rawSummary = asRecord(performance.raw_summary);
    for (const key of ['equity_curve', 'equityCurve', 'equity_points', 'equityPoints', 'asset_curve', 'assetCurve', 'balance_history', 'balanceHistory']) {
      const points = asNumberArray(performance[key] ?? rawSummary[key] ?? summary[key]);
      if (points.length >= 2) {
        return points;
      }
    }

    const startingEquity = pickFiniteNumber(initialCapital, totalAsset);
    if (startingEquity == null || startingEquity <= 0) {
      return [];
    }

    const realizedSeries = normalizedTrades
      .filter(item => pickFiniteNumber(item.realized_pnl) != null)
      .sort((left, right) => Number(left.trade_timestamp ?? 0) - Number(right.trade_timestamp ?? 0));
    if (realizedSeries.length < 2) {
      return [];
    }

    let equity = startingEquity;
    const points = [Number(equity.toFixed(4))];
    for (const trade of realizedSeries) {
      const pnl = pickFiniteNumber(trade.realized_pnl);
      if (pnl == null) {
        continue;
      }
      equity += pnl;
      if (equity > 0) {
        points.push(Number(equity.toFixed(4)));
      }
    }
    return points;
  }

  private buildPortfolioDiagnostics(input: {
    positionCount: number;
    cashRatioPct: number | null;
    top1WeightPct: number | null;
    top3WeightPct: number | null;
    topIndustry: Record<string, unknown> | null;
    maxDrawdownPct: number | null;
    sharpeRatio: number | null;
    totalReturnPct: number | null;
  }): Record<string, unknown> {
    const alerts: Array<Record<string, unknown>> = [];
    const suggestions: string[] = [];
    let score = input.positionCount > 0 ? 100 : 78;

    const pushAlert = (alert: Record<string, unknown>, scorePenalty: number, suggestion?: string) => {
      alerts.push(alert);
      score = Math.max(0, score - scorePenalty);
      if (suggestion && !suggestions.includes(suggestion)) {
        suggestions.push(suggestion);
      }
    };

    if (input.positionCount === 0) {
      alerts.push({
        code: 'empty_portfolio',
        level: 'info',
        dimension: 'allocation',
        message: '当前账户暂无持仓，本轮无法做持仓结构和行业暴露分析。',
      });
    }

    if ((input.top1WeightPct ?? 0) >= 35) {
      pushAlert(
        {
          code: 'single_stock_concentration',
          level: (input.top1WeightPct ?? 0) >= 45 ? 'risk' : 'warning',
          dimension: 'concentration',
          message: `单只股票占总持仓约 ${Number(input.top1WeightPct ?? 0).toFixed(2)}%，集中度偏高。`,
        },
        (input.top1WeightPct ?? 0) >= 45 ? 24 : 14,
        '优先降低单票集中度，尽量把单只股票权重控制在更可承受的区间内。',
      );
    }

    if ((input.top3WeightPct ?? 0) >= 75) {
      pushAlert(
        {
          code: 'top3_concentration',
          level: 'warning',
          dimension: 'concentration',
          message: `前三大持仓合计约 ${Number(input.top3WeightPct ?? 0).toFixed(2)}%，组合分散度不足。`,
        },
        12,
        '适当分散前三大持仓，避免组合收益过度绑定少数标的。',
      );
    }

    const topIndustryWeightPct = pickFiniteNumber(input.topIndustry?.weight_pct, input.topIndustry?.invested_weight_pct);
    const topIndustryName = normalizeText(input.topIndustry?.industry_name ?? input.topIndustry?.name ?? input.topIndustry?.label);
    if (topIndustryName && topIndustryName !== '未分类' && (topIndustryWeightPct ?? 0) >= 45) {
      pushAlert(
        {
          code: 'industry_overweight',
          level: 'warning',
          dimension: 'industry',
          message: `${topIndustryName} 行业占当前持仓约 ${Number(topIndustryWeightPct ?? 0).toFixed(2)}%，需要关注行业过度集中。`,
        },
        14,
        `考虑降低 ${topIndustryName} 行业暴露，或通过增加非相关行业仓位做再平衡。`,
      );
    }

    if ((input.cashRatioPct ?? 0) < 5 && input.positionCount > 0) {
      pushAlert(
        {
          code: 'low_cash_buffer',
          level: 'warning',
          dimension: 'liquidity',
          message: `现金占总资产约 ${Number(input.cashRatioPct ?? 0).toFixed(2)}%，缓冲偏低。`,
        },
        8,
        '为组合预留一部分现金缓冲，避免回撤时被动应对。',
      );
    }

    if ((input.maxDrawdownPct ?? 0) >= 15) {
      pushAlert(
        {
          code: 'drawdown_high',
          level: 'risk',
          dimension: 'drawdown',
          message: `历史最大回撤约 ${Number(input.maxDrawdownPct ?? 0).toFixed(2)}%，风险承受压力较大。`,
        },
        18,
        '先压缩高波动仓位，并检查止损与仓位控制是否执行到位。',
      );
    }

    if (input.sharpeRatio != null && input.sharpeRatio < 0.3) {
      pushAlert(
        {
          code: 'sharpe_weak',
          level: 'warning',
          dimension: 'efficiency',
          message: `当前夏普比率约 ${input.sharpeRatio.toFixed(2)}，风险调整后收益偏弱。`,
        },
        8,
        '优先保留收益质量更稳定的仓位，减少低效率暴露。',
      );
    }

    if ((input.totalReturnPct ?? 0) <= -8) {
      pushAlert(
        {
          code: 'return_underwater',
          level: 'warning',
          dimension: 'performance',
          message: `当前累计收益率约 ${Number(input.totalReturnPct ?? 0).toFixed(2)}%，组合仍处于较明显回撤区。`,
        },
        10,
        '在回撤修复前，优先控制仓位风险，避免继续放大亏损敞口。',
      );
    }

    const healthLevel = score >= 80 ? 'healthy' : score >= 60 ? 'watch' : 'risky';
    if (!suggestions.length && input.positionCount > 0) {
      suggestions.push('当前组合结构相对平稳，继续跟踪单票仓位上限和现金缓冲即可。');
    }

    return {
      health_score: score,
      health_level: healthLevel,
      rebalancing_needed: alerts.some(item => String(item.code ?? '').includes('concentration') || item.code === 'industry_overweight'),
      alerts,
      suggestions,
    };
  }

  async getPortfolioHealth(userId: number, refresh = false): Promise<TradingPortfolioHealthPayload> {
    const snapshot = await this.resolveSnapshot(userId, { refresh });
    const summary = asRecord(snapshot.summary);
    const performance = asRecord(snapshot.performance);
    const snapshotDate = String(snapshot.snapshot_at ?? '').slice(0, 10);
    const countForDate = (items: Array<Record<string, unknown>>): number =>
      items.reduce((total, item) => (extractItemDateText(item) === snapshotDate ? total + 1 : total), 0);
    const totalAsset = pickFiniteNumber(
      summary.total_asset,
      summary.totalAsset,
      summary.total_equity,
      performance.total_asset,
      performance.totalAsset,
      performance.total_equity,
    ) ?? 0;
    const totalMarketValue = pickFiniteNumber(
      summary.market_value,
      summary.marketValue,
      summary.total_market_value,
      performance.market_value,
      performance.marketValue,
      performance.total_market_value,
    ) ?? 0;
    const availableCash = pickFiniteNumber(
      summary.cash,
      summary.available_cash,
      summary.availableCash,
      performance.cash,
      performance.available_cash,
      performance.availableCash,
    );
    const initialCapital = pickFiniteNumber(
      summary.initial_capital,
      summary.initialCapital,
      summary.initial_cash,
      summary.initialCash,
      performance.initial_capital,
      performance.initialCapital,
    );

    const positions: PortfolioHealthPositionItem[] = snapshot.positions
      .map(normalizePositionItem)
      .map((item) => {
        const marketValue = pickFiniteNumber(item.market_value) ?? 0;
        const avgCost = pickFiniteNumber(item.avg_cost);
        const quantity = Math.max(0, Math.floor(pickFiniteNumber(item.quantity) ?? 0));
        const costBasis = avgCost != null && quantity > 0 ? Number((avgCost * quantity).toFixed(4)) : null;
        const unrealizedPnl = costBasis != null ? Number((marketValue - costBasis).toFixed(4)) : null;
        const unrealizedReturnPct = unrealizedPnl != null && costBasis != null && costBasis > 0
          ? Number(((unrealizedPnl / costBasis) * 100).toFixed(4))
          : null;
        const assetWeightPct = totalAsset > 0 ? Number(((marketValue / totalAsset) * 100).toFixed(4)) : null;
        const investedWeightPct = totalMarketValue > 0 ? Number(((marketValue / totalMarketValue) * 100).toFixed(4)) : null;
        return {
          ...item,
          cost_basis: costBasis,
          unrealized_pnl: unrealizedPnl,
          unrealized_return_pct: unrealizedReturnPct,
          weight_pct: assetWeightPct,
          invested_weight_pct: investedWeightPct,
        };
      })
      .sort((left, right) => (pickFiniteNumber(right.market_value) ?? 0) - (pickFiniteNumber(left.market_value) ?? 0));

    const normalizedTrades = snapshot.trades
      .map((item) => normalizeTradeItem(asRecord(item)))
      .sort((left, right) => Number(left.trade_timestamp ?? 0) - Number(right.trade_timestamp ?? 0));

    const tradeReturns = normalizedTrades
      .map(item => pickFiniteNumber(item.return_pct))
      .filter((item): item is number => item != null)
      .map(item => item / 100);
    const winningTrades = normalizedTrades.filter(item => (pickFiniteNumber(item.realized_pnl) ?? 0) > 0).length;
    const closedTrades = normalizedTrades.filter(item => pickFiniteNumber(item.realized_pnl) != null).length;
    const winRatePct = closedTrades > 0 ? Number(((winningTrades / closedTrades) * 100).toFixed(4)) : null;

    const rawIndustryGroups = new Map<string, { industry_name: string; market_value: number; codes: Set<string>; count: number }>();
    for (const position of positions) {
      const industryName = normalizeText(position.industry_name, 64) ?? '未分类';
      const current = rawIndustryGroups.get(industryName) ?? {
        industry_name: industryName,
        market_value: 0,
        codes: new Set<string>(),
        count: 0,
      };
      current.market_value += pickFiniteNumber(position.market_value) ?? 0;
      current.count += 1;
      const code = asString(position.code);
      if (code) {
        current.codes.add(code);
      }
      rawIndustryGroups.set(industryName, current);
    }

    const industryExposure = [...rawIndustryGroups.values()]
      .map(item => ({
        industry_name: item.industry_name,
        market_value: Number(item.market_value.toFixed(4)),
        weight_pct: totalAsset > 0 ? Number(((item.market_value / totalAsset) * 100).toFixed(4)) : null,
        invested_weight_pct: totalMarketValue > 0 ? Number(((item.market_value / totalMarketValue) * 100).toFixed(4)) : null,
        stock_count: item.count,
        codes: [...item.codes],
      }))
      .sort((left, right) => (pickFiniteNumber(right.market_value) ?? 0) - (pickFiniteNumber(left.market_value) ?? 0));

    const equityPoints = this.resolvePortfolioEquitySeries(summary, performance, normalizedTrades, initialCapital, totalAsset);
    const equityReturns = deriveReturnsFromEquity(equityPoints);
    const totalReturnPct = this.resolvePortfolioMetric(summary, performance, 'total_return_pct', 'return_pct', 'profit_rate')
      ?? (initialCapital != null && initialCapital > 0 && totalAsset > 0
        ? Number((((totalAsset - initialCapital) / initialCapital) * 100).toFixed(4))
        : null);
    const totalPnl = this.resolvePortfolioMetric(summary, performance, 'pnl_total', 'total_pnl', 'profit_total');
    const dailyPnl = this.resolvePortfolioMetric(summary, performance, 'pnl_daily', 'daily_pnl', 'today_pnl');
    const maxDrawdownPct = this.resolvePortfolioMetric(summary, performance, 'max_drawdown_pct', 'drawdown_pct')
      ?? computeMaxDrawdownPctFromEquity(equityPoints);
    const sharpeRatio = this.resolvePortfolioMetric(summary, performance, 'sharpe_ratio')
      ?? computeSharpeRatio(equityReturns.length >= 2 ? equityReturns : tradeReturns, equityReturns.length >= 2 ? Math.sqrt(252) : Math.sqrt(Math.max(tradeReturns.length, 1)));
    const unrealizedPnl = Number(
      positions.reduce((sum, item) => sum + (pickFiniteNumber(item.unrealized_pnl) ?? 0), 0).toFixed(4),
    );
    const realizedPnl = totalPnl != null ? Number((totalPnl - unrealizedPnl).toFixed(4)) : null;
    const cashRatioPct = totalAsset > 0 && availableCash != null ? Number(((availableCash / totalAsset) * 100).toFixed(4)) : null;
    const investedRatioPct = totalAsset > 0 ? Number(((totalMarketValue / totalAsset) * 100).toFixed(4)) : null;
    const top1WeightPct = pickFiniteNumber(positions[0]?.invested_weight_pct);
    const top3MarketValue = positions
      .slice(0, 3)
      .reduce((sum, item) => sum + (pickFiniteNumber(item.market_value) ?? 0), 0);
    const top3WeightPct = totalMarketValue > 0 ? Number(((top3MarketValue / totalMarketValue) * 100).toFixed(4)) : null;
    const diagnostics = this.buildPortfolioDiagnostics({
      positionCount: positions.length,
      cashRatioPct,
      top1WeightPct,
      top3WeightPct,
      topIndustry: industryExposure[0] ?? null,
      maxDrawdownPct,
      sharpeRatio,
      totalReturnPct,
    });

    return {
      broker_account_id: snapshot.account.broker_account_id,
      broker_code: snapshot.account.broker_code,
      provider_code: snapshot.account.provider_code,
      provider_name: snapshot.account.provider_name,
      account_uid: snapshot.account.account_uid,
      account_display_name: snapshot.account.account_display_name,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      summary,
      positions,
      available_cash: availableCash,
      total_market_value: totalMarketValue,
      total_asset: totalAsset,
      order_count: snapshot.orders.length,
      trade_count: snapshot.trades.length,
      today_order_count: countForDate(snapshot.orders),
      today_trade_count: countForDate(snapshot.trades),
      performance,
      recent_trades: normalizedTrades.slice(-10).reverse(),
      metrics: {
        total_return_pct: totalReturnPct,
        total_pnl: totalPnl,
        daily_pnl: dailyPnl,
        realized_pnl: realizedPnl,
        unrealized_pnl: unrealizedPnl,
        max_drawdown_pct: maxDrawdownPct,
        sharpe_ratio: sharpeRatio,
        win_rate_pct: winRatePct,
        cash_ratio_pct: cashRatioPct,
        invested_ratio_pct: investedRatioPct,
        top1_position_pct: top1WeightPct,
        top3_position_pct: top3WeightPct,
        position_count: positions.length,
      },
      exposures: {
        by_industry: industryExposure,
        by_stock: positions.slice(0, 5).map(item => ({
          code: item.code,
          stock_name: item.stock_name,
          market_value: item.market_value,
          weight_pct: item.weight_pct,
          invested_weight_pct: item.invested_weight_pct,
        })),
      },
      diagnostics,
    };
  }

  // 自动下单幂等依赖 analysisAutoOrder 表，命中已提交记录时直接复用，避免同一任务重复打单。
  private async findExistingIdempotentOrder(userId: number, idempotencyKey: string): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.analysisAutoOrder.findFirst({
      where: {
        userId,
        idempotencyKey,
      },
      orderBy: {
        id: 'desc',
      },
    });
    if (!row) {
      return null;
    }
    if (row.status !== 'submitted') {
      return null;
    }
    return {
      provider_order_id: row.providerOrderId,
      provider_status: row.providerStatus,
      submitted_at: row.updatedAt.toISOString(),
      order_id: row.providerOrderId ?? null,
      status: row.providerStatus ?? 'submitted',
    };
  }

  // 审计单独落 analysisAutoOrder，后续不论排查自动单、手动单还是幂等冲突都能回放。
  private async writeOrderAudit(input: {
    taskId: string;
    userId: number;
    brokerAccountId: number;
    stockCode: string;
    direction: 'buy' | 'sell';
    type: 'limit' | 'market';
    price: number;
    quantity: number;
    idempotencyKey: string;
    status: 'submitted' | 'failed';
    providerOrderId?: string | null;
    providerStatus?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.prisma.analysisAutoOrder.upsert({
      where: {
        taskId_stockCode: {
          taskId: input.taskId,
          stockCode: input.stockCode,
        },
      },
      update: {
        status: input.status,
        providerOrderId: input.providerOrderId ?? null,
        providerStatus: input.providerStatus ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        idempotencyKey: input.idempotencyKey,
      },
      create: {
        taskId: input.taskId,
        userId: input.userId,
        brokerAccountId: input.brokerAccountId,
        stockCode: input.stockCode,
        direction: input.direction,
        type: input.type,
        price: input.price,
        quantity: input.quantity,
        status: input.status,
        providerOrderId: input.providerOrderId ?? null,
        providerStatus: input.providerStatus ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    });
  }

  async getAccountSummary(userId: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, { refresh });
    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      summary: snapshot.summary,
    };
  }

  async getPositions(userId: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, { refresh });
    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      total: snapshot.positions.length,
      items: snapshot.positions,
    };
  }

  async getOrders(userId: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, { refresh });
    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      total: snapshot.orders.length,
      items: snapshot.orders,
    };
  }

  async getTrades(userId: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, { refresh });
    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      total: snapshot.trades.length,
      items: snapshot.trades,
    };
  }

  async getPerformance(userId: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, { refresh });
    const performance = asRecord(snapshot.performance);

    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      performance,
    };
  }

  // 增资属于模拟盘专属能力，不同 adapter 不一定支持，所以先做能力探测再调用上游。
  async addFunds(
    userId: number,
    input: {
      amount: number;
      note?: string;
    },
  ): Promise<Record<string, unknown>> {
    const access = await this.brokerAccountsService.resolveSimulationAccess(userId, { requireVerified: true });
    const adapter = this.brokerRegistry.getAdapter(access.brokerCode);

    if (!adapter.addFunds) {
      throw createServiceError('NOT_SUPPORTED', '当前券商不支持增加资金功能');
    }

    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw createServiceError('VALIDATION_ERROR', 'amount 必须大于 0');
    }

    const normalizedAmount = Number(amount.toFixed(2));
    const note = normalizeText(input.note, 200);

    try {
      const result = await adapter.addFunds(access, {
        amount: normalizedAmount,
        ...(note ? { note } : {}),
      });

      const change = asRecord(result.fund_change ?? result.fundChange);
      const pickNumber = (...values: unknown[]): number | null => {
        for (const value of values) {
          const parsed = asNumber(value);
          if (parsed != null) {
            return parsed;
          }
        }
        return null;
      };

      const snapshot = await this.fetchAndCache(userId);
      return {
        ...snapshot.account,
        snapshot_at: snapshot.snapshot_at,
        data_source: snapshot.data_source,
        fund_change: {
          amount: normalizedAmount,
          note: note ?? null,
          cash_before: pickNumber(change.cash_before, change.cashBefore, result.cash_before, result.cashBefore),
          cash_after: pickNumber(change.cash_after, change.cashAfter, result.cash_after, result.cashAfter),
          initial_capital_before: pickNumber(
            change.initial_capital_before,
            change.initialCapitalBefore,
            result.initial_capital_before,
            result.initialCapitalBefore,
          ),
          initial_capital_after: pickNumber(
            change.initial_capital_after,
            change.initialCapitalAfter,
            result.initial_capital_after,
            result.initialCapitalAfter,
          ),
        },
        summary: snapshot.summary,
        performance: snapshot.performance,
      };
    } catch (error: unknown) {
      if (isBrokerGatewayError(error)) {
        throw createServiceError('UPSTREAM_ERROR', error.message, error.statusCode);
      }
      throw error;
    }
  }

  // 下单前先查幂等，再统一写订单审计，确保手动/API/自动补单走同一套留痕口径。
  async placeOrder(
    userId: number,
    order: {
      stock_code: string;
      stock_name?: string;
      direction: 'buy' | 'sell';
      type: 'limit' | 'market';
      price: number;
      quantity: number;
      idempotency_key?: string;
      source_task_id?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const access = await this.brokerAccountsService.resolveSimulationAccess(userId, { requireVerified: true });
    const adapter = this.brokerRegistry.getAdapter(access.brokerCode);

    if (!adapter.placeOrder) {
      throw createServiceError('NOT_SUPPORTED', '当前券商不支持下单功能');
    }

    const idempotencyKey = this.normalizeIdempotencyKey(order.idempotency_key)
      ?? `auto:${order.source_task_id ?? 'manual'}:${order.stock_code}:${order.direction}`;
    const existing = await this.findExistingIdempotentOrder(userId, idempotencyKey);
    if (existing) {
      return {
        ...this.toPublicAccountMeta(access),
        order: existing,
      };
    }

    const orderId = `ord_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    const orderRequest: OrderRequest = {
      orderId,
      stockCode: order.stock_code,
      stockName: order.stock_name,
      direction: order.direction,
      type: order.type,
      price: order.price,
      quantity: order.quantity,
    };

    try {
      const result = await adapter.placeOrder(access, orderRequest, {
        idempotencyKey,
        payload: order.payload ?? null,
      });
      const providerOrderId = resolveProviderOrderId(result);
      const providerStatus = resolveProviderStatus(result);
      const submittedAt = resolveSubmittedAt(result);
      const auditStatus = resolveAuditStatus({
        ...result,
        provider_status: providerStatus,
      });
      const rejectedMessage = normalizeText(result.message ?? result.error_message ?? result.errorMessage, 500);
      const rejectedCode = normalizeText(result.error_code ?? result.errorCode ?? result.error, 64);

      await this.writeOrderAudit({
        taskId: normalizeText(order.source_task_id, 64) ?? `manual-${idempotencyKey}`,
        userId,
        brokerAccountId: access.brokerAccountId,
        stockCode: order.stock_code,
        direction: order.direction,
        type: order.type,
        price: order.price,
        quantity: order.quantity,
        idempotencyKey,
        status: auditStatus,
        providerOrderId,
        providerStatus,
        errorCode: auditStatus === 'failed' ? rejectedCode : null,
        errorMessage: auditStatus === 'failed' ? rejectedMessage : null,
      });

      return {
        ...this.toPublicAccountMeta(access),
        order: {
          ...result,
          provider_order_id: providerOrderId,
          provider_status: providerStatus,
          submitted_at: submittedAt,
        },
      };
    } catch (error: unknown) {
      if (isBrokerGatewayError(error)) {
        await this.writeOrderAudit({
          taskId: normalizeText(order.source_task_id, 64) ?? `manual-${idempotencyKey}`,
          userId,
          brokerAccountId: access.brokerAccountId,
          stockCode: order.stock_code,
          direction: order.direction,
          type: order.type,
          price: order.price,
          quantity: order.quantity,
          idempotencyKey,
          status: 'failed',
          errorCode: error.code,
          errorMessage: error.message,
        });
        throw createServiceError('UPSTREAM_ERROR', error.message, error.statusCode);
      }
      throw error;
    }
  }

  // 撤单不做额外缓存，直接走 adapter，保持返回结果与上游模拟引擎状态一致。
  async cancelOrder(userId: number, orderId: string, idempotencyKeyRaw?: string): Promise<Record<string, unknown>> {
    const access = await this.brokerAccountsService.resolveSimulationAccess(userId, { requireVerified: true });
    const adapter = this.brokerRegistry.getAdapter(access.brokerCode);

    if (!adapter.cancelOrder) {
      throw createServiceError('NOT_SUPPORTED', '当前券商不支持撤单功能');
    }

    const idempotencyKey = this.normalizeIdempotencyKey(idempotencyKeyRaw);

    try {
      const result = await adapter.cancelOrder(access, orderId, {
        idempotencyKey,
      });
      const providerOrderId = resolveProviderOrderId(result) ?? normalizeText(orderId);
      const providerStatus = resolveProviderStatus(result) ?? 'cancelled';
      const cancelledAt = normalizeText(result.cancelled_at ?? result.cancelledAt, 64) ?? new Date().toISOString();

      return {
        ...this.toPublicAccountMeta(access),
        order: {
          ...result,
          provider_order_id: providerOrderId,
          provider_status: providerStatus,
          cancelled_at: cancelledAt,
        },
      };
    } catch (error: unknown) {
      if (isBrokerGatewayError(error)) {
        throw createServiceError('UPSTREAM_ERROR', error.message, error.statusCode);
      }
      throw error;
    }
  }
}
