import { Type } from 'class-transformer';
import { IsNotEmptyObject, IsNumber, IsObject, IsOptional, IsString, Min } from 'class-validator';

export class BindSimulationAccountDto {
  @IsOptional()
  @IsString()
  account_uid?: string;

  @IsOptional()
  @IsString()
  account_display_name?: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  initial_capital!: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  commission_rate?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  slippage_bps?: number;

  @IsOptional()
  @IsObject()
  @IsNotEmptyObject()
  credentials?: Record<string, unknown>;
}
