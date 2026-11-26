import { FulfillmentSaga } from './fulfillment-saga.js';
import type { SagaStep } from './saga-step.js';

describe('FulfillmentSaga', () => {
  it('runs successful steps in order', async () => {
    const calls: string[] = [];
    const steps = ['reserve', 'settle'].map((name): SagaStep<object, string> => ({
      name,
      execute: async () => { calls.push(name); return name; },
      compensate: async () => { calls.push(`undo-${name}`); },
    }));
    await new FulfillmentSaga(steps).execute({} as Parameters<FulfillmentSaga['execute']>[0]);
    expect(calls).toEqual(['reserve', 'settle']);
  });

  it('compensates completed steps in reverse order after payment failure', async () => {
    const calls: string[] = [];
    const reserve: SagaStep<object, string> = {
      name: 'reserve', execute: async () => { calls.push('reserve'); return 'reservation-1'; },
      compensate: async (_context, result) => { calls.push(`release-${result}`); },
    };
    const payment: SagaStep<object> = {
      name: 'payment', execute: async () => { calls.push('payment'); throw new Error('payment declined'); },
      compensate: async () => { calls.push('undo-payment'); },
    };
    await expect(new FulfillmentSaga([reserve, payment]).execute({} as Parameters<FulfillmentSaga['execute']>[0])).rejects.toThrow('payment declined');
    expect(calls).toEqual(['reserve', 'payment', 'release-reservation-1']);
  });

  it('attempts all compensations and reports compensation failures', async () => {
    const compensationOrder: string[] = [];
    const step = (name: string): SagaStep<object, string> => ({
      name, execute: async () => name,
      compensate: async () => { compensationOrder.push(name); if (name === 'second') throw new Error('release failed'); },
    });
    await expect(new FulfillmentSaga([step('first'), step('second'), {
      name: 'fail', execute: async () => { throw new Error('forward failed'); }, compensate: async () => undefined,
    }]).execute({} as Parameters<FulfillmentSaga['execute']>[0])).rejects.toBeInstanceOf(AggregateError);
    expect(compensationOrder).toEqual(['second', 'first']);
  });
});
