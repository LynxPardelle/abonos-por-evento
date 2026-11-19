# Operación de SaldoEvento

## Ejecución local

Instala los tres lockfiles con Node.js 24 y usa `npm run dev:api` y `npm --prefix web start` en terminales distintas. Abre http://localhost:4310. La API sintética escucha sólo en 127.0.0.1:4311; no detengas servicios de otros proyectos si alguno de esos puertos está ocupado. Los datos locales se mantienen en memoria durante la vida del proceso y desaparecen al reiniciar la API.

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

## Infraestructura y dominios

El template principal está en `infra/template.yaml`. Los parámetros públicos por ambiente están en `infra/environments/`. Se verificaron el 19 de noviembre de 2026 la cuenta AWS de trabajo, la zona pública lynxpardelle.com y el certificado wildcard emitido en us-east-1; no son secretos. El despliegue de desarrollo usa **saldoevento-dev** en **us-east-1**. Los subdominios de pruebas y producción se reservan para la promoción development → testing → main.

`scripts/Deploy-Development.ps1` prepara un bootstrap de artefactos privados y un change set de desarrollo. La vista previa se guarda bajo `artifacts/deployments/dev/`. Para ejecutarla se utiliza el mismo ChangeSetName revisado con el switch Execute. El script no permite apuntar a producción. Tras crear/actualizar el stack, entrega los assets al bucket privado de salida. Los artefactos se cifran y tienen caducidad; tablas, buckets de datos y pool Cognito se conservan ante eliminación de stack para evitar pérdida accidental.

El frontend espera `PUBLIC_ORIGIN`, `COGNITO_DOMAIN` y `COGNITO_CLIENT_ID`, provistos por CloudFormation. No requiere archivos `.env` ni credenciales en frontend. Cognito no permite autoalta ni que el cliente cambie organización o roles. Los atributos custom se provisionan administrativamente.

Para probar identidad sin enviar correos a personas, el smoke de desarrollo crea identidades sintéticas con mensajes suprimidos, autentica mediante una operación administrativa IAM y las elimina al finalizar. Ese flujo administrativo sólo se habilita en stage dev; la aplicación usa OAuth Code con PKCE. Los tokens y contraseñas permanecen en memoria y no se registran en el reporte.

## Prueba en AWS

Después de desplegar desarrollo:

```powershell
node scripts/smoke-cloud.mjs --stack saldoevento-dev --region us-east-1
```

El script rechaza otro stack/stage/origen. Comprueba HTML, configuración, autenticación real Cognito/HTTP API, aislamiento de organizaciones, permisos, carga S3, importador por SQS, idempotencia, abonos y reverso. Los únicos datos de negocio que crea son sintéticos y están identificados como piloto. El reporte sanitizado queda en `artifacts/deployments/dev/cloud-smoke.json`. La ausencia de un reporte aprobado significa que el flujo de nube sigue sin acreditar.

## Errores y replay

Una fila rechazada indica su causa. Un lote failed muestra el error y debe corregirse y enviarse como archivo nuevo. Para un fallo transitorio de carga puede reenviarse el mismo archivo: su huella conserva un solo batch. Un 409 de saldo exige actualizar y revisar antes de confirmar de nuevo. El botón de reverso conserva el movimiento original.

SQS tiene visibilidad mayor que el timeout del worker y ReportBatchItemFailures. Un fallo agotado termina en DLQ. Antes de reenviar, revisa causa, evento, organización, clave S3 y estado del batch. No alteres el ledger para forzar un replay; repetir el mensaje válido debe conservar el resultado idempotente. La retención de CSV es de siete días, por lo que un replay posterior requiere recuperar el archivo autorizado y comprobar la huella original.

## Pendientes para operación con personas

Provisionar la identidad real y asignar organización/rol; ejecutar un escenario del organizador con datos autorizados; revisar métricas, alarmas y retención según uso; y promover mediante PR development → testing → main. La validación con datos sintéticos no equivale a aceptación comercial ni a un cierre con movimientos reales.
