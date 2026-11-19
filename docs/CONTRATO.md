# Contrato de SaldoEvento

Todas las rutas de negocio requieren JWT validado por HTTP API. El tenant proviene de `custom:organizationId`, el rol de `custom:roles` y el sujeto de `sub`. El navegador envía ID token Cognito en `Authorization: Bearer ...`; no envía un tenant que pueda sustituir al del token.

Los errores tienen forma `{ "error": { "code": "VERSION_CONFLICT", "message": "..." } }`. `401` requiere acceso nuevo, `403` indica permiso insuficiente, `404` no revela recursos ajenos, `409` exige revisar idempotencia o versión, `413` indica límite del piloto.

## HTTP

Prefijo común: `/api/v1`.

| Método y ruta | Cuerpo / respuesta | Permiso |
| --- | --- | --- |
| GET `/events` | `{events:[]}` | lectura |
| POST `/events` | `{operationId,name,currency,eventId?}` → `{event}` | operator/admin |
| GET `/events/{eventId}/participants` | `{participants:[]}` | lectura |
| POST `/events/{eventId}/participants` | `{operationId,name,reference,agreedMinor,participantId?}` → `{participant}` | operator/admin |
| POST `/events/{eventId}/imports` | `{operationId,fileName,sha256}` → `{batch,upload:{url,method,headers,expiresIn}}` | importer/operator/admin |
| GET `/events/{eventId}/imports` | `{batches:[]}` sin detalle de filas | lectura |
| GET `/events/{eventId}/imports/{batchId}` | `{batch}` con filas, estado y error si falló | lectura |
| POST `/events/{eventId}/allocations` | `{operationId,batchId,rowId,participantId,expectedVersion,itemId?}` → `{movement,version}` | confirmer/operator/admin |
| POST `/events/{eventId}/payments` | `{operationId,participantId,reference,amountMinor,currency,expectedVersion,itemId?}` → `{movement,version}` | confirmer/operator/admin |
| GET `/events/{eventId}/balances` | `{version,currency,balances:[{participantId,paidMinor,agreedMinor,pendingMinor,currency}]}` | lectura |
| GET `/events/{eventId}/movements` | `{version,movements:[]}` | lectura |
| POST `/events/{eventId}/movements/{movementId}/reversals` | `{operationId,expectedVersion}` → `{movement,version}` | confirmer/operator/admin |

`GET /health` es público y sólo comprueba liveness. El contrato interno IAM de Eventos acepta `{internal:{action:'getEvent',organizationId,eventId}}` y devuelve `{event,participants}`; no es una ruta pública ni una operación que el navegador pueda habilitar en su JSON.

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
