/** A single forward action and its idempotent rollback action. */
export interface SagaStep<TContext, TResult = unknown> {
  readonly name: string;
  execute(context: TContext): Promise<TResult>;
  compensate(context: TContext, result: TResult): Promise<void>;
}

