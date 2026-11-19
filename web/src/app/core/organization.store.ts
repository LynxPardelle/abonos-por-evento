import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { ApiClient } from './api';
import { OrganizationContext } from './organization-context';
import { Capability, MeResponse } from './organization.models';
import { requestError } from './request-error';
import { SessionService } from './session';

export const OrganizationStore = signalStore(
  { providedIn: 'root' },
  withState({ snapshot: undefined as MeResponse | undefined, busy: false, error: '' }),
  withComputed((store, context = inject(OrganizationContext)) => ({
    current: computed(() => store.snapshot()?.activeOrganizationId === context.organizationId() ? store.snapshot() : undefined),
    organization: computed(() => store.snapshot()?.activeOrganizationId === context.organizationId() ? store.snapshot()?.organization : undefined),
  })),
  withMethods((store, api = inject(ApiClient), context = inject(OrganizationContext), session = inject(SessionService)) => {
    let generation = 0;
    let loadedFor = '';
    let pending: Promise<boolean> | undefined;
    async function load(candidate?: string): Promise<boolean> {
      const requestGeneration = ++generation;
      patchState(store, { snapshot: undefined, busy: true, error: '' });
      if (candidate !== undefined) context.select(candidate);
      const epoch = context.capture();
      try {
        const me = await api.request<MeResponse>('GET', '/me');
        if (requestGeneration !== generation || !context.isCurrent(epoch)) return false;
        if (!me?.organization || me.organization.organizationId !== me.activeOrganizationId || !me.organizations?.some(item => item.organizationId === me.activeOrganizationId && item.status === 'active')) throw new Error('No se pudo verificar el acceso a la organización.');
        context.select(me.activeOrganizationId);
        loadedFor = session.local() ? 'local' : session.token();
        patchState(store, { snapshot: me });
        return true;
      } catch (error) {
        if (requestGeneration === generation && context.isCurrent(epoch)) patchState(store, { error: requestError(error) });
        return false;
      } finally { if (requestGeneration === generation) patchState(store, { busy: false }); }
    }
    return {
      can: (capability: Capability) => store.organization()?.capabilities[capability] === true,
      reload: () => load(),
      switchOrganization: (candidate: string) => load(candidate),
      returnHome: () => load(''),
      ensureLoaded: () => {
        const key = session.local() ? 'local' : session.token();
        if (!key) return Promise.resolve(false);
        if (loadedFor === key && store.current()) return Promise.resolve(true);
        if (pending) return pending;
        return pending = load().finally(() => { pending = undefined; });
      },
    };
  }),
);
