# Verificación de SaldoEvento

Fecha de trabajo: 19 de noviembre de 2026. Implementación en rama `feature/saldoevento-v1`, basada en `development`, conservando el checkout original en `main`.

## Evidencia local

- `npm test`: 69 pruebas Node aprobadas, sin omisiones. Incluye ledger, CSV, idempotencia, concurrencia, reversos, roles, tenant, DynamoDB inyectado, worker, API local, empaquetado, contratos SAM y herramientas de despliegue/smoke con proveedores simulados.
- `npm run test:web`: 7 pruebas Angular aprobadas: dinero exacto, errores de sesión, estado por ruta y carga de la interfaz.
- `npm run build:web`: Angular SSR de producción aprobado. Bundle inicial aproximado: 308 kB sin comprimir; 86 kB de transferencia estimada. Los flujos operativos se cargan de forma diferida.
- `npm run package:frontend` y `npm run smoke:frontend`: se invoca el adaptador Lambda empaquetado para tres rutas HTML y configuración cloud, con origen fijo y caché privada sin almacenamiento.
- `npm run validate:infra` y `cfn-lint` 1.60.1 sobre ambos templates: aprobados.
- `node services/reconciliation/pilot.mjs`: saldo de 75000 centavos MXN, tres movimientos, una fila ambigua, una rechazada, un duplicado y un replay simulado; cero discrepancias.

En navegador local se importó el CSV de ejemplo, se confirmaron 500.00 y 750.00 MXN, se reversó el primer abono y se recargó la página. El saldo confirmado permaneció en 750.00 MXN; el abono original y el reverso conservaron sus identidades. Ninguna fila se aplicó antes de confirmar.

También se registró un abono manual sintético de 125.50 MXN mediante el formulario, con elección de participante, referencia única y confirmación explícita; el movimiento y el saldo quedaron visibles.

La revisión encontró y corrigió checksum S3 para cuerpo vacío, resolución de rutas con stage nombrado, batches demasiado grandes que quedaban processing, reintentos DynamoDB ilimitados y falta de mensaje visible al fallar un batch.

## Evidencia cloud

La identidad AWS de trabajo, la zona pública lynxpardelle.com y el certificado wildcard ACM us-east-1 se comprobaron mediante lecturas. Los parámetros de desarrollo, pruebas y producción usan esos recursos existentes sin modificarlos.

El stack **saldoevento-dev** está **CREATE_COMPLETE** en **us-east-1**, desplegado desde el commit `6ae2927`. La URL **https://saldoevento-dev.lynxpardelle.com** devuelve HTML Angular SSR con 200 y `Cache-Control: private, no-store`. Los archivos estáticos se publicaron en el bucket privado y la configuración pública devuelve mode cloud.

El smoke real se ejecutó el 19 de noviembre de 2026, entre 19:20:41Z y 19:21:21Z, y aprobó **12 checks**. Usó tres identidades temporales Cognito y registros sintéticos: creó evento/participantes, rechazó acceso sin JWT y entre organizaciones, cargó 324 bytes en S3 y esperó al worker SQS, conservó filas ambiguas/rechazadas, impidió que importer confirmara, confirmó 500 + 750 MXN y reversó 500. El saldo final fue **75000 unidades menores MXN**, con **tres movimientos y un solo batch**. Las tres identidades se eliminaron; una lectura posterior confirmó cero usuarios en el pool.

El reporte sanitizado y versionado está en [development-2026-11-19.json](verificacion/development-2026-11-19.json). No contiene tokens, contraseñas ni URL de carga. Los datos sintéticos permanecen en DynamoDB como evidencia y el CSV caduca por política del bucket.

Comprobaciones adicionales: invocación directa de la Lambda SSR real aprobada; preflight CORS PUT de S3 con 200 y origen exacto del producto; navegación pública en navegador aprobada; el botón de acceso abrió el formulario real de Cognito con Authorization Code y PKCE S256. No se introdujeron credenciales reales de usuario.

El primer intento detectó un ID incorrecto de CachingDisabled. Se verificó el ID oficial en AWS, se añadió una regresión y un control de políticas conocidas y se reconstruyó el stack. Los cinco recursos retenidos del intento fallido se comprobaron vacíos antes de retirarlos; no quedaron copias de tablas, buckets ni pool de ese intento.

## Alcance pendiente

Aceptación con un organizador y datos autorizados; cuenta real y organización; completar Hosted UI/PKCE con usuario humano; supervisión y alertas según uso; elevación development → testing → main. El formulario de acceso y los tokens/API se comprobaron por separado: todavía no se acredita el recorrido completo de autenticación de una persona. El replay con fallo y la DLQ se simularon localmente; no se forzó un agotamiento real de DLQ en AWS.
