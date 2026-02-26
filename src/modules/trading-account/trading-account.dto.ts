import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class TradingAccountQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  broker_account_id?: number;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  refresh = false;
}

export class PlaceOrderDto {
  @IsInt()
  @Min(1)
  broker_account_id!: number;

  @IsString()
  stock_code!: string;

  @IsOptional()
  @IsString()
  stock_name?: string;

  @IsIn(['buy', 'sell'])
  direction!: 'buy' | 'sell';

  @IsIn(['limit', 'market'])
  type!: 'limit' | 'market';

  @IsNumber()
  @Min(0.01)
  price!: number;

  @IsNumber()
  @Min(1)
  quantity!: number;
}

export class CancelOrderDto {
  @IsInt()
  @Min(1)
  broker_account_id!: number;

  @IsString()
  order_id!: string;
}
