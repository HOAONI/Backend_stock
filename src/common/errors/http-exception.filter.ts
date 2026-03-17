/** 错误处理基础设施的异常过滤器，用于统一整理对外错误响应。 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

/** 负责把内部异常转换成统一的 HTTP 响应结构，避免对外泄漏实现细节。 */
@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse() as Record<string, unknown> | string;

      if (typeof payload === 'object' && payload !== null) {
        response.status(status).json(payload);
        return;
      }

      response.status(status).json({
        error: status === HttpStatus.NOT_FOUND ? 'not_found' : 'http_error',
        message: String(payload),
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: 'internal_error',
      message: exception instanceof Error ? exception.message : 'Internal server error',
    });
  }
}
