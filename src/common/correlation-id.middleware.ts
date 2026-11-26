import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './request-context.js';

const CORRELATION_ID_HEADER = 'x-correlation-id';
const SAFE_CORRELATION_ID = /^[\w.-]{1,128}$/;

export function correlationIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const suppliedId = request.get(CORRELATION_ID_HEADER);
  const correlationId = suppliedId && SAFE_CORRELATION_ID.test(suppliedId)
    ? suppliedId
    : randomUUID();

  response.setHeader(CORRELATION_ID_HEADER, correlationId);
  requestContext.run({ correlationId }, next);
}
