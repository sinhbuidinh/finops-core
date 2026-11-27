import { Injectable } from '@nestjs/common';
import type { OutboxMessage } from './outbox-repository.js';

export type OutboxHandler = (message: OutboxMessage) => void | Promise<void>;

@Injectable()
export class OutboxEventBus {
  private readonly handlers = new Map<string, Set<OutboxHandler>>();

  subscribe(eventName: string, handler: OutboxHandler): () => void {
    const subscribers =
      this.handlers.get(eventName) ?? new Set<OutboxHandler>();
    subscribers.add(handler);
    this.handlers.set(eventName, subscribers);
    return () => {
      subscribers.delete(handler);
      if (subscribers.size === 0) this.handlers.delete(eventName);
    };
  }

  async publish(message: OutboxMessage): Promise<void> {
    const handlers = this.handlers.get(message.eventName);
    if (!handlers?.size) {
      throw new Error(`No outbox handler registered for ${message.eventName}`);
    }
    await Promise.all([...handlers].map((handler) => Promise.resolve(handler(message))));
  }
}
