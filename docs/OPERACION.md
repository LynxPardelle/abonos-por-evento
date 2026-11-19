# Operación de SaldoEvento

## Ejecución local

Instala los tres lockfiles con Node.js 24 y usa `npm run dev:api` y `npm --prefix web start` en terminales distintas. Abre http://localhost:4310 para ver el sitio comercial y `/app` para el espacio operativo. `/registro` presenta el alta; en modo local no crea cuentas Cognito ni envía correos. La API sintética escucha sólo en 127.0.0.1:4311; no detengas servicios de otros proyectos si alguno de esos puertos está ocupado. Los datos locales se mantienen en memoria durante la vida del proceso y desaparecen al reiniciar la API.

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

La implementación local de landing, registro y herramientas de promoción aprobó 86 pruebas Node, 15 Angular y el build SSR. Los resultados remotos de esta entrega deben comprobarse sobre el commit correspondiente en [PR hacia development](https://github.com/LynxPardelle/abonos-por-evento/pulls?q=is%3Apr+base%3Adevelopment), [PR hacia testing](https://github.com/LynxPardelle/abonos-por-evento/pulls?q=is%3Apr+base%3Atesting) y [CI](https://github.com/LynxPardelle/abonos-por-evento/actions/workflows/ci.yml). El [historial de la base](VERIFICACION.md) conserva el despliegue anterior; no prueba el registro ni la promoción de la versión nueva.

## Infraestructura y dominios

El template principal está en `infra/template.yaml`. Los parámetros públicos por ambiente están en `infra/environments/`. Se verificaron el 19 de noviembre de 2026 la cuenta AWS de trabajo, la zona pública lynxpardelle.com y el certificado wildcard emitido en us-east-1; no son secretos. Desarrollo usa **saldoevento-dev** y testing **saldoevento-test**, ambos en **us-east-1**, con sus subdominios correspondientes. Producción se reserva para una promoción posterior a `main` después de la prueba del propietario.

`scripts/Deploy-Development.ps1` prepara un bootstrap de artefactos privados y un change set de desarrollo. La vista previa se guarda bajo `artifacts/deployments/dev/`. Para ejecutarla se utiliza el mismo ChangeSetName revisado con el switch Execute. El script no permite apuntar a producción. Tras crear/actualizar el stack, entrega los assets al bucket privado de salida. Los artefactos se cifran y tienen caducidad; tablas, buckets de datos y pool Cognito se conservan ante eliminación de stack para evitar pérdida accidental.

`scripts/Deploy-Testing.ps1` exige un worktree limpio en `testing`, HEAD igual al ref remoto consultado, parámetros de stage test y un paquete cuyos checksums y commit coincidan con el promovido. Prepara una vista previa y sólo ejecuta el change set revisado. Reutiliza el bootstrap de artefactos existente; no crea ni modifica recursos de producción. El procedimiento completo está en [testing-promotion.md](runbooks/testing-promotion.md).

El frontend recibe `PUBLIC_ORIGIN`, `COGNITO_DOMAIN`, `COGNITO_CLIENT_ID` y `SELF_REGISTRATION_ENABLED` de CloudFormation. `/runtime-config.json` expone sólo configuración pública, incluido `selfRegistrationEnabled`. No requiere archivos `.env` ni credenciales en frontend. La landing de `/` y la pantalla `/registro` respetan ese flag; `/app` mantiene el flujo operativo autenticado.

## Registro y administración de identidad

`SelfRegistrationEnabled` es false por defecto; los parámetros dev/test lo habilitan y producción permanece cerrado. El usuario inicia el registro en Cognito, verifica su correo y vuelve mediante Authorization Code con PKCE S256 a `/auth/callback`, que conduce a `/app`.

PostConfirmation crea la membresía y PreTokenGeneration V1 la consulta o repara de forma idempotente. IdentityTable utiliza pool y `sub` como identidad, deriva una organización propia y concede `admin` únicamente dentro de ella, con metadato tier `pilot`. El cliente no puede escribir atributos de organización/rol ni elegir una membresía o tier pagado mediante el formulario o `clientMetadata`.

Los atributos protegidos de cuentas administrativas anteriores se migran al primer acceso. A partir de entonces **IdentityTable es la fuente de verdad**: cambiar los atributos `custom:roles` de Cognito no modifica el mapping existente. La administración con IAM debe actuar sobre la membresía; no hay una API pública para cambiar roles o invitar colaboradores. Suspender el mapping impide nuevos tokens, pero los ID tokens emitidos pueden seguir aceptándose durante su vigencia de 15 minutos. [Contrato y límites de Identidad](../services/identity/README.md).

Para comprobar sin enviar correos a personas, los smokes de dev/test usan identidades sintéticas con `MessageAction: SUPPRESS`, contraseñas/tokens sólo en memoria y autenticación administrativa IAM. Una identidad sin atributos administrativos comprueba la provisión de organización por el servidor. El flujo administrativo sólo se habilita en dev/test; la aplicación pública usa Code/PKCE. Las identidades temporales se eliminan al finalizar. La confirmación de correo y el recorrido completo de una cuenta real siguen necesitando una prueba humana antes de `main`.

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

## Pendientes para operación con personas

El propietario debe registrarse con su cuenta en el ambiente de pruebas, recibir el código, completar el acceso y ejecutar un escenario autorizado. La organización se asigna desde el servidor; no se necesita un tenant elegido en el navegador. La validación sintética no sustituye esa aceptación. **`main` y producción permanecen pendientes hasta esa prueba y una instrucción posterior.**

El piloto no exige tarjeta ni activa cargos futuros. Por Evento, Organizador y Equipo permanecen [en diseño](PLANES.md), sin precio, compra, cuotas comerciales ni Stripe activos. Antes de vender un tier se requieren sus capacidades, controles backend y reglas de operación; no debe anunciarse un SLA, retención perpetua o una integración bancaria que todavía no existe.
