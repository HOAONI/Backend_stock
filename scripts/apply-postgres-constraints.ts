import * as fs from 'node:fs';
import * as path from 'node:path';

import * as dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

function setupEnv(): void {
  const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
  }
}

async function main(): Promise<void> {
  setupEnv();
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(`
      DROP INDEX IF EXISTS uix_analysis_tasks_active_stock;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS uix_analysis_tasks_active_owner_stock
      ON "analysis_tasks" ("owner_user_id", "stock_code")
      WHERE "status" IN ('pending', 'processing')
    `);
    console.log('PostgreSQL supplemental constraints applied.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
