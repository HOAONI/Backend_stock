import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

export class IssueCredentialTicketDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  user_id!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  broker_account_id?: number;

  @IsOptional()
  @IsIn(['read', 'trade'])
  scope: 'read' | 'trade' = 'read';

  @IsOptional()
  @IsString()
  task_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(600)
  ttl_seconds?: number;
}

export class ExchangeCredentialTicketDto {
  @IsString()
  ticket!: string;
}

export class AgentExecutionEventDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  user_id!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  broker_account_id!: number;

  @IsOptional()
  @IsString()
  task_id?: string;

  @IsString()
  event_type!: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  error_code?: string;
}
