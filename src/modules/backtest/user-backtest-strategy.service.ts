/** 回测模块的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';
import { Prisma, UserBacktestStrategy } from '@prisma/client';

import { PrismaService } from '@/common/database/prisma.service';
import {
  BacktestStrategyTemplateCode,
  getBacktestStrategyTemplateDefinition,
  getBacktestStrategyTemplateName,
  isBacktestStrategyTemplateCode,
  listBacktestStrategyTemplateDefinitions,
  normalizeBacktestStrategyParams,
} from './backtest-strategy-templates';
import {
  BACKTEST_STRATEGY_NAMES,
  DEFAULT_BACKTEST_STRATEGY_CODES,
  LegacyBacktestStrategyCode,
  resolveLegacyBacktestStrategy,
} from './backtest-strategy-strategies';

interface ServiceError extends Error {
  code?: string;
}

export interface ResolvedUserBacktestStrategy {
  strategyId: number | null;
  strategyName: string;
  templateCode: BacktestStrategyTemplateCode;
  templateName: string;
  params: Record<string, number>;
}

function buildError(code: string, message: string): ServiceError {
  const error = new Error(message) as ServiceError;
  error.code = code;
  return error;
}

function dedupePositiveIntegers(values?: number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const item of values ?? []) {
    const value = Math.trunc(Number(item));
    if (!Number.isFinite(value) || value <= 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function asPlainObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class UserBacktestStrategyService {
  constructor(private readonly prisma: PrismaService) {}

  listTemplates(): Record<string, unknown> {
    return {
      items: listBacktestStrategyTemplateDefinitions().map((template) => ({
        template_code: template.templateCode,
        template_name: template.templateName,
        description: template.description,
        default_params: template.params.reduce<Record<string, number>>((acc, field) => {
          acc[field.key] = field.defaultValue;
          return acc;
        }, {}),
        param_schema: template.params.map((field) => ({
          key: field.key,
          label: field.label,
          description: field.description,
          min: field.min,
          max: field.max,
          step: field.step,
          default_value: field.defaultValue,
        })),
      })),
    };
  }

  async listUserStrategies(userId: number): Promise<Record<string, unknown>> {
    const rows = await this.prisma.userBacktestStrategy.findMany({
      where: { ownerUserId: userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });

    return {
      items: rows.map((row) => this.mapRow(row)),
    };
  }

  async getUserStrategy(userId: number, strategyId: number): Promise<Record<string, unknown>> {
    const row = await this.requireOwnedStrategy(userId, strategyId);
    return this.mapRow(row);
  }

  async createUserStrategy(
    userId: number,
    input: {
      name: string;
      description?: string;
      templateCode: string;
      params: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const payload = this.normalizeStrategyDraft(input);

    try {
      const row = await this.prisma.userBacktestStrategy.create({
        data: {
          ownerUserId: userId,
          name: payload.name,
          description: payload.description,
          templateCode: payload.templateCode,
          paramsJson: payload.params as Prisma.InputJsonValue,
        },
      });
      return this.mapRow(row);
    } catch (error: unknown) {
      this.rethrowStorageError(error, payload.name);
    }
  }

  async updateUserStrategy(
    userId: number,
    strategyId: number,
    input: {
      name?: string;
      description?: string;
      templateCode?: string;
      params?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    const current = await this.requireOwnedStrategy(userId, strategyId);
    const payload = this.normalizeStrategyDraft({
      name: input.name ?? current.name,
      description: input.description ?? current.description ?? '',
      templateCode: input.templateCode ?? current.templateCode,
      params: input.params ?? asPlainObject(current.paramsJson),
    });

    try {
      const row = await this.prisma.userBacktestStrategy.update({
        where: { id: strategyId },
        data: {
          name: payload.name,
          description: payload.description,
          templateCode: payload.templateCode,
          paramsJson: payload.params as Prisma.InputJsonValue,
        },
      });
      return this.mapRow(row);
    } catch (error: unknown) {
      this.rethrowStorageError(error, payload.name);
    }
  }

  async deleteUserStrategy(userId: number, strategyId: number): Promise<Record<string, unknown>> {
    await this.requireOwnedStrategy(userId, strategyId);
    await this.prisma.userBacktestStrategy.delete({ where: { id: strategyId } });
    return { deleted: true };
  }

  async resolveRunStrategies(input: {
    userId: number;
    strategyIds?: number[];
    strategyCodes?: string[];
  }): Promise<ResolvedUserBacktestStrategy[]> {
    const strategyIds = dedupePositiveIntegers(input.strategyIds);
    if (strategyIds.length > 0) {
      const rows = await this.prisma.userBacktestStrategy.findMany({
        where: {
          ownerUserId: input.userId,
          id: { in: strategyIds },
        },
      });

      if (rows.length !== strategyIds.length) {
        throw buildError('NOT_FOUND', '一个或多个所选策略不存在');
      }

      const rowMap = new Map(rows.map((row) => [row.id, row]));
      return strategyIds.map((strategyId) => this.mapResolvedRow(rowMap.get(strategyId)!));
    }

    const normalizedLegacyCodes = this.normalizeLegacyStrategyCodes(input.strategyCodes);
    return normalizedLegacyCodes.map((strategyCode) => {
      const resolved = resolveLegacyBacktestStrategy(strategyCode);
      return {
        strategyId: null,
        strategyName: BACKTEST_STRATEGY_NAMES[strategyCode],
        templateCode: resolved.templateCode,
        templateName: getBacktestStrategyTemplateName(resolved.templateCode),
        params: resolved.params,
      };
    });
  }

  private normalizeLegacyStrategyCodes(values?: string[]): LegacyBacktestStrategyCode[] {
    const selected = (values ?? DEFAULT_BACKTEST_STRATEGY_CODES)
      .map((item) => String(item).trim())
      .filter((item): item is LegacyBacktestStrategyCode => item in BACKTEST_STRATEGY_NAMES);
    const deduped = Array.from(new Set(selected));
    return deduped.length > 0 ? deduped : [...DEFAULT_BACKTEST_STRATEGY_CODES];
  }

  private normalizeStrategyDraft(input: {
    name: string;
    description?: string;
    templateCode: string;
    params: Record<string, unknown>;
  }): {
    name: string;
    description: string | null;
    templateCode: BacktestStrategyTemplateCode;
    params: Record<string, number>;
  } {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 64) {
      throw buildError('VALIDATION_ERROR', '策略名称长度必须为 1 - 64 个字符');
    }

    const descriptionText = String(input.description ?? '').trim();
    const description = descriptionText.length > 0 ? descriptionText : null;
    if (description && description.length > 255) {
      throw buildError('VALIDATION_ERROR', '策略说明不能超过 255 个字符');
    }

    const templateCodeRaw = String(input.templateCode ?? '').trim();
    if (!isBacktestStrategyTemplateCode(templateCodeRaw)) {
      throw buildError('VALIDATION_ERROR', '策略模板无效');
    }

    const { params, issues } = normalizeBacktestStrategyParams(templateCodeRaw, input.params);
    if (issues.length > 0) {
      throw buildError('VALIDATION_ERROR', issues.join('; '));
    }

    return {
      name,
      description,
      templateCode: templateCodeRaw,
      params,
    };
  }

  private async requireOwnedStrategy(userId: number, strategyId: number): Promise<UserBacktestStrategy> {
    const row = await this.prisma.userBacktestStrategy.findFirst({
      where: {
        id: strategyId,
        ownerUserId: userId,
      },
    });
    if (!row) {
      throw buildError('NOT_FOUND', `未找到策略：${strategyId}`);
    }
    return row;
  }

  private mapRow(row: UserBacktestStrategy): Record<string, unknown> {
    const templateCode = isBacktestStrategyTemplateCode(row.templateCode)
      ? row.templateCode
      : resolveLegacyBacktestStrategy('ma20_trend').templateCode;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      template_code: templateCode,
      template_name: getBacktestStrategyTemplateName(templateCode),
      params: asPlainObject(row.paramsJson),
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private mapResolvedRow(row: UserBacktestStrategy): ResolvedUserBacktestStrategy {
    if (!isBacktestStrategyTemplateCode(row.templateCode)) {
      throw buildError('VALIDATION_ERROR', `策略 ${row.id} 使用了不支持的模板：${row.templateCode}`);
    }

    const { params, issues } = normalizeBacktestStrategyParams(row.templateCode, row.paramsJson);
    if (issues.length > 0) {
      throw buildError('VALIDATION_ERROR', `策略 ${row.id} 的参数无效：${issues.join('； ')}`);
    }

    return {
      strategyId: row.id,
      strategyName: row.name,
      templateCode: row.templateCode,
      templateName: getBacktestStrategyTemplateDefinition(row.templateCode).templateName,
      params,
    };
  }

  private rethrowStorageError(error: unknown, strategyName: string): never {
    const err = error as { code?: string };
    if (err?.code === 'P2002') {
      throw buildError('CONFLICT', `策略名称“${strategyName}”已存在`);
    }
    throw error;
  }
}
