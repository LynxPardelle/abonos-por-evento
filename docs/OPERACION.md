# Operación de SaldoEvento

## Ejecución local

Con los tres lockfiles instalados y Node.js 24, usa `npm run dev:api` y `npm --prefix web start` en terminales distintas. Abre http://localhost:4310 para ver el sitio comercial y `/app` para el espacio operativo. `/registro` presenta el alta; en modo local no crea cuentas Cognito ni envía correos. La API sintética escucha sólo en 127.0.0.1:4311; no detengas servicios de otros proyectos si alguno de esos puertos está ocupado. Los datos locales se mantienen en memoria durante la vida del proceso y desaparecen al reiniciar la API. La evaluación Equipo y su colaborador auditor son fixtures locales para probar las capacidades, sin concederlas a ninguna cuenta real.

El evento de ejemplo incluye participantes con referencias ANA-01 y BRUNO-02. En Importaciones descarga el CSV, cárgalo y revisa cada pago. Antes de confirmar el saldo es cero. Confirma 500.00 y 750.00 MXN, reversa el primero y comprueba un total de 750.00 MXN. Recarga el navegador: el backend conserva el resultado durante el proceso. En Movimientos también se puede registrar un abono manual con una referencia única y confirmación explícita.

## Comprobaciones reproducibles

```powershell
npm test
npm run test:web
npm run build:web
npm run package:frontend
npm run smoke:frontend
npm run validate:infra
node services/reconciliation/pilot.mjs
cfn-lint infra/template.yaml infra/artifacts.yaml
```

El piloto produce un saldo confirmado de 75000 unidades menores MXN, tres movimientos, una referencia ambigua, una fila rechazada, un duplicado y un replay, sin discrepancias. La memoria y la cola de ese piloto son simuladas. `smoke:frontend` invoca el adaptador Lambda real del paquete SSR, incluyendo host y caché; no acredita CloudFront real.

