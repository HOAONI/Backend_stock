import { Prisma } from '@prisma/client';

import type { AgentRunPayload } from '@/common/agent/agent.types';

export interface AnalysisNewsItem {
  title: string;
  snippet: string;
  url: string;
  source: string | null;
  publishedDate: Date | null;
  provider: string | null;
  dimension: string | null;
  query: string | null;
}

export interface ExtractedAnalysisNews {
  items: AnalysisNewsItem[];
  newsContent: string | null;
}

export interface NormalizedAnalysisNewsItem extends AnalysisNewsItem {
  ownerUserId: number;
  queryId: string;
  code: string;
  name: string;
  querySource: string;
  requesterPlatform: string;
  requesterUserId: string;
  requesterQuery: string | null;
}

interface PersistAnalysisNewsClient {
  newsIntel: {
    findUnique(args: { where: { url: string } }): Promise<any>;
    update(args: { where: { url: string }, data: Prisma.NewsIntelUncheckedUpdateInput }): Promise<unknown>;
    create(args: { data: Prisma.NewsIntelUncheckedCreateInput }): Promise<unknown>;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function asDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) {
    return null;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function truncateText(value: unknown, maxLength: number, fallback = ''): string {
  const text = asString(value, fallback);
  if (!text) {
    return fallback;
  }
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function asArrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) as Array<Record<string, unknown>>;
}

function pickStockScopedRecord(source: unknown, stockCode: string): Record<string, unknown> {
  const table = asRecord(source);
  const scoped = asRecord(table[stockCode]);
  if (Object.keys(scoped).length > 0) {
    return scoped;
  }
  return table;
}

function normalizeAnalysisNewsRecord(item: Record<string, unknown>): AnalysisNewsItem | null {
  const url = truncateText(item.url, 1000);
  if (!url) {
    return null;
  }

  const title = truncateText(item.title, 300, url);
  if (!title) {
    return null;
  }

  return {
    title,
    snippet: asString(item.snippet),
    url,
    source: truncateText(item.source, 100) || null,
    publishedDate: asDate(item.published_date ?? item.publishedDate),
    provider: truncateText(item.provider, 32) || null,
    dimension: truncateText(item.dimension, 32) || null,
    query: truncateText(item.query, 255) || null,
  };
}

function dedupeAnalysisNewsItems(items: AnalysisNewsItem[]): AnalysisNewsItem[] {
  const seenUrls = new Set<string>();
  const deduped: AnalysisNewsItem[] = [];

  for (const item of items) {
    if (!item.url || seenUrls.has(item.url)) {
      continue;
    }
    deduped.push(item);
    seenUrls.add(item.url);
  }

  return deduped;
}

export function buildAnalysisNewsContent(summary: unknown, items: Array<Pick<AnalysisNewsItem, 'title'>>): string | null {
  const normalizedSummary = asString(summary);
  if (normalizedSummary) {
    return normalizedSummary;
  }

  const titles = items.map(item => asString(item.title)).filter(Boolean).slice(0, 3);
  if (titles.length === 0) {
    return null;
  }

  return `相关新闻：${titles.join('；')}`;
}

function extractFromSignalSnapshots(snapshots: unknown[]): ExtractedAnalysisNews {
  const items: AnalysisNewsItem[] = [];
  let summary: string | null = null;

  for (const snapshot of snapshots) {
    const aiPayload = asRecord(asRecord(snapshot).ai_payload);
    const snapshotSummary = asString(aiPayload.news_summary);
    if (!summary && snapshotSummary) {
      summary = snapshotSummary;
    }

    items.push(
      ...asArrayOfRecords(aiPayload.news_items)
        .map(item => normalizeAnalysisNewsRecord(item))
        .filter((item): item is AnalysisNewsItem => item != null),
    );
  }

  const dedupedItems = dedupeAnalysisNewsItems(items);
  return {
    items: dedupedItems,
    newsContent: buildAnalysisNewsContent(summary, dedupedItems),
  };
}

export function extractAnalysisNewsFromAgentRun(run: AgentRunPayload, stockCode: string): ExtractedAnalysisNews {
  return extractFromSignalSnapshots([
    pickStockScopedRecord(run.signal_snapshot, stockCode),
  ]);
}

export function extractAnalysisNewsFromRawResult(rawResult: unknown, stockCode: string): ExtractedAnalysisNews {
  const raw = asRecord(rawResult);
  const nestedRun = asRecord(raw.agent_run);

  return extractFromSignalSnapshots([
    pickStockScopedRecord(raw.signal_snapshot, stockCode),
    pickStockScopedRecord(nestedRun.signal_snapshot, stockCode),
  ]);
}

export function normalizeAnalysisNewsItems(input: {
  ownerUserId: number;
  queryId: string;
  stockCode: string;
  stockName: string;
  items: AnalysisNewsItem[];
  querySource?: string;
  requesterPlatform?: string;
  requesterUserId?: string;
}): NormalizedAnalysisNewsItem[] {
  const normalizedQueryId = truncateText(input.queryId, 64);
  const normalizedCode = truncateText(input.stockCode, 10);
  const normalizedName = truncateText(input.stockName, 50, input.stockCode);
  const normalizedRequesterUserId = truncateText(input.requesterUserId ?? String(input.ownerUserId), 64);

  return dedupeAnalysisNewsItems(input.items).map(item => ({
    ownerUserId: input.ownerUserId,
    queryId: normalizedQueryId,
    code: normalizedCode,
    name: normalizedName,
    title: truncateText(item.title, 300, item.url),
    snippet: asString(item.snippet),
    url: truncateText(item.url, 1000),
    source: truncateText(item.source, 100) || null,
    publishedDate: item.publishedDate,
    provider: truncateText(item.provider, 32) || null,
    dimension: truncateText(item.dimension, 32) || null,
    query: truncateText(item.query, 255) || null,
    querySource: truncateText(input.querySource ?? 'analysis_center', 32, 'analysis_center'),
    requesterPlatform: truncateText(input.requesterPlatform ?? 'analysis_center', 20, 'analysis_center'),
    requesterUserId: normalizedRequesterUserId,
    requesterQuery: truncateText(item.query, 255) || null,
  }));
}

export async function persistAnalysisNewsItems(
  client: PersistAnalysisNewsClient,
  newsItems: NormalizedAnalysisNewsItem[],
): Promise<number> {
  let persistedCount = 0;

  for (const item of newsItems) {
    const existing = await client.newsIntel.findUnique({
      where: {
        url: item.url,
      },
    });

    if (existing) {
      const updateData: Prisma.NewsIntelUncheckedUpdateInput = {
        fetchedAt: new Date(),
      };

      if (existing.ownerUserId == null) {
        updateData.ownerUserId = item.ownerUserId;
      }
      if (!asString(existing.queryId)) {
        updateData.queryId = item.queryId;
      }
      if (!asString(existing.code)) {
        updateData.code = item.code;
      }
      if (!asString(existing.name) && item.name) {
        updateData.name = item.name;
      }
      if (!asString(existing.dimension) && item.dimension) {
        updateData.dimension = item.dimension;
      }
      if (!asString(existing.query) && item.query) {
        updateData.query = item.query;
      }
      if (!asString(existing.provider) && item.provider) {
        updateData.provider = item.provider;
      }
      if (!asString(existing.title) && item.title) {
        updateData.title = item.title;
      }
      if (!asString(existing.snippet) && item.snippet) {
        updateData.snippet = item.snippet;
      }
      if (!asString(existing.source) && item.source) {
        updateData.source = item.source;
      }
      if (!existing.publishedDate && item.publishedDate) {
        updateData.publishedDate = item.publishedDate;
      }
      if (!asString(existing.querySource) && item.querySource) {
        updateData.querySource = item.querySource;
      }
      if (!asString(existing.requesterPlatform) && item.requesterPlatform) {
        updateData.requesterPlatform = item.requesterPlatform;
      }
      if (!asString(existing.requesterUserId) && item.requesterUserId) {
        updateData.requesterUserId = item.requesterUserId;
      }
      if (!asString(existing.requesterQuery) && item.requesterQuery) {
        updateData.requesterQuery = item.requesterQuery;
      }

      await client.newsIntel.update({
        where: {
          url: item.url,
        },
        data: updateData,
      });
      persistedCount += 1;
      continue;
    }

    await client.newsIntel.create({
      data: {
        ownerUserId: item.ownerUserId,
        queryId: item.queryId,
        code: item.code,
        name: item.name,
        dimension: item.dimension,
        query: item.query,
        provider: item.provider,
        title: item.title,
        snippet: item.snippet,
        url: item.url,
        source: item.source,
        publishedDate: item.publishedDate,
        querySource: item.querySource,
        requesterPlatform: item.requesterPlatform,
        requesterUserId: item.requesterUserId,
        requesterQuery: item.requesterQuery,
      },
    });
    persistedCount += 1;
  }

  return persistedCount;
}

export function toHistoryNewsItems(items: Array<Pick<AnalysisNewsItem, 'title' | 'snippet' | 'url'>>): Array<Record<string, string>> {
  return items
    .map(item => ({
      title: asString(item.title, item.url),
      snippet: asString(item.snippet),
      url: asString(item.url),
    }))
    .filter(item => Boolean(item.url) && Boolean(item.title));
}

export function mergeHistoryNewsItems(
  primary: Array<Record<string, string>>,
  secondary: Array<Record<string, string>>,
  limit: number,
): Array<Record<string, string>> {
  const merged: Array<Record<string, string>> = [];
  const seenUrls = new Set<string>();

  for (const item of [...primary, ...secondary]) {
    const url = asString(item.url);
    const title = asString(item.title, url);
    if (!url || seenUrls.has(url) || !title) {
      continue;
    }

    merged.push({
      title,
      snippet: asString(item.snippet),
      url,
    });
    seenUrls.add(url);

    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}
