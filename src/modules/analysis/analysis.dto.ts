/** 股票分析模块使用的数据结构与参数校验定义。 */

import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class AnalyzeRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  stock_code?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  stock_codes?: string[];

  @IsOptional()
  @IsString()
  @IsIn(['simple', 'detailed'])
  report_type: 'simple' | 'detailed' = 'detailed';

  @IsOptional()
  @IsBoolean()
  force_refresh = true;

  @IsOptional()
  @IsBoolean()
  async_mode = false;

  @IsOptional()
  @IsIn(['auto', 'paper'])
  execution_mode: 'auto' | 'paper' = 'auto';
}

export class CreateAnalysisScheduleDto {
  @IsString()
  @MaxLength(32)
  stock_code!: string;

  @IsInt()
  @Min(1)
  @Max(10080)
  interval_minutes!: number;

  @IsIn(['auto', 'paper'])
  execution_mode: 'auto' | 'paper' = 'auto';
}

export class UpdateAnalysisScheduleDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  stock_code?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080)
  interval_minutes?: number;

  @IsOptional()
  @IsIn(['auto', 'paper'])
  execution_mode?: 'auto' | 'paper';

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
