---
goal: Primera versión de SaldoEvento en microservicios AWS con Angular Lambda
version: '4.0'
date_created: 2026-11-17
last_updated: 2026-11-19
status: 'Complete'
tags: [feature, architecture, serverless, angular]
---

# Introduction

Estado **Complete para la primera versión del piloto**. SaldoEvento está publicado en https://saldoevento.lynxpardelle.com desde main `05b02f31563d88285d22b5085d69d3ba757e6675`, después de los PR #8, #9 y #10 por la cadena development → testing → main. El propietario completó el registro y el flujo real con datos sintéticos en testing y producción: evento, participantes, CSV, dos confirmaciones, saldos, reverso e historial tras recarga. El resultado final fue 750.00 MXN confirmados y 1250.00 MXN pendientes. Stripe y Checkout permanecen desactivados. Las capacidades nuevas por tier se desarrollan en un [plan independiente](feature-subscription-tiers-1.md) y requieren su propia verificación antes de publicarse.

## 1. Requirements & Constraints

- **REQ-001** Crear evento y participantes; importar CSV; revisar evidencia; confirmar abonos; consultar saldos; reversar conservando el original. Admitir también abono manual con comprobante de referencia única.
- **REQ-002** Usar la marca SaldoEvento y los subdominios saldoevento-dev, saldoevento-test y saldoevento bajo lynxpardelle.com.
- **REQ-003** Publicar el sitio comercial en `/`, la pantalla de alta en `/registro` y el espacio operativo en `/app`; conservar enlaces profundos a eventos y callback PKCE.
- **REQ-004** Ofrecer un piloto sin tarjeta y presentar Por Evento, Organizador y Equipo como propuestas en diseño, sin precios ni cobros activos.
- **SEC-001** HTTP API verifica JWT Cognito; los servicios comprueban identidad, organización y rol. El cliente no puede modificar organización ni roles. El dominio Eventos posee una tabla y Conciliación otra.
- **SEC-002** S3 privado cifrado, URL PUT con checksum esperado, SQS con DLQ y fallos parciales. No registrar tokens, referencias completas ni CSV en logs.
- **SEC-003** El registro exige correo verificado y membresía asignada por servidor. PostConfirmation/PreToken usan IdentityTable por pool/sujeto, creación condicional y claims no elegibles por cliente. La membresía persistida es autoritativa y los tokens vigentes caducan en 15 minutos.
- **CON-001** Importes enteros transmitidos como cadenas; una moneda por evento (MXN/USD/EUR). Reintentos conservan el resultado o devuelven conflicto si cambia la solicitud. Las escrituras concurrentes usan versión.
- **CON-002** Los ejemplos y los pilotos automáticos usan datos sintéticos. La aceptación con datos de un organizador requiere su escenario autorizado.
- **CON-003** Stripe, Checkout, entitlements pagados, precios e invitaciones de equipo permanecen pendientes. Un registro no contrata un tier futuro ni programa un cargo.
- **PAT-001** Angular standalone, rutas lazy, Signal Forms y SignalStore por flujo. Frontend SSR/Express en Lambda, Function URL IAM y CloudFront OAC; assets S3 privado y API sin caché.
- **PAT-002** Desarrollo sigue development, pruebas testing y producción main. La implementación se prepara en una rama feature basada en development; cada promoción se realiza mediante PR con verificaciones y la publicación requiere autorización.

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
| TASK-010 | Construir SSR, empaquetar artifacts/frontend con serverless-http y manifiesto con hashes, probar el handler Lambda real y validar host/caché. Añadir CI sin despliegue automático. | Base SSR aprobada local/AWS; la entrega nueva se acredita en TASK-014 | 2026-11-19 |

### Implementation Phase 5

**GOAL-005** Piloto y desarrollo AWS.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | Ejecutar services/reconciliation/pilot.mjs con CSV sintético: dos abonos, reverso, referencia ambigua, fila rechazada, duplicado y fallo/replay simulado. Esperar 75000 unidades menores MXN y cero discrepancias; ejecutar también el recorrido HTTP local y navegador con recarga. | Piloto sintético local aprobado | 2026-11-19 |
| TASK-008 | Verificar la base de conciliación en AWS development: change set, assets, Cognito/JWT, IAM, DynamoDB, S3 checksum, SQS, ledger, tenant y roles. Conservar el reporte histórico docs/verificacion/development-2026-11-19.json; la nueva entrega se acredita por TASK-014. | Base anterior completada en AWS development; 12 checks históricos aprobados | 2026-11-19 |

### Implementation Phase 6

**GOAL-006** Sitio comercial y registro del piloto.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-011 | Implementar landing `/`, recorrido ilustrativo, funciones actuales, preguntas y CTA a `/registro`; mantener `/app` y enlaces operativos. Verificar SSR, rutas, controles y estados de registro con pruebas Angular. | Completado localmente; build y pruebas aprobados | 2026-11-19 |
| TASK-012 | Implementar services/identity con IdentityTable, PostConfirmation y PreTokenGeneration V1; derivar organización/rol servidor, ignorar clientMetadata, verificar correo, idempotencia y aislamiento. Añadir signup Cognito, flag público y callback PKCE a `/app`. | Completado localmente; pruebas de identidad y Session aprobadas | 2026-11-19 |
| TASK-013 | Diseñar Piloto/Por Evento/Organizador/Equipo en docs/PLANES.md, separar capacidades presentes de propuestas, definir hipótesis de cuotas y criterios para vender. No publicar precios ni activar Stripe o planes pagados. | Completado como diseño; no hay venta ni cuotas comerciales activas | 2026-11-19 |

### Implementation Phase 7

