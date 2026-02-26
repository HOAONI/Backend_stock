import { Injectable } from '@nestjs/common';
import { UserBrokerSnapshotCache } from '@prisma/client';

import { BrokerAdapterRegistry } from '@/common/broker/broker-adapter.registry';
import { isBrokerGatewayError } from '@/common/broker/broker.errors';
import { OrderRequest } from '@/common/broker/broker.types';
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

interface SnapshotPayload {
  account: {
    broker_account_id: number;
    broker_code: string;
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
        environment: 'paper',
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

  private async fetchAndCache(userId: number, brokerAccountId?: number): Promise<SnapshotPayload> {
    const access = await this.brokerAccountsService.resolveAccess(userId, brokerAccountId, { requireVerified: true });
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
        account: {
          broker_account_id: access.brokerAccountId,
          broker_code: access.brokerCode,
          environment: access.environment,
          account_uid: access.accountUid,
          account_display_name: access.accountDisplayName,
        },
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
    brokerAccountId?: number,
    options?: { refresh?: boolean },
  ): Promise<SnapshotPayload> {
    const access = await this.brokerAccountsService.resolveAccess(userId, brokerAccountId, { requireVerified: true });

    const cached = await this.loadCachedSnapshot(userId, access.brokerAccountId);
    const now = Date.now();
    const isCacheFresh = cached ? cached.expiresAt.getTime() > now : false;
    if (!options?.refresh && cached && isCacheFresh) {
      const parsed = this.parseCacheRow(cached, 'cache');
      parsed.account = {
        broker_account_id: access.brokerAccountId,
        broker_code: access.brokerCode,
        environment: access.environment,
        account_uid: access.accountUid,
        account_display_name: access.accountDisplayName,
      };
      return parsed;
    }

    return await this.fetchAndCache(userId, access.brokerAccountId);
  }

  async getAccountSummary(userId: number, brokerAccountId?: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, brokerAccountId, { refresh });
    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      summary: snapshot.summary,
    };
  }

  async getPositions(userId: number, brokerAccountId?: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, brokerAccountId, { refresh });
    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      total: snapshot.positions.length,
      items: snapshot.positions,
    };
  }

  async getOrders(userId: number, brokerAccountId?: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, brokerAccountId, { refresh });
    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      total: snapshot.orders.length,
      items: snapshot.orders,
    };
  }

  async getTrades(userId: number, brokerAccountId?: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, brokerAccountId, { refresh });
    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      total: snapshot.trades.length,
      items: snapshot.trades,
    };
  }

  async getPerformance(userId: number, brokerAccountId?: number, refresh = false): Promise<Record<string, unknown>> {
    const snapshot = await this.resolveSnapshot(userId, brokerAccountId, { refresh });
    const performance = asRecord(snapshot.performance);

    return {
      ...snapshot.account,
      snapshot_at: snapshot.snapshot_at,
      data_source: snapshot.data_source,
      performance,
    };
  }

  async placeOrder(
    userId: number,
    brokerAccountId: number,
    order: { stock_code: string; stock_name?: string; direction: 'buy' | 'sell'; type: 'limit' | 'market'; price: number; quantity: number },
  ): Promise<Record<string, unknown>> {
    const access = await this.brokerAccountsService.resolveAccess(userId, brokerAccountId, { requireVerified: true });
    const adapter = this.brokerRegistry.getAdapter(access.brokerCode);

    if (!adapter.placeOrder) {
      throw createServiceError('NOT_SUPPORTED', '当前券商不支持下单功能');
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
      const result = await adapter.placeOrder(access, orderRequest);
      return {
        ...access,
        order: result,
      };
    } catch (error: unknown) {
      if (isBrokerGatewayError(error)) {
        throw createServiceError('UPSTREAM_ERROR', error.message, error.statusCode);
      }
      throw error;
    }
  }

  async cancelOrder(userId: number, brokerAccountId: number, orderId: string): Promise<Record<string, unknown>> {
    const access = await this.brokerAccountsService.resolveAccess(userId, brokerAccountId, { requireVerified: true });
    const adapter = this.brokerRegistry.getAdapter(access.brokerCode);

    if (!adapter.cancelOrder) {
      throw createServiceError('NOT_SUPPORTED', '当前券商不支持撤单功能');
    }

    try {
      const result = await adapter.cancelOrder(access, orderId);
      return {
        ...access,
        order: result,
      };
    } catch (error: unknown) {
      if (isBrokerGatewayError(error)) {
        throw createServiceError('UPSTREAM_ERROR', error.message, error.statusCode);
      }
      throw error;
    }
  }
}
