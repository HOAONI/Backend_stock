/** 交易账户模块使用的数据结构与参数校验定义。 */

import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class TradingAccountQueryDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  refresh = false;
}

export class PlaceOrderDto {
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

  @IsOptional()
  @IsString()
  idempotency_key?: string;
}

export class CancelOrderDto {
  @IsString()
  order_id!: string;

  @IsOptional()
  @IsString()
  idempotency_key?: string;
}

export class AddFundsDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
