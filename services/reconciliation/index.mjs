import { authorize } from '../shared/auth.mjs';
import { DomainError, handleError, json, parseBody, requestPath, validateId } from '../shared/http.mjs';
import { createReconciliationService } from './application.mjs';
import { createAwsDependencies } from './runtime.mjs';
import { resolveAccess } from '../shared/access.mjs';
export function createReconciliationHandler({ service, accessResolver = async (event, roles) => authorize(event, roles) }) {
  return async (event) => {
    try {
      const method = event?.requestContext?.http?.method;
      const path = requestPath(event);
      if (path === '/api/v1/overview' && method === 'GET') return json(200, await service.overview(await accessResolver(event, ['auditor'], { capability: 'viewOverview' })));
      const match = /^\/api\/v1\/events\/([^/]+)\/(imports|allocations|payments|balances|movements|closing|reopen|archive|report)(?:\/([^/]+))?(\/reversals)?$/.exec(path);
      if (!match) throw new DomainError(404, 'ROUTE_NOT_FOUND', 'No se encontró la ruta.');
      const eventId = validateId(match[1], 'eventId');
      const [, , area, resourceId, reversal] = match;
      const role = method === 'GET' ? ['auditor'] : ['closing', 'reopen', 'archive'].includes(area) ? ['operator'] : area === 'imports' ? ['importer'] : ['confirmer'];
      const capability = method === 'GET' ? area === 'report' && !resourceId ? 'exportEvent' : undefined : area === 'closing' ? 'closeEvent' : area === 'imports' ? 'importPayments' : area === 'allocations' || area === 'payments' ? 'confirmPayments' : area === 'movements' ? 'reversePayments' : undefined;
      const actor = await accessResolver(event, role, { eventId, ...(capability ? { capability } : {}) });
      if (area === 'closing' && !resourceId && method === 'GET') return json(200, await service.closing(actor, eventId));
      if (area === 'closing' && !resourceId && method === 'POST') return json(200, await service.close(actor, eventId, parseBody(event)));
      if (area === 'reopen' && !resourceId && method === 'POST') return json(200, await service.reopen(actor, eventId, parseBody(event)));
      if (area === 'archive' && !resourceId && method === 'POST') return json(200, await service.archive(actor, eventId, parseBody(event)));
      if (area === 'report' && !reversal && method === 'GET') return json(200, await service.report(actor, eventId, resourceId));
      if (area === 'imports' && !resourceId && method === 'POST') return json(201, await service.startImport(actor, eventId, parseBody(event)));
      if (area === 'imports' && !resourceId && method === 'GET') return json(200, await service.listImports(actor, eventId));
      if (area === 'imports' && resourceId && !reversal && method === 'GET') return json(200, await service.getImport(actor, eventId, resourceId));
      if (area === 'allocations' && !resourceId && method === 'POST') return json(200, await service.allocate(actor, eventId, parseBody(event)));
      if (area === 'payments' && !resourceId && method === 'POST') return json(200, await service.recordPayment(actor, eventId, parseBody(event)));
      if (area === 'balances' && !resourceId && method === 'GET') return json(200, await service.balances(actor, eventId));
      if (area === 'movements' && !resourceId && method === 'GET') return json(200, await service.movements(actor, eventId));
      if (area === 'movements' && resourceId && reversal && method === 'POST') return json(200, await service.reverse(actor, eventId, resourceId, parseBody(event)));
      throw new DomainError(404, 'ROUTE_NOT_FOUND', 'No se encontró la ruta.');
    } catch (error) { return handleError(error); }
  };
}
let defaultHandler;
export async function handler(event) {
  try { defaultHandler ??= createReconciliationHandler({ service: createReconciliationService(createAwsDependencies()), accessResolver: resolveAccess }); return await defaultHandler(event); }
  catch (error) { return handleError(error); }
}
