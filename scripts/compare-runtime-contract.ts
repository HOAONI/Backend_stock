/** 比对运行时数据库结构与预期契约，提前发现环境漂移或字段缺失。 */

import * as fs from 'node:fs';
import * as path from 'node:path';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface ContractCase {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  route: string;
  body?: unknown;
}

interface CompareResult {
  name: string;
  method: string;
  route: string;
  oldStatus: number;
  newStatus: number;
  oldKeys: string[];
  newKeys: string[];
  missingInNew: string[];
  status: CheckStatus;
  notes: string;
}

const DEFAULT_OLD_BASE = 'http://127.0.0.1:8000';
const DEFAULT_NEW_BASE = 'http://127.0.0.1:8002';
const DEFAULT_REPORT = path.resolve(process.cwd(), 'docs/CONTRACT_REPORT.md');

const CASES: ContractCase[] = [
  { name: 'health', method: 'GET', route: '/api/health' },
  { name: 'auth-status', method: 'GET', route: '/api/v1/auth/status' },
  { name: 'analysis-tasks', method: 'GET', route: '/api/v1/analysis/tasks?limit=5' },
  { name: 'history-list', method: 'GET', route: '/api/v1/history?page=1&limit=5' },
  { name: 'backtest-results', method: 'GET', route: '/api/v1/backtest/results?page=1&limit=5' },
  { name: 'system-config', method: 'GET', route: '/api/v1/system/config?include_schema=false' },
  { name: 'system-schema', method: 'GET', route: '/api/v1/system/config/schema' },
  { name: 'stocks-extract-no-file', method: 'POST', route: '/api/v1/stocks/extract-from-image' },
  { name: 'stocks-history-invalid-period', method: 'GET', route: '/api/v1/stocks/600519/history?period=weekly&days=30' },
];

function normalizePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (record.detail && typeof record.detail === 'object') {
    return record.detail;
  }
  return payload;
}

function topLevelKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return [];
  }
  return Object.keys(payload as Record<string, unknown>).sort();
}

async function request(baseUrl: string, item: ContractCase): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(`${baseUrl}${item.route}`, {
    method: item.method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: item.body == null ? undefined : JSON.stringify(item.body),
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return {
    status: response.status,
    payload: normalizePayload(payload),
  };
}

function classify(oldStatus: number, newStatus: number, missingInNew: string[]): { status: CheckStatus; notes: string } {
  if (oldStatus !== newStatus) {
    return {
      status: 'fail',
      notes: `status mismatch: old=${oldStatus}, new=${newStatus}`,
    };
  }
  if (missingInNew.length > 0) {
    return {
      status: 'warn',
      notes: `new payload misses keys: ${missingInNew.join(', ')}`,
    };
  }
  return {
    status: 'pass',
    notes: 'status and top-level keys compatible',
  };
}

function renderReport(
  oldBase: string,
  newBase: string,
  results: CompareResult[],
): string {
  const now = new Date().toISOString();
  const passCount = results.filter((r) => r.status === 'pass').length;
  const warnCount = results.filter((r) => r.status === 'warn').length;
  const failCount = results.filter((r) => r.status === 'fail').length;

  const lines: string[] = [];
  lines.push('# Contract Comparison Report');
  lines.push('');
  lines.push(`- Generated at: ${now}`);
  lines.push(`- Old backend: \`${oldBase}\``);
  lines.push(`- New backend: \`${newBase}\``);
  lines.push(`- Summary: pass=${passCount}, warn=${warnCount}, fail=${failCount}`);
  lines.push('');
  lines.push('| Case | Method | Route | Old Status | New Status | Result | Notes |');
  lines.push('| --- | --- | --- | ---: | ---: | --- | --- |');
  for (const item of results) {
    lines.push(
      `| ${item.name} | ${item.method} | \`${item.route}\` | ${item.oldStatus} | ${item.newStatus} | ${item.status} | ${item.notes} |`,
    );
  }
  lines.push('');
  lines.push('## Key Diff Details');
  lines.push('');
  for (const item of results) {
    lines.push(`### ${item.name}`);
    lines.push('');
    lines.push(`- Old keys: ${item.oldKeys.length > 0 ? `\`${item.oldKeys.join('`, `')}\`` : '(none)'}`);
    lines.push(`- New keys: ${item.newKeys.length > 0 ? `\`${item.newKeys.join('`, `')}\`` : '(none)'}`);
    lines.push(
      `- Missing in new: ${item.missingInNew.length > 0 ? `\`${item.missingInNew.join('`, `')}\`` : '(none)'}`,
    );
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const oldBase = process.argv[2] || DEFAULT_OLD_BASE;
  const newBase = process.argv[3] || DEFAULT_NEW_BASE;
  const reportFile = path.resolve(process.argv[4] || DEFAULT_REPORT);

  const results: CompareResult[] = [];
  for (const item of CASES) {
    const [oldResp, newResp] = await Promise.all([request(oldBase, item), request(newBase, item)]);
    const oldKeys = topLevelKeys(oldResp.payload);
    const newKeys = topLevelKeys(newResp.payload);
    const missingInNew = oldKeys.filter((key) => !newKeys.includes(key));
    const classification = classify(oldResp.status, newResp.status, missingInNew);

    results.push({
      name: item.name,
      method: item.method,
      route: item.route,
      oldStatus: oldResp.status,
      newStatus: newResp.status,
      oldKeys,
      newKeys,
      missingInNew,
      status: classification.status,
      notes: classification.notes,
    });
  }

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, renderReport(oldBase, newBase, results), 'utf8');

  const failCount = results.filter((r) => r.status === 'fail').length;
  const warnCount = results.filter((r) => r.status === 'warn').length;
  console.log(`Contract report written: ${reportFile}`);
  console.log(`pass=${results.length - failCount - warnCount}, warn=${warnCount}, fail=${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
