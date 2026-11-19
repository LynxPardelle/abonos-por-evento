# Conciliación de SaldoEvento

El núcleo usa importes enteros positivos como cadenas JSON y `BigInt` al operar. Cada abono y reverso tiene identidad propia. La moneda pertenece al evento y el reverso enlaza el abono original. Las operaciones repetidas devuelven el resultado original; una solicitud diferente con el mismo `operationId` devuelve conflicto. `expectedVersion` evita sobrescribir confirmaciones concurrentes.

El CSV UTF-8 requiere las cabeceras, en este orden:

```csv
provider,movement_id,participant_reference,amount,currency
bank,synthetic-001,ANA,1250.50,MXN
```

`POST /api/v1/events/{eventId}/payments` registra un abono manual con rol `confirmer`: `{operationId,participantId,reference,amountMinor,currency,expectedVersion,itemId?}`. La referencia estable identifica el comprobante dentro del evento y no puede volver a aplicarse con otra operación. El importe se recibe como entero positivo en cadena y la moneda debe coincidir con el evento. También puede reversarse con la ruta normal de reversos.

Admite comillas dobles, escapes `""`, BOM y finales LF/CRLF. El importe decimal se convierte a centavos sin punto flotante. MXN/USD/EUR son las monedas admitidas por Eventos. Cada archivo contiene entre 1 y 500 filas y ocupa hasta 1 MiB. El detalle serializado de un batch tiene un límite adicional de 300000 bytes para conservar margen bajo el límite de ítem DynamoDB; si se supera, el batch queda `failed` con explicación para dividirlo.

`POST imports` recibe `{operationId,fileName,sha256}` y retorna `{batch,upload:{url,method,headers}}`; la URL PUT vence en cinco minutos. El worker comprueba la huella SHA-256 del contenido. Una misma huella dentro de organización/evento identifica un batch lógico. Una referencia exacta y única sólo produce una sugerencia: confirmar requiere una operación explícita. Filas ambiguas o sin coincidencia pueden asignarse manualmente a un participante; inválidas o duplicadas no se aplican. El servidor toma importe, moneda y referencia desde la fila persistida.

La clave DynamoDB es `ORG#{organizationId}#EVENT#{eventId}`. Los movimientos se guardan en ítems separados, no en una lista creciente dentro de un ítem. Una transacción anexa el movimiento, actualiza versión y proyección de saldo, y marca la fila aplicada mediante condición de versión. Las lecturas del saldo reconstruyen el total desde el ledger. Batches y marcas de carga son independientes. Los tenants provienen de claims JWT y las lecturas de Eventos usan invocación IAM interna, nunca organización enviada en el cuerpo HTTP.

```powershell
node --test services/reconciliation/**/*.test.mjs services/reconciliation/*.test.mjs
node services/reconciliation/pilot.mjs
```

El piloto usa únicamente datos sintéticos: dos abonos, un reverso, una referencia ambigua, una fila inválida, archivo reenviado, duplicado entre archivos y fallo/replay de mensaje. Su saldo esperado es `75000` centavos MXN. El repositorio en memoria verifica el flujo local; no sustituye la verificación desplegada de DynamoDB, S3, SQS y DLQ.
