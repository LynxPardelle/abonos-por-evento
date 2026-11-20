---
goal: Capacidades por tier de SaldoEvento sin activar facturación
version: '1.2'
date_created: 2026-11-19
last_updated: 2026-11-19
status: 'In progress'
tags: [feature, subscriptions, entitlements, serverless]
---

# Capacidades de evaluación por organización

Parte del piloto publicado y validado con cuenta real en producción. La evidencia del piloto no acredita este incremento nuevo. [Diseño y decisiones](../docs/architecture/2026-11-19-subscription-capabilities-design.md).

## Alcance

Asignación administrativa de evaluación, con catálogo versionado y capacidades reales para Por Evento, Organizador y Equipo. No hay compra, Stripe, Checkout, precios ni suscripciones cobradas. Se preservan los derechos básicos del piloto y sus registros. Equipo comienza con alta asistida IAM; invitaciones autoservicio y facturación tienen fases propias.

## Implementación

| Tarea | Resultado verificable | Estado |
| --- | --- | --- |
| SUB-001 | Registrar la publicación main 05b02f3, PR #10 y validación funcional real de producción en el plan anterior y evidencia durable sanitizada. | Completado |
| SUB-002 | Catálogo, planes por organización, resolver actual, GET /me, contexto validado y escritor administrativo IAM separado. | Implementado y validado en AWS/testing `d752d26` |
| SUB-003 | Cuotas de eventos en trabajo y personas con transacciones, concurrencia, replay y compatibilidad de datos existentes. | Implementado y validado en AWS/testing `d752d26` |
| SUB-004 | Cierre financiero, snapshot, reapertura recuperable y archivo que libera capacidad sin borrar historial. | Verificado en testing y aceptado con la cuenta del propietario |
| SUB-005 | CSV de reporte generado en backend con importes exactos y tratamiento seguro de texto de hojas de cálculo. | Verificado en testing; CSV histórico inmutable aceptado por UI |
| SUB-006 | Plantillas de hasta 90 participantes, aplicación atómica a un evento nuevo y vista por moneda entre eventos. | Implementado y validado en testing; plantilla sin dinero heredado aceptada |
| SUB-007 | Colaboradores con alta administrativa, organización personal conservada, roles/alcance y revocación por propietario. | Verificado en testing con colaborador temporal autorizado; invitaciones diferidas |
| SUB-008 | Angular: plan/capacidad, plantillas, equipo y cierre; conservar navegación y flujos operativos existentes. | Aceptación humana de testing completada |
| SUB-009 | Pruebas Node/Angular, build SSR, contratos/IAM de infraestructura y recorrido integrado de los tiers. | CI/testing aprobados: 171 Node, 34 Angular, despliegue y smokes AWS |
| SUB-010 | Revisión y entrega de la rama para promoción development → testing → main; acreditar cada ambiente sin reutilizar aceptación del piloto. | Development/testing y aceptación completados; main/producción aprobados, pendientes del comprobante de producción |

## Etapas posteriores

| Tarea | Dependencia | Estado |
| --- | --- | --- |
| SUB-011 | Invitaciones autoservicio por enlace, token de un uso, caducidad, aceptación autenticada y retorno OAuth seguro. | Pendiente; no anunciar disponible |
| SUB-012 | Auditoría ampliada de todas las acciones, exportación y administración; observabilidad y escala comercial. | Pendiente; no ofrecer auditoría universal/SLA |
| SUB-013 | Validación de precios/capacidad, derecho por periodo, facturación y webhooks idempotentes. | Pendiente; Stripe continúa desactivado |

## Criterios

- Un cliente no puede adjudicarse tier, propietario, organización ni permisos mediante claims, body o header.
- Dos operaciones que compiten por el último cupo no lo exceden; un replay no consume otra plaza/evento.
- Cierre y abono concurrentes no pueden producir un pago nuevo después de cerrar el mismo ledger.
- Archivo y reapertura no abren el ledger antes de reservar capacidad ni borran datos.
- Plantillas no copian dinero confirmado o identidades del evento original.
- Los importes agregados conservan su moneda; el CSV no permite ejecutar fórmulas desde nombres/referencias.
- La UI presenta el acceso actual y su asignación manual sin prometer compra ni funciones pendientes.
- No se modifica la producción publicada como efecto de una prueba local de funciones nuevas.

