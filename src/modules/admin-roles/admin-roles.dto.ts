import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class RolePermissionItemDto {
  @IsString()
  @MinLength(1)
  module_code!: string;

  @IsBoolean()
  can_read!: boolean;

  @IsBoolean()
  can_write!: boolean;
}

export class ListAdminRolesQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 20;
}

export class CreateAdminRoleDto {
  @IsString()
  @MinLength(2)
  role_code!: string;

  @IsString()
  @MinLength(1)
  role_name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RolePermissionItemDto)
  permissions!: RolePermissionItemDto[];
}

export class UpdateAdminRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  role_code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  role_name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RolePermissionItemDto)
  permissions?: RolePermissionItemDto[];
}
