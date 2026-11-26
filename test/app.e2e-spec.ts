import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { FulfillmentSagaService } from '../src/modules/fulfillment-saga/fulfillment-saga.service.js';
import { OrdersController } from '../src/modules/fulfillment-saga/orders.controller.js';
import { AppController } from '../src/app.controller.js';
import { AppService } from '../src/app.service.js';
import { FulfillmentSaga } from '../src/modules/fulfillment-saga/application/fulfillment-saga.js';
import type { SagaStep } from '../src/modules/fulfillment-saga/application/saga-step.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app?.close();
  });
});

describe('Orders HTTP (e2e)', () => {
  let app: INestApplication<App>;
  const orders = new Map<string, { id: string; tenantId: string; state: string; sagaId: string }>();
  let reservedQuantity = 0;
  const service = {
    createOrder: vi.fn(async (input: { tenantId: string; quantity: number; payment: { id: string } }, _key: string) => {
      const id = `order-${orders.size + 1}`;
      const order = { id, tenantId: input.tenantId, state: 'APPROVED', sagaId: `saga-${id}` };
      orders.set(id, order);
      const reserve: SagaStep<object, number> = {
        name: 'reserve', execute: async () => { reservedQuantity += input.quantity; return input.quantity; },
        compensate: async (_context, quantity) => { reservedQuantity -= quantity; },
      };
      const payment: SagaStep<object> = {
        name: 'payment', execute: async () => {
          if (input.payment.id.includes('fail')) throw new Error('payment declined');
        }, compensate: async () => undefined,
      };
      const accepted = { ...order };
      try { await new FulfillmentSaga([reserve, payment]).execute({}); }
      catch { order.state = 'FAILED'; }
      if (order.state !== 'FAILED') order.state = 'CONFIRMED';
      return accepted;
    }),
    getOrder: vi.fn(async (id: string) => {
      const order = orders.get(id);
      if (!order) throw new Error('Order not found');
      return order;
    }),
    cancelOrder: vi.fn(async (id: string) => ({ id, state: 'CANCELLED' })),
  };

  beforeEach(async () => {
    orders.clear();
    reservedQuantity = 0;
    const moduleFixture = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [{ provide: FulfillmentSagaService, useValue: service }],
    })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => { await app?.close(); });

  it('creates an order and reports successful fulfillment', async () => {
    const created = await request(app.getHttpServer()).post('/orders').set('Idempotency-Key', 'happy-1')
      .send({ tenantId: 'tenant-1', inventoryItemId: 'sku-1', quantity: 1, payment: { id: 'payment-1', lines: [] } })
      .expect(202);
    expect(created.body.state).toBe('APPROVED');
    await request(app.getHttpServer()).get(`/orders/${created.body.id}`).expect(200).expect(({ body }) => {
      expect(body.state).toBe('CONFIRMED');
    });
  });

  it('exposes the failed state after payment failure rollback', async () => {
    const created = await request(app.getHttpServer()).post('/orders').set('Idempotency-Key', 'fail-1')
      .send({ tenantId: 'tenant-1', inventoryItemId: 'sku-1', quantity: 1, payment: { id: 'payment-fail', lines: [] } })
      .expect(202);
    await request(app.getHttpServer()).get(`/orders/${created.body.id}`).expect(200).expect(({ body }) => {
      expect(body.state).toBe('FAILED');
    });
    expect(reservedQuantity).toBe(0);
  });
});
