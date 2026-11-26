import type { FulfillmentContext } from './saga-steps.js';
import type { SagaStep } from './saga-step.js';

export class FulfillmentSaga {
  constructor(private readonly steps: readonly SagaStep<FulfillmentContext>[]) {}

  async execute(context: FulfillmentContext): Promise<void> {
    const completed: { step: SagaStep<FulfillmentContext>; result: unknown }[] = [];
    try {
      for (const step of this.steps) completed.push({ step, result: await step.execute(context) });
    } catch (cause) {
      const compensationErrors: unknown[] = [];
      for (const item of completed.reverse()) {
        try { await item.step.compensate(context, item.result); }
        catch (error) { compensationErrors.push(error); }
      }
      if (compensationErrors.length) throw new AggregateError([cause, ...compensationErrors], 'Saga failed and one or more compensations failed');
      throw cause;
    }
  }
}
