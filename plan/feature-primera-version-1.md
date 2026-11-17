---
goal: Primera versión de Abonos por Evento
version: '1.0'
date_created: 2026-11-17
status: 'Planned'
tags: [feature, architecture]
---

# Introduction

Estado **Planned**. Este plan convierte el esqueleto en el flujo de conciliación de pagos externos, abonos y saldos por participante. Las fases se ejecutan en orden.

## 1. Requirements & Constraints

- **REQ-001** El piloto completa el flujo descrito en [Producto](../docs/PRODUCTO.md).
- **SEC-001** Cada operación de negocio valida identidad, organización y acceso al recurso. Los ejemplos del repositorio usan datos sintéticos.
- **CON-001** Las escrituras repetidas conservan el resultado original o devuelven conflicto cuando cambia la solicitud.
- **PAT-001** El frontend usa componentes standalone, rutas lazy y SignalStore por flujo. El cómputo del backend se cobra por uso.

## 2. Implementation Steps

### Implementation Phase 1

**GOAL-001** Libro de movimientos

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | Crear services/reconciliation/domain/ledger.mjs con abono y reverso como operaciones puras de importes enteros y una sola moneda por evento. Usar identificadores de rubro y operación. Verificación. Las pruebas sintéticas verifican saldo, reverso, duplicados y desfase de moneda. | Pendiente | |

### Implementation Phase 2

**GOAL-002** Importación y permisos

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-002 | Agregar servicios services/events y services/reconciliation al template. Configurar HTTP API JWT, S3 privado con caducidad, SQS con DLQ y DynamoDB bajo demanda. Persistir estados de batch y huella del archivo antes de producir sugerencias. Verificación. El mismo archivo reenviado registra un batch lógico. Las filas rechazadas quedan visibles y dos organizaciones no pueden acceder a los mismos datos. | Pendiente | |

### Implementation Phase 3

**GOAL-003** Revisión Angular

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-003 | Agregar rutas y SignalStores de importación y asistentes bajo web/src/app/features. Presentar evidencia de coincidencia y pedir confirmación antes de aplicar. Consultar progreso por batch. Verificación. La vista conserva pendientes en recarga. El cierre de prueba reconstruye el saldo desde los movimientos confirmados. | Pendiente | |

### Implementation Phase 4

**GOAL-004** Piloto de conciliación

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | Preparar CSV sintético con abonos parciales, una referencia ambigua y un reverso. Ejecutar un cierre y simular reenvío y replay de DLQ con datos autorizados del piloto. Verificación. El total conciliado coincide con el escenario. Se registran discrepancias, tiempo de cierre y manuales de operación. | Pendiente | |

## 3. Alternatives

- **ALT-001** Contenedor siempre activo. Reservarlo para procesamiento que requiera recursos sostenidos durante la jornada.
- **ALT-002** Orquestación de cada operación con Step Functions. Usarla cuando el historial de etapas y la recuperación independiente aporten valor a un proceso largo.

## 4. Dependencies

- **DEP-001** Angular y NgRx Signals según el lock de `web/`.
- **DEP-002** Node.js 24, AWS SAM, API Gateway y DynamoDB bajo demanda para los servicios del piloto.

## 5. Files

- **FILE-001** `infra/template.yaml` incorpora rutas autorizadas y tablas por servicio.
- **FILE-002** `services/` contiene dominios y adaptadores Lambda, con pruebas de operaciones e idempotencia.
- **FILE-003** `web/src/app/features/` contiene rutas, estado y pantallas de cada flujo.

## 6. Testing

- **TEST-001** Pruebas unitarias de reglas, invariantes monetarias e idempotencia con fixtures sintéticos.
- **TEST-002** Pruebas de integración de segregación por organización, datos y operación de extremo a extremo en entorno de pruebas.
- **TEST-003** Verificación de compilación y pruebas Angular, `node --test` de handlers y lint de SAM.

## 7. Risks & Assumptions

- **RISK-001** Errores de importe o repetición. Verificar operaciones con aritmética entera, validación de moneda y escrituras condicionales.
- **ASSUMPTION-001** Cada organización piloto aporta un escenario y datos de prueba autorizados. El despliegue y la operación se revisan después de comprobar el flujo local.

## 8. Related Specifications / Further Reading

- [Producto](../docs/PRODUCTO.md)
- [Arquitectura](../docs/architecture/ARCHITECTURE.md)
- [Lambda con Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
- [Transacciones DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transactions.html)
- [Flujos de AWS Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