**GOAL-007** Entrega verificable de development a testing.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-014 | Subir la rama feature, crear e integrar PR a development tras comprobar su HEAD; promover development → testing con merge commit y checks. Usar Deploy-Testing.ps1 con commit remoto/artefacto verificados y change set revisado; probar landing/registro y smoke-testing.mjs con cuentas sintéticas y limpieza. | Completado: PR #8 a development y #9 a testing integrados; CI y 13 checks cloud por ambiente aprobados, cuatro identidades temporales retiradas por ambiente | 2026-11-19 |

Estado remoto de TASK-014: [PR a development](https://github.com/LynxPardelle/abonos-por-evento/pulls?q=is%3Apr+base%3Adevelopment), [PR a testing](https://github.com/LynxPardelle/abonos-por-evento/pulls?q=is%3Apr+base%3Atesting) y [CI](https://github.com/LynxPardelle/abonos-por-evento/actions/workflows/ci.yml). Los reportes del commit desplegado se guardan en `artifacts/deployments/dev/cloud-smoke.json` y `artifacts/deployments/test/cloud-smoke.json`. [Procedimiento y criterios de cierre](../docs/runbooks/testing-promotion.md). No se infiere aprobación cloud de las pruebas locales ni del historial de la base anterior.

### Implementation Phase 8

**GOAL-008** Aceptación real, publicación autorizada y validación de producción.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-009 | El propietario completa el registro y acceso PKCE con su cuenta; ejecutar el escenario autorizado, recibir la aprobación de producción y promover a main con verificaciones. | Completado: aceptación testing, aprobación explícita, PR #10 integrado y producción CREATE_COMPLETE; cuenta real y recorrido funcional de producción completados con persistencia tras recargas | 2026-11-19 |

Evidencia durable: [validación de producción](../docs/verificacion/production-2026-11-19.json). [PR #10 y comprobante de publicación](https://github.com/LynxPardelle/abonos-por-evento/pull/10#issuecomment-7023051899). La verificación pública previa cubrió cuatro rutas SSR, doce assets con hashes correctos, salud, configuración, Cognito y dos rechazos 401. La aceptación posterior con cuenta real acredita el flujo autenticado y se distingue de aquellos GET de sólo lectura. No se guardan correo, contraseña, OTP, tokens, cookies ni identificadores de la cuenta en el reporte versionado.

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
- **FILE-006** services/identity y web/src/app/core/session.ts; landing/registro en web/src/app/features/marketing y rutas `/`, `/registro`, `/app`.
- **FILE-007** docs/PLANES.md, diseño comercial, scripts/Deploy-Testing.ps1, scripts/smoke-testing.mjs y docs/runbooks/testing-promotion.md.

## 6. Testing

- **TEST-001** npm test: reglas, auth, repositorios, worker, contratos, piloto, API local e infraestructura.
- **TEST-002** npm run test:web: dinero exacto, estado Angular, errores y sesión. Recorrido navegador confirma que un abono requiere revisión y el saldo persiste tras recarga del cliente.
- **TEST-003** npm run build:web; package:frontend; smoke:frontend; validate:infra; cfn-lint de ambos templates.
- **TEST-004** Smoke AWS development debe acreditar configuración, HTML, autenticación y datos reales de servicios con registros exclusivamente sintéticos. Distinguir fallo/replay simulado de prueba de DLQ real.
- **TEST-005** La entrega de landing/registro cuenta con 86 pruebas Node, 15 Angular y build SSR aprobados localmente. La CI debe repetir las verificaciones para el HEAD que se integre.
- **TEST-006** Smoke dev/test valida una cuenta sin atributos administrativos: organización derivada por servidor, admin de su propio tenant y piloto; comprueba aislamiento, flujo de conciliación y retirada de identidades temporales. La entrega real del correo y el recorrido de la persona se reservan a TASK-009.

## 7. Risks & Assumptions

- **RISK-001** Límite del piloto: CSV de 1 MiB/500 filas y batch serializado de 300000 bytes. Un lote mayor debe dividirse; los errores quedan visibles.
- **RISK-002** Consultas de ledger y participantes cargan el conjunto del evento en memoria; una escala superior al piloto requiere paginación pública y proyecciones de consulta más específicas.
- **RISK-003** La marca se eligió con búsqueda pública editorial; no se afirma exclusividad registral. El repositorio remoto conserva su nombre técnico histórico.
- **RISK-004** Una modificación de atributos legacy Cognito no revoca una membresía persistida; se administra en IdentityTable. Los ID tokens emitidos pueden conservar acceso hasta 15 minutos.
- **RISK-005** Los tiers pagados son diseño: sus cuotas, exportación, invitaciones, ciclo de cierre y facturación requieren implementación/validación antes de ofrecerse como prestaciones.
- **ASSUMPTION-001** Un organizador aportará un escenario y datos autorizados para aceptación. El piloto sintético y un despliegue dev no sustituyen esa aceptación.
- **ASSUMPTION-002** Los cambios en producción siguen la promoción por ramas y no forman parte de una publicación directa desde feature.

## 8. Related Specifications / Further Reading

- [Producto](../docs/PRODUCTO.md)
- [Arquitectura](../docs/architecture/ARCHITECTURE.md)
- [Contrato](../docs/CONTRATO.md)
- [Operación](../docs/OPERACION.md)
- [Decisión de diseño](../docs/architecture/2026-11-19-saldoevento-design.md)
- [Sitio comercial y registro](../docs/architecture/2026-11-19-commercial-site-design.md)
- [Planes propuestos](../docs/PLANES.md)
- [Identidad](../services/identity/README.md)
- [Promoción y verificación testing](../docs/runbooks/testing-promotion.md)
