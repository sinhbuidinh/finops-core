import type { LoggerService } from '@nestjs/common';
import { requestContext } from './request-context.js';

export class StructuredLogger implements LoggerService {
  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  private write(level: string, message: unknown, params: unknown[]): void {
    const context = params.find((value) => typeof value === 'string');
    const details = params.filter((value) => value !== context);
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: message instanceof Error ? message.message : String(message),
      ...(requestContext.getStore()?.correlationId && {
        correlationId: requestContext.getStore()?.correlationId,
      }),
      ...(context && { context }),
      ...(details.length && { details }),
      ...(message instanceof Error && { stack: message.stack }),
    };

    const output = JSON.stringify(entry);
    if (level === 'error' || level === 'fatal') console.error(output);
    else if (level === 'warn') console.warn(output);
    else console.log(output);
  }
}
