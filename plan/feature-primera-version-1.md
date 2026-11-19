---
goal: Primera versión de SaldoEvento en microservicios AWS con Angular Lambda
version: '2.0'
date_created: 2026-11-17
last_updated: 2026-11-19
status: 'In progress'
tags: [feature, architecture, serverless, angular]
---

# Introduction

Estado **In progress**. El producto adopta SaldoEvento y una arquitectura de microservicios serverless con Angular SSR servido por Lambda. Las implementaciones locales tienen pruebas; las validaciones AWS y la aceptación de un organizador se registran separadamente. La promoción es **development → testing → main**.

## 1. Requirements & Constraints

- **REQ-001** Crear evento y participantes; importar CSV; revisar evidencia; confirmar abonos; consultar saldos; reversar conservando el original. Admitir también abono manual con comprobante de referencia única.
- **REQ-002** Usar la marca SaldoEvento y los subdominios saldoevento-dev, saldoevento-test y saldoevento bajo lynxpardelle.com.
- **SEC-001** HTTP API verifica JWT Cognito; los servicios comprueban identidad, organización y rol. El cliente no puede modificar organización ni roles. El dominio Eventos posee una tabla y Conciliación otra.
- **SEC-002** S3 privado cifrado, URL PUT con checksum esperado, SQS con DLQ y fallos parciales. No registrar tokens, referencias completas ni CSV en logs.
- **CON-001** Importes enteros transmitidos como cadenas; una moneda por evento (MXN/USD/EUR). Reintentos conservan el resultado o devuelven conflicto si cambia la solicitud. Las escrituras concurrentes usan versión.
- **CON-002** Los ejemplos y los pilotos automáticos usan datos sintéticos. La aceptación con datos de un organizador requiere su escenario autorizado.
- **PAT-001** Angular standalone, rutas lazy, Signal Forms y SignalStore por flujo. Frontend SSR/Express en Lambda, Function URL IAM y CloudFront OAC; assets S3 privado y API sin caché.
- **PAT-002** Desarrollo sigue development, pruebas testing y producción main. La implementación se prepara en una rama feature basada en development y no cambia la rama main del checkout original.

## 2. Implementation Steps

### Implementation Phase 1

**GOAL-001** Marca, contratos y arquitectura explícita.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-005 | Adoptar SaldoEvento en README, producto, interfaz, paquetes y recursos nuevos; documentar criterio de nombre y conservar la ubicación histórica del repositorio. | Implementado | 2026-11-19 |
| TASK-006 | Definir servicios Eventos/Conciliación y worker; Angular SSR Lambda detrás de CloudFront; S3 de assets; dominios por Stage; zona/certificado parametrizados. Crear docs/architecture/2026-11-19-saldoevento-design.md y actualizar ARCHITECTURE.md/diagram.mmd/ADR. | Implementado y validado localmente | 2026-11-19 |

### Implementation Phase 2

**GOAL-002** Libro de movimientos exacto y persistente.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | Crear services/reconciliation/domain/ledger.mjs con abono/reverso puros, enteros BigInt, moneda única, IDs de operación/rubro, idempotencia, duplicados y versión. Persistir movimiento, metadata, proyección y fila de batch en transacción DynamoDB; cada movimiento tiene ítem propio. Probar saldo/reverso/duplicados/moneda/OCC y adaptador inyectado. | Implementado y probado localmente | 2026-11-19 |

### Implementation Phase 3

**GOAL-003** Importación y permisos en microservicios.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-002 | Implementar services/events, services/shared y servicios/worker de Conciliación, autenticación/roles, hash de archivo, CSV y sugerencias persistidas. Declarar JWT, Cognito, S3 privado con caducidad, SQS/DLQ y tablas separadas en infra/template.yaml. Probar aislamiento, filas rechazadas, reenvío y replay. | Implementado; pruebas locales aprobadas; smoke AWS se registra en TASK-008 | 2026-11-19 |
| TASK-007 | Exponer registro manual autenticado POST payments con participante, referencia, importe y versión; impedir referencias duplicadas y confirmar permiso confirmer/operator/admin. | Implementado y probado localmente | 2026-11-19 |

### Implementation Phase 4

**GOAL-004** Frontend operativo y empaquetado Lambda.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-003 | Implementar rutas de eventos, participantes/saldos, importaciones y movimientos en web/src/app/features/workspace; SignalStore por ruta, servicios HTTP y acceso PKCE. Mostrar evidencia, confirmación explícita, errores de lote y progreso; recargar desde backend sin aplicar sugerencias automáticamente. | Implementado; recorrido navegador verificado | 2026-11-19 |
| TASK-010 | Construir SSR, empaquetar artifacts/frontend con serverless-http y manifiesto con hashes, probar el handler Lambda real y validar host/caché. Añadir CI sin despliegue automático. | Completado; SSR local y AWS aprobados | 2026-11-19 |

