import { Injectable } from '@nestjs/common';

import { PrismaService } from '@/common/database/prisma.service';

type WorkerMode = 'embedded' | 'external';

interface HeartbeatUpdateInput {
  workerName: string;
  workerMode: WorkerMode;
  lastTaskId?: string | null;
  lastError?: string | null;
}

function asString(value: unknown): string {
  return String(value ?? '').trim();
}

@Injectable()
export class SchedulerHeartbeatService {
  constructor(private readonly prisma: PrismaService) {}

  async updateWorkerHeartbeat(input: HeartbeatUpdateInput): Promise<void> {
    await this.prisma.schedulerWorkerHeartbeat.upsert({
      where: { workerName: input.workerName },
      update: {
        workerMode: input.workerMode,
        lastSeenAt: new Date(),
        lastTaskId: asString(input.lastTaskId) || null,
        lastError: asString(input.lastError).slice(0, 500) || null,
      },
      create: {
        workerName: input.workerName,
        workerMode: input.workerMode,
        lastSeenAt: new Date(),
        lastTaskId: asString(input.lastTaskId) || null,
        lastError: asString(input.lastError).slice(0, 500) || null,
      },
    });
  }
}
