import { Type } from 'class-transformer';
import { IsIn, IsNumber, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';

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
}
