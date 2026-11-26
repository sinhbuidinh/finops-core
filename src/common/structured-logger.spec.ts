import { requestContext } from './request-context.js';
import { StructuredLogger } from './structured-logger.js';

describe('StructuredLogger', () => {
  it('writes JSON logs with the current correlation ID and structured details', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = new StructuredLogger();
    const testCorrelationId = 'request-123';

    requestContext.run({ correlationId: testCorrelationId }, () => {
      logger.log('Request handled', { method: 'GET', path: '/health/live' }, 'HealthController');
    });

    expect(output).toHaveBeenCalledOnce();
    const entry = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'info',
      message: 'Request handled',
      correlationId: testCorrelationId,
      context: 'HealthController',
      details: [{ method: 'GET', path: '/health/live' }],
    });
    expect(Number.isNaN(Date.parse(entry.timestamp as string))).toBe(false);

    output.mockRestore();
  });

  it('routes every log level and serializes error stacks and optional fields', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = new StructuredLogger();
    const failure = new Error('failure');

    logger.log('info');
    logger.warn('warning');
    logger.debug('debug');
    logger.verbose('verbose');
    logger.error(failure, 'LoggerContext', { requestId: 'r1' });
    logger.fatal('fatal');

    expect(out).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
    expect(errorOutput).toHaveBeenCalledTimes(2);
    const serializedError = JSON.parse(errorOutput.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(serializedError).toMatchObject({
      level: 'error', message: 'failure', context: 'LoggerContext', stack: failure.stack,
      details: [{ requestId: 'r1' }],
    });
    expect(JSON.parse(out.mock.calls[2]![0] as string)).toMatchObject({ level: 'trace', message: 'verbose' });

    out.mockRestore();
    warn.mockRestore();
    errorOutput.mockRestore();
  });
});
