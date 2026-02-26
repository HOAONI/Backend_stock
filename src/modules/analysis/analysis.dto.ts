import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

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
  @IsIn(['auto', 'paper', 'broker'])
  execution_mode: 'auto' | 'paper' | 'broker' = 'auto';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  broker_account_id?: number;
}
