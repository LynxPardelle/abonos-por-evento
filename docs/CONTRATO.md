# Contrato de SaldoEvento

**Versiones al 19 de noviembre de 2026:** el piloto publicado en `main` `05b02f31563d88285d22b5085d69d3ba757e6675` mediante el [PR #10](https://github.com/LynxPardelle/abonos-por-evento/pull/10) está validado con una cuenta real en https://saldoevento.lynxpardelle.com. Las rutas base de eventos, importación y conciliación pertenecen a esa versión. Las extensiones de cuenta, entitlements, cierre, plantillas y vista global descritas aquí corresponden al **incremento local todavía no desplegado**. Stripe y Checkout siguen desactivados en ambos.

Todas las rutas de negocio requieren ID token Cognito en `Authorization: Bearer ...`, validado por HTTP API contra el emisor y audiencia de su ambiente. En el piloto publicado, el backend usa los claims de organización y roles emitidos por el servidor. En el incremento local, el sujeto validado y el pool configurado se utilizan para resolver membresía, roles y plan actuales mediante un lector IAM con lecturas consistentes, sin caché de permisos.

`X-SaldoEvento-Organization` es un selector candidato del incremento local, nunca autoridad: debe corresponder a una membresía activa del sujeto. Sin header se usa su organización base. Cuerpo, atributos públicos y claims antiguos no conceden otro tenant, rol o tier. El cliente debe invalidar su estado de eventos al cambiar organización. La cuenta y organización de producción no son las de testing, aunque se utilice el mismo correo.

Los errores tienen forma `{ "error": { "code": "VERSION_CONFLICT", "message": "..." } }`. `401` exige acceso válido; `403` indica permiso o capacidad insuficientes; `404` no revela recursos ajenos; `409` exige revisar idempotencia, versión, capacidad o estado del evento; `413` indica un límite técnico. `MEMBERSHIP_REVOKED` no significa que la cuenta haya perdido su organización personal. `ACCESS_CHANGED` o `USAGE_CHANGED` requieren actualizar antes de volver a operar. No se permite hacer fallback a los claims antiguos si el resolver de acceso no está disponible.

## HTTP

Prefijo común: `/api/v1`.

| Método y ruta                                             | Cuerpo / respuesta                                                                                          | Permiso                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| GET `/events`                                             | `{events:[]}`; el incremento local añade `usage` y filtra por scope de eventos                              | lectura                  |
| POST `/events`                                            | `{operationId,name,currency,eventId?}` → `{event}`                                                          | operator/admin           |
| GET `/events/{eventId}/participants`                      | `{participants:[]}`                                                                                         | lectura                  |
| POST `/events/{eventId}/participants`                     | `{operationId,name,reference,agreedMinor,participantId?}` → `{participant}`                                 | operator/admin           |
| POST `/events/{eventId}/imports`                          | `{operationId,fileName,sha256}` → `{batch,upload:{url,method,headers,expiresIn}}`                           | importer/operator/admin  |
| GET `/events/{eventId}/imports`                           | `{batches:[]}` sin detalle de filas                                                                         | lectura                  |
| GET `/events/{eventId}/imports/{batchId}`                 | `{batch}` con filas, estado y error si falló                                                                | lectura                  |
| POST `/events/{eventId}/allocations`                      | `{operationId,batchId,rowId,participantId,expectedVersion,itemId?}` → `{movement,version}`                  | confirmer/operator/admin |
| POST `/events/{eventId}/payments`                         | `{operationId,participantId,reference,amountMinor,currency,expectedVersion,itemId?}` → `{movement,version}` | confirmer/operator/admin |
| GET `/events/{eventId}/balances`                          | `{version,currency,balances:[{participantId,paidMinor,agreedMinor,pendingMinor,currency}]}`                 | lectura                  |
| GET `/events/{eventId}/movements`                         | `{version,movements:[]}`                                                                                    | lectura                  |
| POST `/events/{eventId}/movements/{movementId}/reversals` | `{operationId,expectedVersion}` → `{movement,version}`                                                      | confirmer/operator/admin |

El incremento añade `GET /events/{eventId}` → `{event}` para la lectura autenticada del detalle que utiliza Cierre y reportes. Está publicado en SAM y hereda el autorizador JWT; los eventos ajenos no se revelan.

`GET /health` es público y sólo comprueba liveness, no disponibilidad de tablas, correo o worker. Los contratos internos IAM no son rutas públicas ni operaciones que el navegador pueda habilitar desde su JSON.

## Cuenta, planes y Equipo — incremento local

| Método y ruta                                           | Cuerpo / respuesta                                                                                                     | Permiso                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| GET `/me`                                               | `{homeOrganizationId,activeOrganizationId,organizations,organization:{organizationId,plan,capabilities,limits,usage}}` | identidad verificada y membresía actual |
| GET `/organizations/current/members`                    | `{members,version}`                                                                                                    | propietario con `manageTeam`            |
| POST `/organizations/current/members/{memberId}/role`   | `{operationId,expectedVersion,roles,eventIds?}` → `{member}`                                                           | propietario con `manageTeam`            |
| POST `/organizations/current/members/{memberId}/revoke` | `{operationId,expectedVersion}` → `{member}`                                                                           | propietario con `manageTeam`            |

`plan` contiene `{code,catalogVersion,assignmentVersion,status,source,billingEnabled:false}`. Los códigos son `pilot`, `event`, `organizer` y `team`, con catálogo `2026-11-19.v1`. `limits` contiene `maxActiveEvents` (`null`, 1, 5 o 20) y `maxSeats` (1, 1, 1 o 5). El uso de identidad es `{activeSeats,seatBaselineVerified}`. Una persona incluye al propietario o a cualquier colaborador activo, también auditor. El uso de eventos se obtiene de Eventos; cerrar financieramente no libera cuota, archivar sí.

Las capacidades son `createEvent`, `manageParticipants`, `importPayments`, `confirmPayments`, `reversePayments`, `closeEvent`, `exportEvent`, `manageTemplates`, `viewOverview` y `manageTeam`. Son calculadas por el servidor a partir de rol, scope y plan. Piloto conserva las operaciones básicas y no tiene cuota comercial de eventos; Por Evento habilita cierre/reporte actual; Organizador añade plantillas/vista global; Equipo añade administración de colaboradores por su propietario.

Un miembro público tiene `{memberId,organizationId,roles,eventIds,status,version,isOwner}`. `expectedVersion` de role/revoke es la versión de ese miembro. Roles concedibles: `operator`, `importer`, `confirmer`, `auditor`; nunca `admin` o propietario. Omitir `eventIds` en un cambio conserva el scope; `null` explícito amplía a todos los eventos de la organización; una lista admite de 1 a 50 IDs distintos. Una membresía limitada a eventos no puede crear eventos, administrar plantillas ni consultar la vista global.

No existe ruta pública de cambio de plan o alta de colaboradores. `identity/admin.handler`, invocable sólo mediante IAM, recibe `{internal:{action:'grantPlan'|'grantMember',userPoolId,subject,organizationId,operationId,expectedVersion,...}}`. `grantPlan` añade `code`; `grantMember` añade `roles,eventIds?` y exige un sujeto ya aprovisionado. Aquí `expectedVersion` es la versión del plan. El CLI `scripts/Grant-EvaluationPlan.mjs` muestra una vista previa por defecto; la ejecución exige `--execute` y, para producción, `--allow-production` y autorización vigente. No activa facturación o una renovación futura.

Las filas originales `MEMBERSHIP` y el claim `custom:tier:pilot` se conservan. El plan reside en `ORG#{organizationId}/PLAN`. Una organización administrativa histórica no se convierte automáticamente en propiedad de un `admin` ni presume una sola plaza; habilitar Equipo sin una base migrada explícitamente devuelve `LEGACY_BASELINE_REQUIRED`. Las invitaciones, enlaces de aceptación y mensajes de correo están diferidos.

## Cierre financiero, archivo y exportación — incremento local

| Método y ruta                              | Cuerpo / respuesta                                                                             | Permiso                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| GET `/events/{eventId}/closing`            | Estado financiero, versiones, transición pendiente, cierres y último snapshot                  | lectura del evento                                                  |
| POST `/events/{eventId}/closing`           | `{operationId,expectedLedgerVersion,expectedLifecycleVersion}` → estado del cierre             | operator/admin y `closeEvent`                                       |
| POST `/events/{eventId}/archive`           | `{operationId,expectedEventRevision,expectedLifecycleVersion}` → estado del cierre             | operator/admin; conciliación cerrada                                |
| POST `/events/{eventId}/reopen`            | `{operationId,expectedEventRevision,expectedLifecycleVersion}` → estado del cierre             | operator/admin; cuota al recuperar un archivado                     |
| GET `/events/{eventId}/report`             | JSON `{fileName,contentType,content,ledgerVersion,closureId}`; `content` es el CSV descargable | lectura y `exportEvent`                                             |
| GET `/events/{eventId}/report/{closureId}` | Mismo formato, desde un snapshot inmutable                                                     | lectura actual del evento; conserva acceso histórico tras downgrade |
| GET `/overview`                            | `{events,totalsByCurrency,activeOnly:true,usage}`                                              | lectura, `viewOverview` y scope global                              |

El cierre es **financiero**: fija snapshot de saldos, movimientos, totales, autor/fecha, revisión del padrón y versiones. No equivale a cerrar todas las inscripciones o congelar el padrón. Impide nuevos abonos, aplicaciones, reversos e inicializaciones de importación mientras el ledger esté cerrado; un reintento ya confirmado conserva su resultado. No borra el ledger ni libera cuota por sí mismo.

Archivar exige cierre y revisión vigente del evento, conserva su historial y libera capacidad de eventos no archivados. Reabrir un archivado reserva cuota antes de abrir el ledger y termina con `finalizeReopen`. Una reserva o finalización interrumpida se reanuda con la misma `operationId` y los datos de `transition`, sin crear otra reserva ni otro reverso. Otra operación no puede usurpar una reapertura pendiente. El ciclo de vida tiene una versión independiente del número de movimientos; cerrar y reabrir un ledger vacío conserva su versión cero y permite después su primer abono.

El snapshot se limita a **300000 bytes**; superarlo devuelve `CLOSURE_TOO_LARGE` antes de cerrar. El reporte CSV se limita a **1 MiB** y usa BOM UTF-8, CRLF, escape de comillas y protección de celdas de texto que podrían interpretarse como fórmulas. Los importes se convierten exactamente desde `BigInt`, incluidos negativos y valores grandes. Los movimientos antiguos pueden no contener autor/fecha. El downgrade no borra snapshots: su consulta histórica sigue requiriendo membresía y lectura vigentes del evento. La vista global admite hasta 50 eventos no archivados y agrupa totales por moneda, sin conversión o suma entre monedas distintas.

## Plantillas — incremento local

| Método y ruta                         | Cuerpo / respuesta                                           | Permiso                                                    |
| ------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| GET `/templates`                      | `{templates}` autorizadas                                    | lectura                                                    |
| GET `/templates/{templateId}`         | `{template}`                                                 | lectura de su scope                                        |
| POST `/templates`                     | `{operationId,name,sourceEventId}` → `{template}`            | operator/admin con `manageTemplates`, scope global         |
| POST `/templates/{templateId}/events` | `{operationId,name,expectedTemplateVersion}` → evento creado | operator/admin con `manageTemplates`, scope global y cuota |

Una plantilla conserva moneda, nombres, referencias e importes acordados de hasta **90 participantes**, con tamaño técnico máximo de 300000 bytes. Aplicarla crea evento y participantes nuevos en una transacción; no copia movimientos, abonos o saldos. La versión de plantilla y la cuota se comprueban en el servidor; el reintento no crea otro evento ni consume capacidad de nuevo.

## Fronteras internas IAM y concurrencia — incremento local

Eventos atiende `{internal:{action:'getEvent',organizationId,eventId}}` → `{event,participants}`, `getUsage` → `{nonArchivedEvents,version}` y los comandos coordinados `archiveEvent`, `beginReopen`, `finalizeReopen`, además de `listEventsforOverview`. El RPC de identidad `{internal:{action:'resolveAccess',userPoolId,subject,organizationHint?,eventId?}}` devuelve el actor actual y snapshots internos de acceso; no aprovisiona registros y sólo lee IdentityTable.

Cada dominio escribe únicamente su tabla. La excepción declarada es **lectura condicional de metadatos** dentro de una transacción: Eventos/Conciliación incluyen `ConditionCheck` de IdentityTable; el escritor administrativo de planes incluye `ConditionCheck` del contador `EventsTable: ORG#{org}/USAGE#EVENTS`. Así una revocación, downgrade o cambio de uso ocurrido después de resolver invalida el commit completo, sin escrituras parciales. No se conceden escrituras cruzadas de datos ni al cliente. Las lecturas de otros dominios siguen pasando por RPC IAM.

## Dinero y reintentos

`agreedMinor` y `amountMinor` son cadenas de enteros positivos, hasta 30 dígitos. El piloto admite **MXN, USD y EUR**, todas con dos decimales. Un ejemplo: `"50000"` representa 500.00 MXN. El reverso tiene `kind:'reversal'`, importe negativo y `reversalOf`; un abono tiene `kind:'payment'`.

Una operación repetida conserva el resultado original; reutilizar su ID con datos diferentes devuelve conflicto. La versión del ledger impide dos confirmaciones concurrentes que partieron del mismo saldo. Una referencia manual identifica un comprobante dentro del evento y no puede confirmarse dos veces; las importaciones deduplican proveedor e identificador externo.

El batch se identifica por SHA-256 del archivo dentro de organización/evento. La URL PUT dura cinco minutos y firma el checksum SHA-256 esperado. Cargar bytes distintos falla. Un archivo repetido conserva un único batch lógico; el nombre mostrado puede ser el del primer envío.

## CSV del piloto

Cabecera exacta y orden fijo:

```csv
provider,movement_id,participant_reference,amount,currency
transferencia,pago-001,ANA-01,500.00,MXN
transferencia,pago-002,BRUNO-02,750.00,MXN
```

UTF-8 con BOM opcional, LF o CRLF y comillas CSV escapadas con comillas dobles. `amount` usa punto decimal, hasta dos decimales y sin separadores de miles, exponentes ni signo negativo. `provider` es un identificador alfanumérico con guion o guion bajo. `movement_id` identifica el movimiento de origen. La referencia exacta y única produce una sugerencia; si no existe o corresponde a varios participantes, requiere selección manual. Ninguna fila se aplica automáticamente.

Límites: **1 MiB, 500 filas** y detalle serializado de batch de hasta **300000 bytes** para respetar el límite DynamoDB de 400 KiB. Un archivo estructuralmente inválido termina `failed` con causa visible; una fila inválida queda `rejected`. El tamaño conjunto puede obligar a dividir archivos aun con menos de 500 filas.

Estados de fila: `suggested`, `ambiguous`, `unmatched`, `rejected`, `duplicate`, `applied`. Estados de batch: `awaiting_upload`, `processing`, `ready`, `failed`.
