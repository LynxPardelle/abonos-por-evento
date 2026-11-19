# Verificación de SaldoEvento

Fecha de trabajo: 19 de noviembre de 2026. Este registro distingue la base histórica, el piloto publicado y el incremento local de suscripciones. Los resultados iniciales que siguen se conservan con su alcance original.

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

## Pendientes de aquella base histórica

Aceptación con un organizador y datos autorizados; cuenta real y organización; completar Hosted UI/PKCE con usuario humano; supervisión y alertas según uso; elevación development → testing → main. El formulario de acceso y los tokens/API se comprobaron por separado: todavía no se acredita el recorrido completo de autenticación de una persona. El replay con fallo y la DLQ se simularon localmente; no se forzó un agotamiento real de DLQ en AWS.

## Piloto publicado y aceptación real en producción

La primera versión completó los PR [#8 a development](https://github.com/LynxPardelle/abonos-por-evento/pull/8), [#9 a testing](https://github.com/LynxPardelle/abonos-por-evento/pull/9) y [#10 a main](https://github.com/LynxPardelle/abonos-por-evento/pull/10). El propietario aprobó el lanzamiento y el commit `05b02f31563d88285d22b5085d69d3ba757e6675` publicó el piloto en https://saldoevento.lynxpardelle.com. Su CI aprobó 86 pruebas Node, 15 Angular, SSR, paquete y contratos de infraestructura. El stack `saldoevento-prod` terminó CREATE_COMPLETE y CloudFront Deployed.

La verificación pública del 19 de noviembre a las 21:42:53Z aprobó cuatro rutas SSR, doce assets con checksum, configuración cloud, health y rechazos de API sin token o con token inválido. El cliente prod mantiene Code/PKCE y desactiva autenticación administrativa por contraseña. La huella de contenido frontend publicada es `13ffe85ec63383c2c4f1655201b2389aa068910222580ad0197f874bb520df83`.

El propietario completó el alta y verificación de correo en Cognito y entró a «Mi espacio» de producción. Después se ejecutó el escenario autorizado con participantes y pagos sintéticos: evento, dos participantes con 1000.00 MXN acordados cada uno y tres filas de importación. La importación no aplicó dinero. Dos confirmaciones sumaron 1250.00 MXN y dejaron 750.00 pendientes; un reverso de 500.00 dejó **750.00 confirmados y 1250.00 pendientes**, tres movimientos y una fila sin asignar. Se recargó antes y después del reverso y se conservó el historial. La aceptación terminó a las 22:05:35Z. Stripe permaneció desactivado.

La [evidencia durable sanitizada](verificacion/production-2026-11-19.json) consolida el recibo de lanzamiento y esa aceptación, sin identificadores privados de cuenta, organización o evento, correo, códigos, cookies ni tokens. Los archivos locales originales permanecen en `artifacts/deployments/prod/` y `artifacts/acceptance/prod-2026-11-19/` del checkout de producción. No se modificaron esos registros al desarrollar las suscripciones. Esta aceptación supera los pendientes humanos y de promoción de la base histórica; la prueba de DLQ agotada en AWS sigue pendiente.

## Incremento de evaluación de suscripciones: verificación local

Rama `codex/subscription-tiers`, basada en development `71140ec05bc7620074f7ec2c7f4b7d9ee0c45e66`. El checkout original sigue limpio en main `05b02f3`. **El incremento no se ha desplegado ni habilitado en cuentas reales.** Las pruebas de producción anteriores acreditan exclusivamente el piloto publicado.

- **161 pruebas Node**, sin fallos ni omisiones: identidad actual, roles/alcance, cuotas y downgrade concurrentes, revocación entre lectura y commit, plantilla atómica, lifecycle financiero, recuperación antes/después de persistir la reapertura, reportes y límites, integración HTTP local, contratos SAM e IAM.
- **33 pruebas Angular en once archivos**: contexto de organización y descarte de respuestas antiguas, formularios y rutas operativas, capacidades, equipo, plantillas, cierres históricos y recuperación de reapertura. Actualizar capacidad y los cambios de equipo vuelven a consultar `/me`.
- Build SSR aprobado: 320.77 kB iniciales, 89.27 kB de transferencia estimada. Empaquetado y smoke del adaptador Lambda: cinco rutas HTML, configuración cloud, host ajeno rechazado y `no-store`.
- Validador de infraestructura y `cfn-lint` 1.60.1 para ambos templates aprobados, sin advertencias. Tres funciones Identity nuevas mantienen separado al resolver de lectura, HTTP y administrador IAM. El servicio HTTP no recibe permisos de Events que sus rutas no usan. El worker no adquiere permisos de Identity.
- Revisión independiente de cuotas, downgrade/revocación, cierre/pago y límites de tablas sin hallazgos altos o medios pendientes. Las pruebas Dynamo inspeccionan transacciones con clientes inyectados; no son ejecución de DynamoDB desplegado.

En navegador contra Angular/API locales se consultó Equipo, guardó una plantilla con dos participantes y creó un evento nuevo con saldo cero. Un abono manual de 500.00 MXN dejó 1500.00 pendientes; cerrar guardó un snapshot en ledger 1, se descargó y leyó el CSV y se comprobó el importe. Archivar redujo el cupo de eventos en trabajo de dos a uno; reabrir lo devolvió a dos y conservó el reporte histórico. La vista general mostró 500.00 confirmados y 3500.00 pendientes MXN entre los dos eventos en trabajo. Revocar al colaborador sintético lo marcó Revocado y el plan pasó de dos a una persona activa. Toda la prueba utilizó datos en memoria, sin AWS, correo ni Stripe.

Capturas locales del worktree: `artifacts/subscription-tiers/plan-and-capacity.jpg`, `overview.jpg` y `team-revoked.jpg`. [Reporte sanitizado del incremento](verificacion/subscription-tiers-local-2026-11-19.json). El [plan de suscripciones](../plan/feature-subscription-tiers-1.md) conserva pendiente su promoción y comprobación AWS, invitaciones, auditoría ampliada y facturación.
