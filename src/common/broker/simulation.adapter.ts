import { Injectable } from '@nestjs/common';
import {
  BrokerAccessContext,
  BrokerAdapter,
  OrderRequest,
} from './broker.types';
import { PrismaService } from '@/common/database/prisma.service';

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function generateTradeId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

@Injectable()
export class SimulationAdapter implements BrokerAdapter {
  readonly brokerCode = 'simulation';

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  private async getInitialCapital(userId: number): Promise<number> {
    const profile = await this.prisma.adminUserProfile.findUnique({
      where: { userId },
    });
    return profile?.simulationInitialCapital ?? 100000;
  }

  private async calculateAccountSummary(
    userId: number,
    brokerAccountId: number,
    initialCapital: number,
  ): Promise<Record<string, unknown>> {
    const positions = await this.prisma.simulationPosition.findMany({
      where: { userId, brokerAccountId },
    });

    const orders = await this.prisma.simulationOrder.findMany({
      where: { userId, brokerAccountId, status: { in: ['pending', 'partial_filled'] } },
    });

    const trades = await this.prisma.simulationTrade.findMany({
      where: { userId, brokerAccountId },
    });

    const totalMarketValue = positions.reduce((sum, p) => sum + asNumber(p.marketValue), 0);

    const totalBuyAmount = trades
      .filter((t) => t.direction === 'buy')
      .reduce((sum, t) => sum + asNumber(t.amount), 0);
    const totalSellAmount = trades
      .filter((t) => t.direction === 'sell')
      .reduce((sum, t) => sum + asNumber(t.amount), 0);
    const totalFee = trades.reduce((sum, t) => sum + asNumber(t.fee), 0);

    const pendingBuyValue = orders
      .filter((o) => o.direction === 'buy' && o.status === 'pending')
      .reduce((sum, o) => sum + asNumber(o.price) * asNumber(o.quantity), 0);

    const availableCash = initialCapital - totalBuyAmount + totalSellAmount - totalFee - pendingBuyValue;
    const totalAsset = availableCash + totalMarketValue;
    const pnlTotal = totalAsset - initialCapital;

    return {
      total_asset: totalAsset,
      cash: availableCash,
      market_value: totalMarketValue,
      pnl_total: pnlTotal,
      return_pct: initialCapital > 0 ? (pnlTotal / initialCapital) * 100 : 0,
      initial_capital: initialCapital,
      total_buy_amount: totalBuyAmount,
      total_sell_amount: totalSellAmount,
      total_fee: totalFee,
      position_count: positions.length,
      order_count: orders.length,
    };
  }

  async verify(context: BrokerAccessContext): Promise<Record<string, unknown>> {
    const initialCapital = await this.getInitialCapital(context.userId);

    return {
      verified: true,
      broker_code: this.brokerCode,
      environment: context.environment,
      account_uid: context.accountUid,
      initial_capital: initialCapital,
      message: '模拟账户验证成功',
    };
  }

  async getAccountSummary(context: BrokerAccessContext): Promise<Record<string, unknown>> {
    const initialCapital = await this.getInitialCapital(context.userId);
    return this.calculateAccountSummary(
      context.userId,
      context.brokerAccountId,
      initialCapital,
    );
  }

