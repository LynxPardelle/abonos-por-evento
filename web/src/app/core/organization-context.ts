import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class OrganizationContext {
  private readonly selected = signal('');
  readonly organizationId = this.selected.asReadonly();
  private epoch = 0;
  private readonly listeners = new Set<() => void>();
  capture() { return this.epoch; }
  isCurrent(epoch: number) { return epoch === this.epoch; }
  select(organizationId: string) {
    if (organizationId && !/^[A-Za-z0-9][A-Za-z0-9_:@.-]{0,127}$/.test(organizationId)) throw new Error('La organización no es válida.');
    if (this.selected() === organizationId) return;
    this.epoch++;
    this.selected.set(organizationId);
    for (const listener of this.listeners) listener();
  }
  reset() {
    this.epoch++;
    this.selected.set('');
    for (const listener of this.listeners) listener();
  }
  onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
