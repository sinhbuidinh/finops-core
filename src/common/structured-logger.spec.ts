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
});
