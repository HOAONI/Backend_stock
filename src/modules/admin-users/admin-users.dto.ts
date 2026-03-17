/** 后台用户管理模块使用的数据结构与参数校验定义。 */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

import { BUILTIN_ROLE_CODES } from '@/common/auth/rbac.constants';

const ADMIN_USER_ROLE_CODES = [BUILTIN_ROLE_CODES.admin, BUILTIN_ROLE_CODES.user] as const;

export class ListAdminUsersQueryDto {
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @IsOptional()
  @IsIn(ADMIN_USER_ROLE_CODES)
  role_code?: (typeof ADMIN_USER_ROLE_CODES)[number];

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

export class CreateAdminUserDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(1)
  password!: string;

  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @IsIn(ADMIN_USER_ROLE_CODES, { each: true })
  role_codes!: string[];
}

export class UpdateAdminUserDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  username?: string;

  @IsOptional()
  @IsString()
  display_name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: 'active' | 'disabled';

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1)
  @IsIn(ADMIN_USER_ROLE_CODES, { each: true })
  role_codes?: string[];
}

export class UpdateAdminUserStatusDto {
  @IsIn(['active', 'disabled'])
  status!: 'active' | 'disabled';
}

export class ResetAdminUserPasswordDto {
  @IsString()
  @MinLength(1)
  new_password!: string;
}
