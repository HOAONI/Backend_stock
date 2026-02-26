import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Injectable } from '@nestjs/common';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

import { PrismaService } from '@/common/database/prisma.service';

import {
  ConfigCategory,
  ConfigCategorySchema,
  ConfigDataType,
  ConfigFieldSchema,
  ConfigUiControl,
  ConfigValidationIssue,
} from './system-config.types';

function inferCategory(key: string): ConfigCategory {
  if (key.includes('GEMINI') || key.includes('OPENAI') || key.includes('ANTHROPIC')) return 'ai_model';
  if (key.includes('TAVILY') || key.includes('SERPAPI') || key.includes('BRAVE') || key.includes('TUSHARE')) return 'data_source';
  if (key.includes('WEBHOOK') || key.includes('TELEGRAM') || key.includes('EMAIL') || key.includes('PUSH')) return 'notification';
  if (key.includes('BACKTEST')) return 'backtest';
  if (key.includes('PORT') || key.includes('HOST') || key.includes('DATABASE') || key.includes('CORS') || key.includes('ADMIN')) {
    return 'system';
  }
  return 'base';
}

function inferDataType(key: string, value: string): ConfigDataType {
  if (key.includes('ENABLED') || key.includes('ALLOW_ALL') || value === 'true' || value === 'false') return 'boolean';
  if (key.includes('TIME')) return 'time';
  if (key.includes('PORT') || key.includes('DAYS') || key.includes('HOURS') || key.includes('LIMIT')) return 'integer';
  if (key.includes('PCT') || key.includes('THRESHOLD')) return 'number';
  if (value.includes(',') && !value.includes('://')) return 'array';
  return 'string';
}

function inferSensitive(key: string): boolean {
  return /(TOKEN|KEY|SECRET|PASSWORD)/.test(key);
}

function inferUiControl(type: ConfigDataType, sensitive: boolean): ConfigUiControl {
  if (sensitive) return 'password';
  if (type === 'boolean') return 'switch';
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'time') return 'time';
  return 'text';
}

function categoryMeta(category: ConfigCategory): { title: string; description: string; displayOrder: number } {
  const mapping: Record<ConfigCategory, { title: string; description: string; displayOrder: number }> = {
    base: { title: 'Base', description: 'Base runtime options', displayOrder: 10 },
    ai_model: { title: 'AI Model', description: 'AI provider settings', displayOrder: 20 },
    data_source: { title: 'Data Source', description: 'Data and search providers', displayOrder: 30 },
    notification: { title: 'Notification', description: 'Notification channels', displayOrder: 40 },
    system: { title: 'System', description: 'System and deployment settings', displayOrder: 50 },
    backtest: { title: 'Backtest', description: 'Backtest settings', displayOrder: 60 },
    uncategorized: { title: 'Uncategorized', description: 'Uncategorized keys', displayOrder: 99 },
  };
  return mapping[category];
}

@Injectable()
export class SystemConfigService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureSeeded(): Promise<void> {
    const count = await this.prisma.systemConfigItem.count();
    if (count > 0) {
      return;
    }

