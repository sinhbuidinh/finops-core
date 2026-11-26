import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { StructuredLogger } from './common/structured-logger.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { correlationIdMiddleware } from './common/correlation-id.middleware.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    logger: new StructuredLogger(),
  });
  app.use(correlationIdMiddleware);
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
