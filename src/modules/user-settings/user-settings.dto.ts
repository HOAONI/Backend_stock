/** 用户个人设置模块使用的数据结构与参数校验定义。 */

import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

export class UpdateSimulationSettingsDto {
  @IsOptional()
  @IsString()
  accountName?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  initialCapital?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateAiSettingsDto {
  @IsOptional()
  @IsIn(['openai', 'deepseek', 'siliconflow'])
  provider?: 'openai' | 'deepseek' | 'siliconflow';

  @IsOptional()
  @IsString()
  baseUrl?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsString()
  apiToken?: string;
}

export class UpdateStrategySettingsDto {
  @IsOptional()
  @IsIn(['conservative', 'balanced', 'aggressive'])
  riskProfile?: 'conservative' | 'balanced' | 'aggressive';

  @IsOptional()
  @IsIn(['auto', 'ma', 'rsi', 'custom'])
  analysisStrategy?: 'auto' | 'ma' | 'rsi' | 'custom';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxSingleTradeAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  positionMaxPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  stopLossPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  takeProfitPct?: number;
}

export class UpdateAgentChatSettingsDto {
  @IsOptional()
  @IsIn(['auto_execute_if_condition_met', 'confirm_before_execute'])
  executionPolicy?: 'auto_execute_if_condition_met' | 'confirm_before_execute';

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  confirmationShortcutsEnabled?: boolean;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  followupFocusResolutionEnabled?: boolean;

  @IsOptional()
  @IsIn(['concise_factual', 'balanced', 'detailed'])
  responseStyle?: 'concise_factual' | 'balanced' | 'detailed';
}

export class UpdateUserSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSimulationSettingsDto)
  simulation?: UpdateSimulationSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateAiSettingsDto)
  ai?: UpdateAiSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateStrategySettingsDto)
  strategy?: UpdateStrategySettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateAgentChatSettingsDto)
  agentChat?: UpdateAgentChatSettingsDto;
}
