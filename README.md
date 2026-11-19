# SaldoEvento

**Cada abono en su lugar.** Conciliación de pagos externos y saldos por participante para organizadores de eventos.

Un operador crea el evento, registra participantes, importa un CSV, revisa coincidencias y confirma abonos. Los saldos se reconstruyen desde movimientos inmutables; un reverso conserva el abono original.

- [Producto](docs/PRODUCTO.md)
- [Arquitectura de microservicios](docs/architecture/ARCHITECTURE.md)
- [Decisión de marca y frontend Lambda](docs/architecture/2026-11-19-saldoevento-design.md)
- [Plan y estado de la primera versión](plan/feature-primera-version-1.md)
- [Contrato HTTP y CSV](docs/CONTRATO.md)
- [Operación y piloto](docs/OPERACION.md)
- [Promoción development → testing → main](docs/promocion.md)

## Estructura

| Unidad | Responsabilidad |
| --- | --- |
| `web/` | Angular 22, NgRx SignalStore y SSR en Lambda. |
| `services/events/` | Eventos y participantes, con tabla propia. |
| `services/reconciliation/` | Importaciones, ledger, saldos y worker asíncrono. |
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

Abre `http://localhost:4310`. El servidor local está limitado al loopback y usa una organización sintética y repositorios en memoria: reiniciarlo borra esos datos. Las Lambdas publicadas no incluyen este acceso local. Descarga el CSV de ejemplo desde Importaciones y registra primero las referencias de participantes correspondientes.

## Verificación

```powershell
npm test
npm run test:web
npm run build:web
npm run package:frontend
npm run validate:infra
```

`npm test` ejecuta pruebas Node de servicios, piloto y empaquetado. `npm run test:web` cubre Angular con Vitest. `package:frontend` prepara `artifacts/frontend` desde los bundles de producción. Los archivos de configuración públicos se generan en ejecución; los tokens no se escriben en el bundle.

Para validar SAM con cfn-lint instalado:

```powershell
cfn-lint infra/template.yaml
```

Las URLs previstas son `saldoevento-dev.lynxpardelle.com`, `saldoevento-test.lynxpardelle.com` y `saldoevento.lynxpardelle.com`. Consulta Operación para parámetros, despliegue y comprobaciones pendientes; esta configuración no acredita una publicación en la nube.
