/** Agent 问股模块 DTO。 */

import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
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
