import { AngularNodeAppEngine, createNodeRequestHandler, isMainModule, writeResponseToNodeResponse } from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';

export const app = express();
const configuredHost = process.env['PUBLIC_ORIGIN'] ? new URL(process.env['PUBLIC_ORIGIN']).hostname : '';
const angular = new AngularNodeAppEngine({
  allowedHosts: ['localhost', '127.0.0.1', ...(configuredHost ? [configuredHost] : [])],
  // The Lambda adapter replaces both headers with PUBLIC_ORIGIN before Express sees them.
  trustProxyHeaders: configuredHost ? ['x-forwarded-host', 'x-forwarded-proto'] : false,
});
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.get('/runtime-config.json', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    mode: 'cloud',
    cognitoDomain: process.env['COGNITO_DOMAIN'] ?? '',
    clientId: process.env['COGNITO_CLIENT_ID'] ?? '',
    region: process.env['AWS_REGION'] ?? '',
  });
});
app.use(express.static(join(import.meta.dirname, '../browser'), { maxAge: '1y', index: false, redirect: false }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  if (req.path.startsWith('/api/')) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada.' } }); return; }
  angular.handle(req).then(response => response ? writeResponseToNodeResponse(response, res) : next()).catch(next);
});
if (isMainModule(import.meta.url)) {
  const port = Number(process.env['PORT'] ?? 4300);
  app.listen(port, '127.0.0.1', () => console.log(`SaldoEvento SSR http://127.0.0.1:${port}`));
}
export const reqHandler = createNodeRequestHandler(app);
