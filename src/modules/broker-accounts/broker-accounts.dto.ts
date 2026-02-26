import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListBrokerAccountsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}

export class CreateBrokerAccountDto {
  @IsString()
  broker_code!: string;

  @IsOptional()
  @IsIn(['paper', 'simulation'])
  environment: 'paper' | 'simulation' = 'paper';

  @IsString()
  account_uid!: string;

  @IsOptional()
  @IsString()
  account_display_name?: string;

  @IsObject()
  credentials!: Record<string, unknown>;
}

export class UpdateBrokerAccountDto {
  @IsOptional()
  @IsString()
  account_display_name?: string;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @IsOptional()
  @IsObject()
  credentials?: Record<string, unknown>;
}

export class VerifyBrokerAccountDto {
  @IsOptional()
  @Type(() => Boolean)
  refresh = true;
}