  async getPositions(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>> {
    const positions = await this.prisma.simulationPosition.findMany({
      where: {
        userId: context.userId,
        brokerAccountId: context.brokerAccountId,
        quantity: { gt: 0 },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return positions.map((p) => ({
      stock_code: p.stockCode,
      stock_name: p.stockName,
      quantity: p.quantity,
      cost_basis: p.costBasis,
      avg_cost: p.avgCost,
      market_value: p.marketValue,
      unrealized_pnl: p.unrealizedPnl,
    }));
  }

  async getOrders(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>> {
    const orders = await this.prisma.simulationOrder.findMany({
      where: {
        userId: context.userId,
        brokerAccountId: context.brokerAccountId,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return orders.map((o) => ({
      order_id: o.orderId,
      stock_code: o.stockCode,
      stock_name: o.stockName,
      direction: o.direction,
      type: o.type,
      price: o.price,
      quantity: o.quantity,
      filled_quantity: o.filledQuantity,
      filled_price: o.filledPrice,
      status: o.status,
      created_at: o.createdAt.toISOString(),
      updated_at: o.updatedAt.toISOString(),
    }));
  }

  async getTrades(context: BrokerAccessContext): Promise<Array<Record<string, unknown>>> {
    const trades = await this.prisma.simulationTrade.findMany({
      where: {
        userId: context.userId,
        brokerAccountId: context.brokerAccountId,
      },
      orderBy: { tradedAt: 'desc' },
      take: 100,
    });

    return trades.map((t) => ({
      trade_id: t.tradeId,
      order_id: t.orderId,
      stock_code: t.stockCode,
      stock_name: t.stockName,
      direction: t.direction,
      price: t.price,
      quantity: t.quantity,
      amount: t.amount,
      fee: t.fee,
      traded_at: t.tradedAt.toISOString(),
    }));
  }

  async placeOrder(context: BrokerAccessContext, order: OrderRequest): Promise<Record<string, unknown>> {
    const initialCapital = await this.getInitialCapital(context.userId);
    const summary = await this.calculateAccountSummary(
      context.userId,
      context.brokerAccountId,
      initialCapital,
    );
    const availableCash = asNumber(summary.cash);

    if (order.direction === 'buy') {
      const orderValue = order.price * order.quantity;
      if (orderValue > availableCash) {
        await this.prisma.simulationOrder.create({
          data: {
            userId: context.userId,
            brokerAccountId: context.brokerAccountId,
            orderId: order.orderId,
            stockCode: order.stockCode,
            stockName: order.stockName || '',
            direction: 'buy',
            type: order.type,
            price: order.price,
            quantity: order.quantity,
            status: 'cancelled',
            errorMessage: '可用资金不足',
          },
        });

        return {
          orderId: order.orderId,
          status: 'rejected',
          filledQuantity: 0,
          filledPrice: null,
          message: '可用资金不足',
        };
      }
    } else {
      const position = await this.prisma.simulationPosition.findFirst({
        where: {
          userId: context.userId,
          brokerAccountId: context.brokerAccountId,
          stockCode: order.stockCode,
        },
      });

      if (!position || position.quantity < order.quantity) {
        await this.prisma.simulationOrder.create({
          data: {
            userId: context.userId,
            brokerAccountId: context.brokerAccountId,
            orderId: order.orderId,
            stockCode: order.stockCode,
            stockName: order.stockName || '',
            direction: 'sell',
            type: order.type,
            price: order.price,
            quantity: order.quantity,
            status: 'cancelled',
            errorMessage: '持仓不足',
          },
        });

        return {
          orderId: order.orderId,
          status: 'rejected',
          filledQuantity: 0,
          filledPrice: null,
          message: '持仓不足',
        };
      }
    }

    const executedPrice = order.type === 'market'
      ? order.price
      : order.price;
    const executedQuantity = order.quantity;
    const amount = executedPrice * executedQuantity;
    const fee = amount * 0.0003;

    await this.prisma.$transaction(async (tx) => {
      await tx.simulationOrder.create({
        data: {
          userId: context.userId,
          brokerAccountId: context.brokerAccountId,
          orderId: order.orderId,
          stockCode: order.stockCode,
          stockName: order.stockName || '',
          direction: order.direction,
          type: order.type,
          price: order.price,
          quantity: order.quantity,
          filledQuantity: executedQuantity,
          filledPrice: executedPrice,
          status: 'filled',
        },
      });

      await tx.simulationTrade.create({
        data: {
          userId: context.userId,
          brokerAccountId: context.brokerAccountId,
          tradeId: generateTradeId(),
          orderId: order.orderId,
          stockCode: order.stockCode,
          stockName: order.stockName || '',
          direction: order.direction,
          price: executedPrice,
          quantity: executedQuantity,
          amount: amount,
          fee: fee,
        },
      });

      if (order.direction === 'buy') {
        const existing = await tx.simulationPosition.findFirst({
          where: {
            userId: context.userId,
            brokerAccountId: context.brokerAccountId,
            stockCode: order.stockCode,
          },
        });

        if (existing) {
          const newQuantity = existing.quantity + executedQuantity;
          const newCostBasis = existing.costBasis + amount + fee;
          const newAvgCost = newQuantity > 0 ? newCostBasis / newQuantity : 0;

          await tx.simulationPosition.update({
            where: { id: existing.id },
            data: {
              quantity: newQuantity,
              costBasis: newCostBasis,
              avgCost: newAvgCost,
              updatedAt: new Date(),
            },
          });
        } else {
          await tx.simulationPosition.create({
            data: {
              userId: context.userId,
              brokerAccountId: context.brokerAccountId,
              stockCode: order.stockCode,
              stockName: order.stockName || '',
              quantity: executedQuantity,
              costBasis: amount + fee,
              avgCost: executedPrice + fee / executedQuantity,
              marketValue: amount,
              unrealizedPnl: 0,
            },
          });
        }
      } else {
        const existing = await tx.simulationPosition.findFirst({
          where: {
            userId: context.userId,
            brokerAccountId: context.brokerAccountId,
            stockCode: order.stockCode,
          },
        });

        if (existing) {
          const newQuantity = existing.quantity - executedQuantity;
          const remainingCost = existing.avgCost * newQuantity;

          if (newQuantity <= 0) {
            await tx.simulationPosition.delete({
              where: { id: existing.id },
            });
          } else {
            await tx.simulationPosition.update({
              where: { id: existing.id },
              data: {
                quantity: newQuantity,
                costBasis: remainingCost,
                avgCost: existing.avgCost,
                updatedAt: new Date(),
              },
            });
          }
        }
      }
    });

    return {
      orderId: order.orderId,
      status: 'filled',
      filledQuantity: executedQuantity,
      filledPrice: executedPrice,
      message: '订单成交',
    };
  }

  async cancelOrder(context: BrokerAccessContext, orderId: string): Promise<Record<string, unknown>> {
    const order = await this.prisma.simulationOrder.findFirst({
      where: {
        userId: context.userId,
        brokerAccountId: context.brokerAccountId,
        orderId,
      },
    });

    if (!order) {
      return {
        orderId,
        status: 'rejected',
        filledQuantity: 0,
        filledPrice: null,
        message: '订单不存在',
      };
    }

    if (order.status !== 'pending' && order.status !== 'partial_filled') {
      return {
        orderId,
        status: 'rejected',
        filledQuantity: order.filledQuantity,
        filledPrice: order.filledPrice,
        message: `订单状态不允许取消，当前状态: ${order.status}`,
      };
    }

    await this.prisma.simulationOrder.update({
      where: { id: order.id },
      data: {
        status: 'cancelled',
        updatedAt: new Date(),
      },
    });

    return {
      orderId,
      status: 'cancelled',
      filledQuantity: order.filledQuantity,
      filledPrice: order.filledPrice,
      message: '订单已取消',
    };
  }
}