    const envFile = process.env.ENV_FILE ? path.resolve(process.env.ENV_FILE) : path.resolve(process.cwd(), '.env');
    const payload = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};

    const rows = Object.entries(payload).map(([key, value], index) => {
      const category = inferCategory(key);
      const dataType = inferDataType(key, value);
      return {
        key,
        value,
        category,
        dataType,
        uiControl: inferUiControl(dataType, inferSensitive(key)),
        isSensitive: inferSensitive(key),
        displayOrder: index + 1,
      };
    });

    if (rows.length > 0) {
      await this.prisma.systemConfigItem.createMany({ data: rows });
    }

    await this.prisma.systemConfigRevision.create({
      data: { version: crypto.createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex') },
    });
  }

  async getCurrentVersion(): Promise<string> {
    await this.ensureSeeded();
    const latest = await this.prisma.systemConfigRevision.findFirst({ orderBy: { createdAt: 'desc' } });
    if (latest) {
      return latest.version;
    }

    const version = uuidv4().replace(/-/g, '');
    await this.prisma.systemConfigRevision.create({ data: { version } });
    return version;
  }

  private toFieldSchema(item: {
    key: string;
    value: string;
    category: string;
    dataType: string;
    uiControl: string;
    isSensitive: boolean;
    displayOrder: number;
  }): ConfigFieldSchema {
    return {
      key: item.key,
      title: item.key,
      category: (item.category as ConfigCategory) || 'uncategorized',
      data_type: (item.dataType as ConfigDataType) || 'string',
      ui_control: (item.uiControl as ConfigUiControl) || 'text',
      is_sensitive: item.isSensitive,
      is_required: false,
      is_editable: true,
      options: [],
      validation: this.buildValidation(item.dataType as ConfigDataType),
      display_order: item.displayOrder,
      default_value: item.value,
    };
  }

  private buildValidation(dataType: ConfigDataType): Record<string, unknown> {
    if (dataType === 'time') {
      return { pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
    }
    return {};
  }

  async getSchema(): Promise<{ schema_version: string; categories: ConfigCategorySchema[] }> {
    await this.ensureSeeded();
    const rows = await this.prisma.systemConfigItem.findMany({ orderBy: [{ category: 'asc' }, { displayOrder: 'asc' }, { key: 'asc' }] });

    const grouped = new Map<ConfigCategory, ConfigFieldSchema[]>();
    for (const row of rows) {
      const category = (row.category as ConfigCategory) || 'uncategorized';
      if (!grouped.has(category)) {
        grouped.set(category, []);
      }
      grouped.get(category)?.push(this.toFieldSchema(row));
    }

    const categories = Array.from(grouped.entries())
      .map(([category, fields]) => {
        const meta = categoryMeta(category);
        return {
          category,
          title: meta.title,
          description: meta.description,
          display_order: meta.displayOrder,
          fields,
        };
      })
      .sort((a, b) => a.display_order - b.display_order);

    return {
      schema_version: '1.0.0',
      categories,
    };
  }

  async getConfig(includeSchema = true): Promise<Record<string, unknown>> {
    await this.ensureSeeded();
    const version = await this.getCurrentVersion();
    const rows = await this.prisma.systemConfigItem.findMany({ orderBy: [{ category: 'asc' }, { displayOrder: 'asc' }, { key: 'asc' }] });

    const items = rows.map((row) => {
      const item: Record<string, unknown> = {
        key: row.key,
        value: row.value,
        raw_value_exists: Boolean(row.value),
        is_masked: false,
      };

      if (includeSchema) {
        item.schema = this.toFieldSchema(row);
      }

      return item;
    });

    const latestUpdatedAt = rows.reduce<Date | null>(
      (latest, row) => {
        if (!latest || row.updatedAt.getTime() > latest.getTime()) {
          return row.updatedAt;
        }
        return latest;
      },
      null,
    );

    return {
      config_version: version,
      mask_token: '******',
      items,
      updated_at: latestUpdatedAt?.toISOString() ?? null,
    };
  }

  validateItems(items: Array<{ key: string; value: string }>): { valid: boolean; issues: ConfigValidationIssue[] } {
    const issues: ConfigValidationIssue[] = [];

    for (const item of items) {
      const key = String(item.key ?? '').trim().toUpperCase();
      const value = String(item.value ?? '');
      const dataType = inferDataType(key, value);

      if (value.includes('\n')) {
        issues.push({
          key,
          code: 'invalid_value',
          message: 'Value cannot contain newline characters',
          severity: 'error',
          expected: 'single-line value',
          actual: 'contains newline',
        });
        continue;
      }

      if (dataType === 'boolean' && !['true', 'false'].includes(value.toLowerCase())) {
        issues.push({
          key,
          code: 'invalid_type',
          message: 'Value must be true or false',
          severity: 'error',
          expected: 'true|false',
          actual: value,
        });
      }

      if (dataType === 'integer' && !/^[-+]?\d+$/.test(value)) {
        issues.push({
          key,
          code: 'invalid_type',
          message: 'Value must be an integer',
          severity: 'error',
          expected: 'integer',
          actual: value,
        });
      }

      if (dataType === 'number' && Number.isNaN(Number(value))) {
        issues.push({
          key,
          code: 'invalid_type',
          message: 'Value must be a number',
          severity: 'error',
          expected: 'number',
          actual: value,
        });
      }

      if (dataType === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        issues.push({
          key,
          code: 'invalid_format',
          message: 'Value must be in HH:MM format',
          severity: 'error',
          expected: 'HH:MM',
          actual: value,
        });
      }
    }

    return {
      valid: issues.every((issue) => issue.severity !== 'error'),
      issues,
    };
  }

  async updateConfig(input: {
    configVersion: string;
    items: Array<{ key: string; value: string }>;
    maskToken?: string;
    reloadNow?: boolean;
  }): Promise<Record<string, unknown>> {
    await this.ensureSeeded();

    const current = await this.getCurrentVersion();
    if (current !== input.configVersion) {
      const err = new Error('Configuration has changed, please reload and retry');
      (err as Error & { code: string; currentVersion: string }).code = 'CONFIG_VERSION_CONFLICT';
      (err as Error & { code: string; currentVersion: string }).currentVersion = current;
      throw err;
    }

    const validation = this.validateItems(input.items);
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      const err = new Error('System configuration validation failed');
      (err as Error & { code: string; issues: ConfigValidationIssue[] }).code = 'VALIDATION_ERROR';
      (err as Error & { code: string; issues: ConfigValidationIssue[] }).issues = errors;
      throw err;
    }

    const normalized = input.items.map((item) => {
      const key = String(item.key ?? '').trim().toUpperCase();
      const value = String(item.value ?? '');
      const dataType = inferDataType(key, value);
      return {
        key,
        value,
        category: inferCategory(key),
        dataType,
        uiControl: inferUiControl(dataType, inferSensitive(key)),
        isSensitive: inferSensitive(key),
      };
    });

    const appliedKeys: string[] = [];
    let skippedMaskedCount = 0;

    for (const item of normalized) {
      if (item.isSensitive && item.value === (input.maskToken ?? '******')) {
        skippedMaskedCount += 1;
        continue;
      }

      await this.prisma.systemConfigItem.upsert({
        where: { key: item.key },
        update: {
          value: item.value,
          category: item.category,
          dataType: item.dataType,
          uiControl: item.uiControl,
          isSensitive: item.isSensitive,
        },
        create: {
          key: item.key,
          value: item.value,
          category: item.category,
          dataType: item.dataType,
          uiControl: item.uiControl,
          isSensitive: item.isSensitive,
        },
      });

      appliedKeys.push(item.key);
    }

    const nextVersion = uuidv4().replace(/-/g, '');
    await this.prisma.systemConfigRevision.create({ data: { version: nextVersion } });

    return {
      success: true,
      config_version: nextVersion,
      applied_count: appliedKeys.length,
      skipped_masked_count: skippedMaskedCount,
      reload_triggered: Boolean(input.reloadNow ?? true),
      updated_keys: appliedKeys,
      warnings: [],
    };
  }
}
