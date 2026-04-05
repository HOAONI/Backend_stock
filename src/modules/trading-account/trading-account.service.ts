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

function normalizePositionItem(item: Record<string, unknown>): Record<string, unknown> {
  const quantity = asNumber(item.quantity ?? item.qty ?? item.volume) ?? 0;
  const availableQty = asNumber(item.available_qty ?? item.availableQty ?? item.available ?? quantity) ?? quantity;
  const avgCost = asNumber(item.avg_cost ?? item.avgCost ?? item.cost_price ?? item.costPrice);
  const lastPrice = asNumber(item.last_price ?? item.lastPrice ?? item.price);
  const marketValue = asNumber(item.market_value ?? item.marketValue);

  return {
    ...item,
    code: String(item.code ?? item.stock_code ?? item.stockCode ?? item.symbol ?? '').trim(),
    stock_name: String(item.stock_name ?? item.stockName ?? item.name ?? '').trim() || null,
    quantity: Math.max(0, Math.floor(quantity)),
    available_qty: Math.max(0, Math.floor(Math.min(availableQty, quantity))),
    avg_cost: avgCost,
    last_price: lastPrice,
    market_value: marketValue,
  };
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
