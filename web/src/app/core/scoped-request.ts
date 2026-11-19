import { DestroyRef, inject, signal } from '@angular/core';
import { OrganizationContext } from './organization-context';
import { requestError } from './request-error';

/** A view may retain its data after an error, but never after an organization switch. */
export function scopedRequest(reset: () => void) {
  const context = inject(OrganizationContext);
  const busy = signal(false), error = signal(''), notice = signal('');
  let generation = 0;
  const operations = new Map<string, string>();
  const unsubscribe = context.onChange(() => { generation++; operations.clear(); reset(); busy.set(false); error.set(''); notice.set(''); });
  inject(DestroyRef).onDestroy(() => { generation++; unsubscribe(); });
  async function run<T>(action: () => Promise<T>, apply: (value: T) => void, message = ''): Promise<T | undefined> {
    const requestGeneration = ++generation, epoch = context.capture();
    const current = () => requestGeneration === generation && context.isCurrent(epoch);
    busy.set(true); error.set(''); notice.set('');
    try {
      const value = await action();
      if (!current()) return undefined;
      apply(value); notice.set(message); return value;
    } catch (cause) { if (current()) error.set(requestError(cause)); return undefined; }
    finally { if (current()) busy.set(false); }
  }
  function operationId(action: string, input: unknown) {
    const key = JSON.stringify([action, input]);
    if (!operations.has(key)) operations.set(key, crypto.randomUUID());
    return operations.get(key)!;
  }
  return { busy, error, notice, run, operationId };
}
