import { TestBed } from '@angular/core/testing';
import { OrganizationContext } from './organization-context';

describe('organization context', () => {
  it('clears registered views synchronously before using another organization', () => {
    const context = TestBed.inject(OrganizationContext);
    const cleared = vi.fn();
    const unsubscribe = context.onChange(cleared);
    const before = context.capture();
    context.select('org-team');
    expect(context.organizationId()).toBe('org-team');
    expect(context.isCurrent(before)).toBe(false);
    expect(cleared).toHaveBeenCalledOnce();
    unsubscribe();
    context.reset();
    expect(cleared).toHaveBeenCalledOnce();
    expect(context.organizationId()).toBe('');
  });
});
