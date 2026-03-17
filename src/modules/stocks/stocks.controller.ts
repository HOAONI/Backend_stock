/** 股票数据模块的控制器入口，负责承接 HTTP 请求并把权限后的参数转发到服务层。 */

import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { ALLOWED_MIME, ImageStockExtractorService, MAX_SIZE_BYTES } from '@/common/image/image-stock-extractor.service';

import { StocksService } from './stocks.service';

/** 负责定义该领域的 HTTP 接口边界，把鉴权后的请求参数整理成服务层可消费的输入。 */
@Controller('/api/v1/stocks')
export class StocksController {
  constructor(
    private readonly stocksService: StocksService,
    private readonly extractorService: ImageStockExtractorService,
  ) {}

  private parseWindows(input: string | undefined): number[] {
    const raw = String(input ?? '5,10,20,60')
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item));
    const cleaned = raw.filter((item) => item > 0 && item <= 250).map((item) => Math.trunc(item));
    return Array.from(new Set(cleaned));
  }

  @Post('/extract-from-image')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: MAX_SIZE_BYTES,
      },
    }),
  )
  async extractFromImage(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('include_raw') includeRaw = 'false',
  ): Promise<Record<string, unknown>> {
    if (!file) {
      throw new BadRequestException({ error: 'bad_request', message: '未提供文件，请使用表单字段 file 上传图片' });
    }

    const normalizedMime = String(file.mimetype ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(normalizedMime)) {
      const allowed = [...ALLOWED_MIME].join(', ');
      throw new BadRequestException({
        error: 'unsupported_type',
        message: `不支持的类型: ${normalizedMime}。允许: ${allowed}`,
      });
    }

    let extracted: { codes: string[]; rawText: string };
    try {
      extracted = await this.extractorService.extractCodes(file.buffer, normalizedMime);
    } catch (error: unknown) {
      throw new BadRequestException({
        error: 'extract_failed',
        message: (error as Error).message || '图片提取失败',
      });
    }

    const includeRawFlag = ['true', '1', 'yes'].includes(String(includeRaw).toLowerCase());

    return {
      codes: extracted.codes,
      raw_text: includeRawFlag ? extracted.rawText : null,
    };
  }

  @Get('/:stock_code/quote')
  async getQuote(@Param('stock_code') stockCode: string): Promise<Record<string, unknown>> {
    try {
      const quote = await this.stocksService.getRealtimeQuote(stockCode);
      if (!quote) {
        throw new HttpException(
          {
            error: 'not_found',
            message: `未找到股票 ${stockCode} 的行情数据`,
          },
          HttpStatus.NOT_FOUND,
        );
      }
      return quote;
    } catch (error: unknown) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          error: 'internal_error',
          message: `获取实时行情失败: ${(error as Error).message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('/:stock_code/indicators')
  async getIndicators(
    @Param('stock_code') stockCode: string,
    @Query('period') period = 'daily',
    @Query('days') days = '120',
    @Query('windows') windows = '5,10,20,60',
  ): Promise<Record<string, unknown>> {
    if (period !== 'daily') {
      throw new HttpException(
        {
          error: 'validation_error',
          message: "暂不支持该周期，目前仅支持 'daily'",
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const parsedDays = Number(days);
    if (!Number.isFinite(parsedDays) || parsedDays <= 0 || parsedDays > 365) {
      throw new HttpException(
        {
          error: 'validation_error',
          message: 'days must be in range 1..365',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const parsedWindows = this.parseWindows(windows);
    if (parsedWindows.length === 0) {
      throw new HttpException(
        {
          error: 'validation_error',
          message: 'windows must contain at least one positive integer',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    try {
      return await this.stocksService.getIndicators(stockCode, parsedDays, parsedWindows);
    } catch (error: unknown) {
      throw new HttpException(
        {
          error: 'internal_error',
          message: `获取指标数据失败: ${(error as Error).message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('/:stock_code/factors')
  async getFactors(
    @Param('stock_code') stockCode: string,
    @Query('date') date?: string,
  ): Promise<Record<string, unknown>> {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpException(
        {
          error: 'validation_error',
          message: 'date must match YYYY-MM-DD',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    try {
      return await this.stocksService.getFactors(stockCode, date);
    } catch (error: unknown) {
      const message = (error as Error).message || '获取因子数据失败';
      if (message.includes('No available daily bar')) {
        throw new HttpException(
          {
            error: 'not_found',
            message: '未找到指定日期及之前的行情数据',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      throw new HttpException(
        {
          error: 'internal_error',
          message: `获取因子数据失败: ${message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('/:stock_code/history')
  async getHistory(
    @Param('stock_code') stockCode: string,
    @Query('period') period = 'daily',
    @Query('days') days = '30',
  ): Promise<Record<string, unknown>> {
    if (period !== 'daily') {
      throw new HttpException(
        {
          error: 'validation_error',
          message: "暂不支持该周期，目前仅支持 'daily'",
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const parsedDays = Number(days);
    if (!Number.isFinite(parsedDays) || parsedDays <= 0 || parsedDays > 365) {
      throw new HttpException(
        {
          error: 'validation_error',
          message: 'days must be in range 1..365',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    try {
      return await this.stocksService.getHistory(stockCode, parsedDays);
    } catch (error: unknown) {
      throw new HttpException(
        {
          error: 'internal_error',
          message: `获取历史数据失败: ${(error as Error).message}`,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
