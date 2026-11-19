# SaldoEvento

**Cada abono en su lugar.** Conciliación de pagos externos y saldos por participante para organizadores de eventos.

La landing pública explica el producto y permite empezar con una cuenta de piloto. Una vez dentro, un operador crea el evento, registra participantes, importa un CSV, revisa coincidencias y confirma abonos. Los saldos se reconstruyen desde movimientos inmutables; un reverso conserva el abono original.

| Ruta | Uso |
| --- | --- |
| `/` | Sitio comercial: recorrido ilustrativo, capacidades actuales, planes en diseño y preguntas frecuentes. |
| `/registro` | Pantalla de alta del piloto; abre Cognito cuando el registro está habilitado en el ambiente. |
| `/app` | Espacio operativo de eventos para la cuenta autenticada o el modo local sintético. |
| `/auth/callback` | Completa Authorization Code con PKCE y vuelve a `/app`. |

El registro nuevo crea una organización aislada desde el servidor. El piloto no requiere tarjeta. Por Evento, Organizador y Equipo son propuestas comerciales; no hay suscripciones de pago, cuotas comerciales ni cobros Stripe activos.

- [Producto](docs/PRODUCTO.md)
- [Planes y capacidades propuestas](docs/PLANES.md)
- [Arquitectura de microservicios](docs/architecture/ARCHITECTURE.md)
- [Decisión de marca y frontend Lambda](docs/architecture/2026-11-19-saldoevento-design.md)
- [Diseño del sitio comercial y registro](docs/architecture/2026-11-19-commercial-site-design.md)
- [Plan y estado de la primera versión](plan/feature-primera-version-1.md)
- [Contrato HTTP y CSV](docs/CONTRATO.md)
- [Operación y piloto](docs/OPERACION.md)
- [Promoción development → testing → main](docs/promocion.md)
- [Entrega y verificación de testing](docs/runbooks/testing-promotion.md)

## Estructura

| Unidad | Responsabilidad |
| --- | --- |
| `web/` | Angular 22, NgRx SignalStore y SSR en Lambda. |
| `services/events/` | Eventos y participantes, con tabla propia. |
| `services/reconciliation/` | Importaciones, ledger, saldos y worker asíncrono. |
| `services/identity/` | Membresías por pool/sujeto; PostConfirmation y PreTokenGeneration de Cognito. |
| `services/shared/` | Validación HTTP y autorización sin datos de negocio compartidos. |
| `infra/template.yaml` | AWS SAM: Lambda, HTTP API JWT, Cognito, DynamoDB, S3, SQS/DLQ, CloudFront y dominio. |

El nombre técnico histórico de la carpeta y de `origin` puede seguir siendo `abonos-por-evento`; la marca y los recursos nuevos usan `SaldoEvento`/`saldoevento`.

## Desarrollo local

Requiere Node.js **24.15 o superior dentro de la línea 24**, npm y dos terminales. Desde la raíz:

```powershell
npm ci
npm --prefix services ci
npm --prefix web ci
npm run dev:api
```

En otra terminal:

```powershell
npm --prefix web start
```

Abre `http://localhost:4310` para ver la landing y entra a `/app` para usar el ejemplo. El servidor local está limitado al loopback y usa una organización sintética y repositorios en memoria: reiniciarlo borra esos datos. El modo local no crea cuentas Cognito ni envía correos. Las Lambdas publicadas no incluyen este acceso local. Descarga el CSV de ejemplo desde Importaciones y registra primero las referencias de participantes correspondientes.

## Verificación

```powershell
npm test
npm run test:web
npm run build:web
npm run package:frontend
npm run smoke:frontend
npm run validate:infra
```

`npm test` ejecuta pruebas Node de servicios, piloto y empaquetado. `npm run test:web` cubre Angular con Vitest. `package:frontend` prepara `artifacts/frontend` desde los bundles de producción. Los archivos de configuración públicos se generan en ejecución; los tokens no se escriben en el bundle.

Para validar SAM con cfn-lint instalado:

```powershell
cfn-lint infra/template.yaml infra/artifacts.yaml
```

La implementación local de landing y registro aprobó **86 pruebas Node, 15 Angular y el build SSR**. La ejecución remota se acredita por el último commit de los PR y los reportes de cada ambiente, no por esos resultados locales: [PR hacia development](https://github.com/LynxPardelle/abonos-por-evento/pulls?q=is%3Apr+base%3Adevelopment), [promoción a testing](https://github.com/LynxPardelle/abonos-por-evento/pulls?q=is%3Apr+base%3Atesting) y [CI](https://github.com/LynxPardelle/abonos-por-evento/actions/workflows/ci.yml).

Los destinos de los ambientes son `saldoevento-dev.lynxpardelle.com`, `saldoevento-test.lynxpardelle.com` y `saldoevento.lynxpardelle.com`. [Operación](docs/OPERACION.md) describe los change sets y los reportes bajo `artifacts/deployments/dev/` y `artifacts/deployments/test/`. **`main` y producción quedan pendientes hasta la prueba del propietario con su cuenta y una instrucción posterior.** El [historial de verificación de la base](docs/VERIFICACION.md) conserva la evidencia del despliegue anterior y no sustituye las comprobaciones de esta entrega.