La comprobación local inicial del incremento aprobó 161 pruebas Node, 33 Angular y el build SSR; se conserva como [evidencia histórica de desarrollo](verificacion/subscription-tiers-local-2026-11-19.json). La entrega de testing `d752d26c23b8afcc60ef13c64b5f2c4166162e48` aprobó CI con **171 pruebas Node y 34 Angular**, despliegue AWS y smokes de permisos/transacciones, seguidos de aceptación humana con la cuenta del propietario. [Comprobante de testing](https://github.com/LynxPardelle/abonos-por-evento/pull/14#issuecomment-7025587666) y [aceptación sanitizada](verificacion/testing-tiers-owner-2026-11-19.json). Cada promoción nueva acredita su propio commit; [Verificación](VERIFICACION.md) mantiene separados el piloto publicado, la evidencia local y esta entrega.

## Infraestructura y dominios

El template principal está en `infra/template.yaml`. Los parámetros públicos por ambiente están en `infra/environments/`. Se verificaron el 19 de noviembre de 2026 la cuenta AWS de trabajo, la zona pública lynxpardelle.com y el certificado wildcard de la publicación original, emitido en us-east-1; no son secretos. Desarrollo usa **saldoevento-dev**, testing **saldoevento-test** y producción **saldoevento-prod**, en **us-east-1**. Producción publicó el piloto aprobado desde `main` `05b02f3`; el incremento de evaluación ya está validado en testing `d752d26` y su publicación al dominio nuevo está autorizada, pendiente del recibo de producción.

`scripts/Deploy-Development.ps1` prepara un bootstrap de artefactos privados y un change set de desarrollo. La vista previa se guarda bajo `artifacts/deployments/dev/`. Para ejecutarla se utiliza el mismo ChangeSetName revisado con el switch Execute. El script no permite apuntar a producción. Tras crear/actualizar el stack, entrega los assets al bucket privado de salida. Los artefactos se cifran y tienen caducidad; tablas, buckets de datos y pool Cognito se conservan ante eliminación de stack para evitar pérdida accidental.

`scripts/Deploy-Testing.ps1` exige un worktree limpio en `testing`, HEAD igual al ref remoto consultado, parámetros de stage test y un paquete cuyos checksums y commit coincidan con el promovido. Prepara una vista previa y sólo ejecuta el change set revisado. Reutiliza el bootstrap de artefactos existente; no crea ni modifica recursos de producción. El procedimiento completo está en [testing-promotion.md](runbooks/testing-promotion.md).

La promoción aprobada de tiers se prepara con `scripts/Deploy-Production.ps1` para actualizar el stack existente desde main verificado. La configuración objetivo establece `https://saldoevento.zooberiahsystems.com` como origen principal y conserva el dominio anterior compatible. Debe preservar pool, cliente, tablas y buckets. El certificado us-east-1, callback/logout y CORS están preparados para ambos hosts. Las sesiones web son por origen: se inicia sesión normalmente desde el dominio nuevo conservando la cuenta. **La configuración versionada y la autorización no acreditan ejecución: el despliegue y la comprobación de producción siguen pendientes del recibo en el PR correspondiente.** [Guardas, revisión y verificación de producción](runbooks/production-promotion.md). Stripe, Checkout y autenticación administrativa por contraseña siguen desactivados en prod.

El frontend recibe `PUBLIC_ORIGIN`, `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID` y `SELF_REGISTRATION_ENABLED` de CloudFormation. `/runtime-config.json` expone sólo configuración pública, incluido `selfRegistrationEnabled`. No requiere archivos `.env` ni credenciales en frontend. La landing de `/` y la pantalla `/registro` respetan ese flag; `/app` mantiene el flujo operativo autenticado.

## Registro y administración de identidad

`SelfRegistrationEnabled` es false por defecto; dev/test lo habilitan y el lanzamiento de producción se autorizó con ese flag en true. Los parámetros prod versionados conservan ese flag e incluyen la nueva configuración de dominio autorizada; su aplicación se acredita por separado en el recibo de producción. El usuario inicia el registro en Cognito, verifica su correo y vuelve mediante Authorization Code con PKCE S256 a `/auth/callback`, que conduce a `/app`. El flujo administrativo de contraseña sigue desactivado en prod.

PostConfirmation crea la membresía y PreTokenGeneration V1 la consulta o repara de forma idempotente. IdentityTable utiliza pool y `sub` como identidad, deriva una organización propia y concede `admin` únicamente dentro de ella, con metadato tier `pilot`. El cliente no puede escribir atributos de organización/rol ni elegir una membresía o tier pagado mediante el formulario o `clientMetadata`.

Los atributos protegidos de cuentas administrativas anteriores se migran al primer acceso. **IdentityTable es la fuente de verdad**: cambiar `custom:roles` de Cognito no modifica el mapping existente. El piloto publicado utiliza esos claims durante la vigencia de 15 minutos. El incremento validado en testing añade un resolver actual por petición y condiciones de versión al escribir: roles, membresía y plan se comprueban en servidor, sin confiar en los claims antiguos ni en el header candidato de organización. El propietario con Equipo puede ajustar roles o revocar colaboradores; el alta sigue asistida mediante IAM, sin invitaciones. [Contrato y límites de Identidad](../services/identity/README.md).

Para comprobar sin enviar correos a personas, los smokes de dev/test usan identidades sintéticas con `MessageAction: SUPPRESS`, contraseñas/tokens sólo en memoria y autenticación administrativa IAM. Una identidad sin atributos administrativos comprueba la provisión de organización por el servidor. El flujo administrativo sólo se habilita en dev/test; la aplicación pública usa Code/PKCE. Las identidades temporales se eliminan al finalizar. El propietario completó además el registro y la aceptación con su cuenta en testing y producción para el piloto.

## Prueba en AWS

Después de desplegar el commit verificado del ambiente correspondiente:

```powershell
node scripts/smoke-cloud.mjs --stack saldoevento-dev --region us-east-1
node scripts/smoke-testing.mjs --region us-east-1
```

Los helpers rechazan producción y comprueban el stack, Stage, origen y pool del ambiente. Verifican HTML/configuración, Cognito/HTTP API, aislamiento de organizaciones, permisos, provisión de una cuenta sin atributos de tenant, carga S3, importador por SQS, idempotencia, abonos y reverso. Los datos de negocio son sintéticos y están identificados como piloto; los reportes no contienen contraseñas, tokens ni URL firmadas.

Los resultados se guardan en `artifacts/deployments/dev/cloud-smoke.json` y `artifacts/deployments/test/cloud-smoke.json`. El hecho de tener el script o un resultado local con proveedor simulado no acredita un despliegue nuevo. Para dar por terminada la promoción se requieren checks del último commit aprobados, stack listo, assets publicados y reporte cloud aprobado. [Guardas y secuencia de promoción](runbooks/testing-promotion.md).

## Errores y replay

Una fila rechazada indica su causa. Un lote failed muestra el error y debe corregirse y enviarse como archivo nuevo. Para un fallo transitorio de carga puede reenviarse el mismo archivo: su huella conserva un solo batch. Un 409 de saldo exige actualizar y revisar antes de confirmar de nuevo. El botón de reverso conserva el movimiento original.

SQS tiene visibilidad mayor que el timeout del worker y ReportBatchItemFailures. Un fallo agotado termina en DLQ. Antes de reenviar, revisa causa, evento, organización, clave S3 y estado del batch. No alteres el ledger para forzar un replay; repetir el mensaje válido debe conservar el resultado idempotente. La retención de CSV es de siete días, por lo que un replay posterior requiere recuperar el archivo autorizado y comprobar la huella original.

## Evaluaciones administradas y operación con personas

La primera versión terminó la aceptación real de producción: registro por el propietario, evento con dos participantes, importación sin aplicar automáticamente, confirmaciones por 1250.00 MXN y reverso de 500.00; quedaron 750.00 confirmados, 1250.00 pendientes y tres movimientos tras recargar. [Evidencia sanitizada](verificacion/production-2026-11-19.json). No contiene correo, sujeto, ID de organización/evento privado ni credenciales.

El incremento de evaluación añade `/app/plan`, `/app/plantillas`, `/app/equipo` y `/eventos/{eventId}/cierre`. La API local conecta los mismos servicios y resolutores con repositorios en memoria. Prueba guardar una plantilla del ejemplo, crear otro evento (saldo cero), registrar un abono, cerrar, descargar su CSV, archivar y reabrir; el reporte histórico debe conservarse y el cupo cambiar sólo al archivar/reabrir. Equipo permite revocar al auditor sintético; Plan debe mostrar una plaza activa después de la baja.

`scripts/Grant-EvaluationPlan.mjs` prepara una vista previa tras verificar cuenta, stack, origen, pool y función exactos. Sólo `--execute` invoca el administrador IAM; prod exige también `--allow-production`. En testing se asignó Equipo a la cuenta del propietario para la aceptación y se autorizó un colaborador temporal limitado al evento sintético. El caso aprobó edición de roles y revocación con el mismo JWT; la identidad temporal se eliminó al terminar. El servicio separado de administración asigna planes o colaboradores ya registrados; las rutas HTTP no conceden tiers. Usa las versiones devueltas por el servidor y conserva el `operationId` al reintentar. [Comandos y permisos](../services/identity/README.md#asignación-manual-sin-facturación).

El cupo cuenta eventos no archivados y personas activas, incluido propietario y auditor. No se permite bajar a un plan menor que el uso actual. El piloto conserva sus derechos básicos y no adquiere una cuota comercial nueva. Un cierre limita movimientos financieros nuevos; su fotografía no cambia si después crece la lista. Archivo/reapertura conservan historia; si hay una transición pendiente, usa «Reanudar reapertura» con la operación original. Los cierres históricos se pueden consultar/exportar después de un downgrade. Las organizaciones administrativas antiguas sin base de plazas verificada requieren migración antes de Equipo; no se infiere propietario de un rol heredado.

La evaluación no exige tarjeta ni activa cargos futuros. Los [tiers](PLANES.md) completaron development → testing, los smokes AWS y la aceptación con la cuenta del propietario en `d752d26`. La promoción a main y producción en `saldoevento.zooberiahsystems.com` está aprobada; falta su ejecución y comprobante de producción. Invitaciones autoservicio, auditoría universal, precios, derechos por periodo y facturación tienen tareas posteriores. Stripe continúa desactivado; no se ofrece un SLA, retención perpetua ni integración bancaria.
