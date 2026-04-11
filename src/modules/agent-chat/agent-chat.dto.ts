/** Agent 问股模块 DTO。 */

import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class AgentChatRequestDto {
  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  session_id?: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

export class AgentChatInternalRuntimeContextDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @IsOptional()
  refresh?: boolean;
}

export class AgentChatInternalAccountStateDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @IsOptional()
  refresh?: boolean;
}

export class AgentChatInternalPortfolioHealthDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @IsOptional()
  refresh?: boolean;
}

export class AgentChatInternalUserPreferencesDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @IsOptional()
  @IsObject()
  session_overrides?: Record<string, unknown>;
}

export class AgentChatInternalHistoryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  stock_codes?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 5;
}

export class AgentChatInternalSaveAnalysisDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @IsString()
  session_id!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  assistant_message_id!: number;

  @IsObject()
  analysis_result!: Record<string, unknown>;
}

export class AgentChatInternalBacktestDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  stock_codes?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit = 6;
}

export class AgentChatInternalStrategyDefinitionDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  strategy_id?: number;

  @IsString()
  strategy_name!: string;

  @IsString()
  template_code!: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

export class AgentChatInternalStrategyBacktestDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @IsString()
  code!: string;

  @IsString()
  start_date!: string;

  @IsString()
  end_date!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgentChatInternalStrategyDefinitionDto)
  strategies?: AgentChatInternalStrategyDefinitionDto[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  initial_capital?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  commission_rate?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1000)
  slippage_bps?: number;
}

export class AgentChatInternalStrategyBacktestInterpretationItemDto {
  @IsString()
  item_key!: string;

  @IsString()
  status!: string;

  @IsOptional()
  @IsString()
  verdict?: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsString()
  error_message?: string;
}

export class AgentChatInternalSaveStrategyBacktestInterpretationDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  run_group_id!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AgentChatInternalStrategyBacktestInterpretationItemDto)
  items!: AgentChatInternalStrategyBacktestInterpretationItemDto[];
}

export class AgentChatInternalPlaceOrderDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  owner_user_id!: number;

  @IsString()
  session_id!: string;

  @IsObject()
  candidate_order!: Record<string, unknown>;
}
