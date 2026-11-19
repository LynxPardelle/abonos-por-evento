# Verificación de SaldoEvento

Fecha de trabajo: 19 de noviembre de 2026. Implementación en rama `feature/saldoevento-v1`, basada en `development`, conservando el checkout original en `main`.

## Evidencia local

- `npm test`: 68 pruebas Node aprobadas, sin omisiones. Incluye ledger, CSV, idempotencia, concurrencia, reversos, roles, tenant, DynamoDB inyectado, worker, API local, empaquetado, contratos SAM y herramientas de despliegue/smoke con proveedores simulados.
- `npm run test:web`: 7 pruebas Angular aprobadas: dinero exacto, errores de sesión, estado por ruta y carga de la interfaz.
- `npm run build:web`: Angular SSR de producción aprobado. Bundle inicial aproximado:308kB sin comprimir;86kB de transferencia estimada. Los flujos operativos se cargan de forma diferida.
- `npm run package:frontend` y `npm run smoke:frontend`: se invoca el adaptador Lambda empaquetado para tres rutas HTML y configuración cloud, con origen fijo y caché privada sin almacenamiento.
- `npm run validate:infra` y `cfn-lint1.60.1` sobre ambos templates: aprobados.
- `node services/reconciliation/pilot.mjs`: saldo75000centavos MXN, tres movimientos, una fila ambigua, una rechazada, un duplicado y un replay simulado; cero discrepancias.

En navegador local se importó el CSV de ejemplo, se confirmaron500.00 y750.00MXN, se reversó el primer abono y se recargó la página. El saldo confirmado permaneció750.00MXN; el abono original y el reverso conservaron sus identidades. Ninguna fila se aplicó antes de confirmar.

La revisión encontró y corrigió checksum S3 para cuerpo vacío, resolución de rutas con stage nombrado, batches demasiado grandes que quedaban processing, reintentos DynamoDB ilimitados y falta de mensaje visible al fallar un batch.

## Evidencia cloud

La identidad AWS de trabajo, la zona pública lynxpardelle.com y el certificado wildcard ACM us-east-1 se comprobaron mediante lecturas. Los parámetros de desarrollo, pruebas y producción usan esos recursos existentes sin modificarlos.

El despliegue `saldoevento-dev` y su smoke se registrarán aquí después de ejecutar la vista previa revisada y obtener el reporte `artifacts/deployments/dev/cloud-smoke.json`. La preparación de un template o la aprobación de un test con proveedor simulado no se considera evidencia de funcionamiento AWS.

## Alcance pendiente

Aceptación con un organizador y datos autorizados; cuenta real y organización; recorrido Hosted UI/PKCE con usuario humano; supervisión y alertas según uso; elevación development → testing → main. El smoke administrativo de Cognito acredita tokens y autorización API, pero no equivale a comprobar el formulario hospedado de acceso.
