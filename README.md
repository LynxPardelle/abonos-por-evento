# SaldoEvento

**Cada abono en su lugar.** Conciliación de pagos externos y saldos por participante para organizadores de eventos.

La landing pública explica el producto y permite empezar con una cuenta de piloto. Una vez dentro, un operador crea el evento, registra participantes, importa un CSV, revisa coincidencias y confirma abonos. Los saldos se reconstruyen desde movimientos inmutables; un reverso conserva el abono original.

| Ruta | Uso |
| --- | --- |
| `/` | Sitio comercial: recorrido ilustrativo, capacidades actuales, planes en diseño y preguntas frecuentes. |
| `/registro` | Pantalla de alta del piloto; abre Cognito cuando el registro está habilitado en el ambiente. |
| `/app` | Espacio operativo de eventos para la cuenta autenticada o el modo local sintético. |
| `/app/plan`, `/app/plantillas`, `/app/equipo` | Acceso y capacidad, preparación reutilizable y colaboradores del incremento de evaluación. |
| `/eventos/{eventId}/cierre` | Cierre financiero, reportes históricos, archivo y reapertura. |
| `/auth/callback` | Completa Authorization Code con PKCE y vuelve a `/app`. |

El registro nuevo crea una organización aislada desde el servidor. El piloto no requiere tarjeta. **La primera versión está publicada y validada con la cuenta del propietario en producción**, desde `main` `05b02f3` mediante [PR #10](https://github.com/LynxPardelle/abonos-por-evento/pull/10). [Evidencia sanitizada](docs/verificacion/production-2026-11-19.json).

Esta rama añade capacidades de evaluación para Por Evento, Organizador y Equipo: cierre/exportación, plantillas, vista entre eventos y colaboración administrada. La asignación se realiza con IAM; los cupos se aplican en backend. **El incremento está verificado localmente y todavía no está desplegado.** No hay compra, precios aprobados, suscripciones cobradas ni Stripe activo.

- [Producto](docs/PRODUCTO.md)
- [Planes y capacidades de evaluación](docs/PLANES.md)
- [Plan del incremento de suscripciones](plan/feature-subscription-tiers-1.md)
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
| `services/events/` | Eventos, participantes, cupo y plantillas, con tabla propia. |
| `services/reconciliation/` | Importaciones, ledger, cierres/reportes, vista por moneda y worker asíncrono. |
| `services/identity/` | Membresías, planes de evaluación y permisos actuales; triggers Cognito, resolver de lectura y administrador IAM separados. |
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

Abre `http://localhost:4310` para ver la landing y entra a `/app` para usar el ejemplo. El servidor local está limitado al loopback y usa una organización sintética con evaluación Equipo y un colaborador auditor para probar las pantallas nuevas. Los repositorios están en memoria: reiniciarlo borra esos datos. El modo local no crea cuentas Cognito ni envía correos. Las Lambdas publicadas no incluyen este acceso local. Descarga el CSV de ejemplo desde Importaciones y registra primero las referencias de participantes correspondientes.

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

El incremento de evaluación aprobó **161 pruebas Node, 33 Angular y el build SSR**. El [registro de verificación](docs/VERIFICACION.md) distingue la aceptación real de producción del incremento local. La ejecución remota se acredita por el commit de los PR y los reportes de cada ambiente: [PR hacia development](https://github.com/LynxPardelle/abonos-por-evento/pulls?q=is%3Apr+base%3Adevelopment), [promoción a testing](https://github.com/LynxPardelle/abonos-por-evento/pulls?q=is%3Apr+base%3Atesting) y [CI](https://github.com/LynxPardelle/abonos-por-evento/actions/workflows/ci.yml).

Los ambientes son `saldoevento-dev.lynxpardelle.com`, `saldoevento-test.lynxpardelle.com` y [saldoevento.lynxpardelle.com](https://saldoevento.lynxpardelle.com). El piloto completó development → testing → main con aprobación del propietario. El nuevo incremento debe recorrer esa secuencia con sus propias verificaciones antes de publicarse; la aceptación del piloto conserva su alcance original.