## Resultado local inicial (histórico)

Implementación en `codex/subscription-tiers`, basada en development `71140ec0`. El checkout original se conserva limpio en main `05b02f3`. La evaluación fija 1/5/20 eventos no archivados para Por Evento/Organizador/Equipo y 1/1/5 personas, incluido propietario y auditor. El piloto conserva sus funciones y no adquiere una nueva cuota comercial. No existe compra ni asignación de tiers desde HTTP; la herramienta IAM realiza vista previa por defecto. Las organizaciones administrativas antiguas sin base verificada requieren una migración antes de habilitar Equipo.

Pasaron 161 pruebas Node, 33 Angular, build SSR, paquete/smoke Lambda de cinco rutas, validador SAM y cfn-lint 1.60.1. Revisión independiente sin hallazgos altos o medios pendientes. En navegador se verificaron plan, plantilla y evento nuevo sin abonos copiados, abono de 500.00 MXN, cierre/reportes, archivo que libera cupo, reapertura que lo reserva y conserva historia, vista general y revocación con actualización de plazas. [Reporte local](../docs/verificacion/subscription-tiers-local-2026-11-19.json) y [detalle de verificaciones](../docs/VERIFICACION.md).

SUB-010 completó development y testing mediante los PR #11 a #14. El commit testing `d752d26c23b8afcc60ef13c64b5f2c4166162e48` aprobó CI (171 pruebas Node y 34 Angular), despliegue UPDATE_COMPLETE, verificación pública y smokes AWS de transacciones y permisos. [Comprobante del despliegue](https://github.com/LynxPardelle/abonos-por-evento/pull/14#issuecomment-7025587666). El siguiente paso es la promoción autorizada a main y su comprobante de producción; no se usa la aceptación del piloto para acreditar este incremento.

## Promoción autorizada a testing

El propietario autorizó subir e integrar este incremento a development, promoverlo y desplegarlo en testing con sus verificaciones. Esa entrega se completó y se validaron los tiers con su cuenta. Los resultados locales anteriores se conservan como evidencia de desarrollo.

La preparación añadió la ruta HTTP individual de evento utilizada por Cierre y reportes y una regresión de contexto que impide restaurar un lote CSV de otra organización tras un PUT pendiente. El smoke exclusivo de testing usa dos identidades temporales sin correos, recorre las asignaciones de evaluación y comprueba revocación con el mismo JWT; no modifica cuentas ni recursos de producción.

## Aceptación de testing y autorización de producción

La aceptación con la cuenta del propietario terminó el 19 de noviembre de 2026 (20 de noviembre 00:36Z). Se creó una plantilla con dos participantes y se aplicó a un evento nuevo sin copiar dinero. El primer cierre conservó 1250.00 MXN confirmados, 750.00 pendientes y dos movimientos; archivo y reapertura liberaron/reservaron capacidad sin perder historia. Un segundo cierre registró 1500.00 confirmados, 500.00 pendientes y tres movimientos. El CSV del primer cierre siguió siendo idéntico después del segundo.

Los roles auditor, confirmer y operator se probaron con un colaborador temporal limitado al evento sintético nuevo. La revocación rechazó el mismo JWT sin refrescarlo y conservó su organización personal. El colaborador quedó revocado y se eliminó la identidad temporal; sólo permaneció la cuenta original. [Evidencia sanitizada de aceptación](../docs/verificacion/testing-tiers-owner-2026-11-19.json).

Después de esta validación, el propietario **aprobó expresamente testing → main y el despliegue en saldoevento.zooberiahsystems.com**, con Stripe desactivado. La preparación conserva el dominio anterior como alias compatible, el pool/cliente Cognito, tablas, buckets y datos. El change set debe impedir reemplazos o eliminaciones de esos recursos. [Procedimiento de producción](../docs/runbooks/production-promotion.md). El comprobante del PR de producción registrará CI, commit, artefacto, recursos preservados, DNS/TLS y verificación pública; hasta entonces la publicación del incremento en producción sigue pendiente. Las invitaciones, precios y facturación permanecen diferidos.