### Implementation Phase 5

**GOAL-005** Piloto y desarrollo AWS.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | Ejecutar services/reconciliation/pilot.mjs con CSV sintético: dos abonos, reverso, referencia ambigua, fila rechazada, duplicado y fallo/replay simulado. Esperar 75000 unidades menores MXN y cero discrepancias; ejecutar también el recorrido HTTP local y navegador con recarga. | Piloto sintético local aprobado | 2026-11-19 |
| TASK-008 | Revisar y ejecutar change set nuevo saldoevento-dev mediante Deploy-Development.ps1; publicar assets; ejecutar smoke-cloud.mjs con usuarios temporales sintéticos y correos suprimidos. Verificar Cognito/JWT, IAM, DynamoDB, S3 checksum, SQS, ledger, tenant y roles. Guardar reporte sanitizado en docs/verificacion/development-2026-11-19.json. | Completado en AWS development; 12 checks aprobados | 2026-11-19 |
| TASK-009 | Provisionar usuario real/organización, ejecutar escenario autorizado del organizador, revisar cierre/métricas/alertas y promover PR development → testing → main. Publicar saldoevento.lynxpardelle.com después de verificación de testing. | Pendiente | |

## 3. Alternatives

- **ALT-001** SPA sólo S3: menor complejidad, pero no cumple el frontend mediante Lambda solicitado.
- **ALT-002** Contenedor permanente: reservar para carga sostenida o bibliotecas pesadas.
- **ALT-003** Step Functions por batch: reservar para varias etapas con historial y recuperación independientes.

## 4. Dependencies

- **DEP-001** Node.js 24, Angular Core 22.2.6, CLI/SSR 22.2.7 y NgRx Signals 22.0.1; dependencias reproducibles en tres lockfiles.
- **DEP-002** AWS SAM/CloudFormation, HTTP API, Cognito, Lambda, DynamoDB bajo demanda, S3, SQS y CloudFront.
- **DEP-003** Zona pública lynxpardelle.com y certificado wildcard ACM us-east-1 verificados el 19 de noviembre de 2026; parámetros públicos por ambiente en infra/environments.

## 5. Files

- **FILE-001** infra/template.yaml y infra/artifacts.yaml; parámetros en infra/environments.
- **FILE-002** services/events, services/reconciliation y services/shared; pruebas y fixture sintéticos.
- **FILE-003** web/src/app/core, features/workspace, server.ts, main.server.ts y configuración SSR.
- **FILE-004** scripts/package-frontend.mjs, validate-infra.mjs, local-api.mjs, smoke-frontend.mjs, smoke-cloud.mjs y Deploy-Development.ps1.
- **FILE-005** docs/CONTRATO.md, OPERACION.md y VERIFICACION.md; workflow CI y controles de promoción existentes.

## 6. Testing

- **TEST-001** npm test: reglas, auth, repositorios, worker, contratos, piloto, API local e infraestructura.
- **TEST-002** npm run test:web: dinero exacto, estado Angular, errores y sesión. Recorrido navegador confirma que un abono requiere revisión y el saldo persiste tras recarga del cliente.
- **TEST-003** npm run build:web; package:frontend; smoke:frontend; validate:infra; cfn-lint de ambos templates.
- **TEST-004** Smoke AWS development debe acreditar configuración, HTML, autenticación y datos reales de servicios con registros exclusivamente sintéticos. Distinguir fallo/replay simulado de prueba de DLQ real.

## 7. Risks & Assumptions

- **RISK-001** Límite del piloto: CSV de 1 MiB/500 filas y batch serializado de 300000 bytes. Un lote mayor debe dividirse; los errores quedan visibles.
- **RISK-002** Consultas de ledger y participantes cargan el conjunto del evento en memoria; una escala superior al piloto requiere paginación pública y proyecciones de consulta más específicas.
- **RISK-003** La marca se eligió con búsqueda pública editorial; no se afirma exclusividad registral. El repositorio remoto conserva su nombre técnico histórico.
- **ASSUMPTION-001** Un organizador aportará un escenario y datos autorizados para aceptación. El piloto sintético y un despliegue dev no sustituyen esa aceptación.
- **ASSUMPTION-002** Los cambios en producción siguen la promoción por ramas y no forman parte de una publicación directa desde feature.

## 8. Related Specifications / Further Reading

- [Producto](../docs/PRODUCTO.md)
- [Arquitectura](../docs/architecture/ARCHITECTURE.md)
- [Contrato](../docs/CONTRATO.md)
- [Operación](../docs/OPERACION.md)
- [Decisión de diseño](../docs/architecture/2026-11-19-saldoevento-design.md)
