/** 清理历史券商接入遗留数据，避免旧结构继续污染当前模拟盘链路。 */

import 'reflect-metadata';

import { PrismaService } from '@/common/database/prisma.service';

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    const legacyRows = await prisma.userBrokerAccount.findMany({
      where: {
        OR: [
          { providerCode: { in: ['gmtrade', 'default'] } },
          { brokerCode: { in: ['cn_sim_gateway', 'simulation', 'futu'] } },
        ],
      },
      select: { id: true },
    });

    const legacyIds = legacyRows.map(item => item.id);
    if (legacyIds.length === 0) {
      console.log('[cleanup-legacy-broker-data] no legacy rows');
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.userBrokerSnapshotCache.deleteMany({ where: { brokerAccountId: { in: legacyIds } } });
      await tx.agentCredentialTicket.deleteMany({ where: { brokerAccountId: { in: legacyIds } } });
      await tx.agentExecutionEvent.deleteMany({ where: { brokerAccountId: { in: legacyIds } } });
      await tx.analysisAutoOrder.deleteMany({ where: { brokerAccountId: { in: legacyIds } } });
      await tx.simulationTrade.deleteMany({ where: { brokerAccountId: { in: legacyIds } } });
      await tx.simulationOrder.deleteMany({ where: { brokerAccountId: { in: legacyIds } } });
      await tx.simulationPosition.deleteMany({ where: { brokerAccountId: { in: legacyIds } } });
      await tx.userBrokerAccount.deleteMany({ where: { id: { in: legacyIds } } });
    });

    console.log(`[cleanup-legacy-broker-data] deleted ${legacyIds.length} legacy broker account(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('[cleanup-legacy-broker-data] failed:', error);
    process.exit(1);
  });
