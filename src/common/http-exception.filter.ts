import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { requestContext } from './request-context.js';
import { StructuredLogger } from './structured-logger.js';
import {
  DomainConflictError,
  DomainError,
  DomainNotFoundError,
  DomainValidationError,
} from '../shared/domain/domain-error.js';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new StructuredLogger();

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : exception instanceof DomainNotFoundError
        ? HttpStatus.NOT_FOUND
        : exception instanceof DomainConflictError
          ? HttpStatus.CONFLICT
          : exception instanceof DomainValidationError
            ? HttpStatus.BAD_REQUEST
            : HttpStatus.INTERNAL_SERVER_ERROR;
    const correlationId = requestContext.getStore()?.correlationId;
    const exceptionResponse = exception instanceof HttpException
      ? exception.getResponse()
      : undefined;
    const message = typeof exceptionResponse === 'string'
      ? exceptionResponse
      : exceptionResponse && typeof exceptionResponse === 'object' && 'message' in exceptionResponse
        ? typeof exceptionResponse.message === 'string'
          ? exceptionResponse.message
        : 'Internal server error'
        : exception instanceof DomainError
          ? exception.message
          : 'Internal server error';

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(exception instanceof Error ? exception : String(exception), {
        method: request.method,
        path: request.url,
      });
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(correlationId && { correlationId }),
    });
  }
}
