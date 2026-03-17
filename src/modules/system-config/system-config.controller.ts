/** 系统配置模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Post, Put, Query } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { SystemConfigService } from './system-config.service';

class SystemConfigUpdateItemDto {
  @IsString()
  key!: string;

  @IsString()
  value!: string;
}

class UpdateSystemConfigRequestDto {
  @IsString()
  @MinLength(1)
  config_version!: string;

  @IsOptional()
  @IsString()
  mask_token?: string;

  @IsOptional()
  @IsBoolean()
  reload_now?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SystemConfigUpdateItemDto)
  items!: SystemConfigUpdateItemDto[];
}

class ValidateSystemConfigRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SystemConfigUpdateItemDto)
  items!: SystemConfigUpdateItemDto[];
}

/** 负责定义该领域的 HTTP 接口边界，把鉴权后的请求参数整理成服务层可消费的输入。 */
@Controller('/api/v1/system')
export class SystemConfigController {
  constructor(private readonly configService: SystemConfigService) {}

  @Get('/config')
  async getConfig(@Query('include_schema') includeSchema = 'true'): Promise<Record<string, unknown>> {
    const flag = ['true', '1', 'yes'].includes(String(includeSchema).toLowerCase());
    return await this.configService.getConfig(flag);
  }

  @Get('/config/schema')
  async getSchema(): Promise<Record<string, unknown>> {
    return await this.configService.getSchema();
  }

  @Post('/config/validate')
  @HttpCode(HttpStatus.OK)
  async validate(@Body() body: ValidateSystemConfigRequestDto): Promise<Record<string, unknown>> {
    return this.configService.validateItems(body.items);
  }

  @Put('/config')
  async update(@Body() body: UpdateSystemConfigRequestDto): Promise<Record<string, unknown>> {
    try {
      return await this.configService.updateConfig({
        configVersion: body.config_version,
        items: body.items,
        maskToken: body.mask_token,
        reloadNow: body.reload_now,
      });
    } catch (error: unknown) {
      const err = error as Error & { code?: string; currentVersion?: string; issues?: unknown };

      if (err.code === 'CONFIG_VERSION_CONFLICT') {
        throw new HttpException(
          {
            error: 'config_version_conflict',
            message: 'Configuration has changed, please reload and retry',
            current_config_version: err.currentVersion,
          },
          HttpStatus.CONFLICT,
        );
      }

      if (err.code === 'VALIDATION_ERROR') {
        throw new HttpException(
          {
            error: 'validation_failed',
            message: 'System configuration validation failed',
            issues: err.issues,
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      throw new HttpException(
        {
          error: 'internal_error',
          message: err.message || 'Failed to update system configuration',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
