---
goal: Capacidades por tier de SaldoEvento sin activar facturación
version: '1.1'
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
| SUB-002 | Catálogo, planes por organización, resolver actual, GET /me, contexto validado y escritor administrativo IAM separado. | Implementado y probado localmente |
| SUB-003 | Cuotas de eventos en trabajo y personas con transacciones, concurrencia, replay y compatibilidad de datos existentes. | Implementado y probado localmente |
| SUB-004 | Cierre financiero, snapshot, reapertura recuperable y archivo que libera capacidad sin borrar historial. | Implementado y probado localmente |
| SUB-005 | CSV de reporte generado en backend con importes exactos y tratamiento seguro de texto de hojas de cálculo. | Implementado y probado localmente |
| SUB-006 | Plantillas de hasta 90 participantes, aplicación atómica a un evento nuevo y vista por moneda entre eventos. | Implementado y probado localmente |
| SUB-007 | Colaboradores con alta administrativa, organización personal conservada, roles/alcance y revocación por propietario. | Implementado y probado localmente; invitaciones diferidas |
| SUB-008 | Angular: plan/capacidad, plantillas, equipo y cierre; conservar navegación y flujos operativos existentes. | Implementado y probado localmente |
| SUB-009 | Pruebas Node/Angular, build SSR, contratos/IAM de infraestructura y recorrido integrado local de los tiers. | Completado localmente |
| SUB-010 | Revisión y entrega de la rama para promoción development → testing → main; acreditar cada ambiente sin reutilizar aceptación del piloto. | Revisión local completada; publicación y verificaciones AWS pendientes |

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

## Resultado del incremento local

Implementación en `codex/subscription-tiers`, basada en development `71140ec0`. El checkout original se conserva limpio en main `05b02f3`. La evaluación fija 1/5/20 eventos no archivados para Por Evento/Organizador/Equipo y 1/1/5 personas, incluido propietario y auditor. El piloto conserva sus funciones y no adquiere una nueva cuota comercial. No existe compra ni asignación de tiers desde HTTP; la herramienta IAM realiza vista previa por defecto. Las organizaciones administrativas antiguas sin base verificada requieren una migración antes de habilitar Equipo.

Pasaron 161 pruebas Node, 33 Angular, build SSR, paquete/smoke Lambda de cinco rutas, validador SAM y cfn-lint 1.60.1. Revisión independiente sin hallazgos altos o medios pendientes. En navegador se verificaron plan, plantilla y evento nuevo sin abonos copiados, abono de 500.00 MXN, cierre/reportes, archivo que libera cupo, reapertura que lo reserva y conserva historia, vista general y revocación con actualización de plazas. [Reporte local](../docs/verificacion/subscription-tiers-local-2026-11-19.json) y [detalle de verificaciones](../docs/VERIFICACION.md).

El primer paso pendiente es SUB-010: publicar el incremento por PR a development, desplegarlo y comprobar transacciones reales, permisos y asignación de evaluación con datos autorizados; promover después a testing con su recorrido humano. La producción del piloto permanece publicada y no se usa su aceptación para dar por verificado este incremento.
