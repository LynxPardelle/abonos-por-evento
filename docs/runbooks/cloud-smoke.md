# Smoke sintético de SaldoEvento en development

`scripts/smoke-cloud.mjs` comprueba el flujo publicado usando CloudFront, HTTP API con JWT, S3, SQS, Lambda y DynamoDB. Se ejecuta después de desplegar y publicar los assets del ambiente de desarrollo. El script rechaza cualquier stack distinto de `saldoevento-dev`, cualquier valor de `Stage` distinto de `dev` y cualquier origen distinto de `https://saldoevento-dev.lynxpardelle.com`.

```powershell
node scripts/smoke-cloud.mjs --stack saldoevento-dev --region us-east-1
```

Se requieren AWS CLI y permisos para describir el stack, crear/borrar usuarios temporales de su User Pool, establecer su contraseña e iniciar autenticación administrativa. El cliente Cognito del ambiente dev debe admitir `ALLOW_ADMIN_USER_PASSWORD_AUTH`. Este flujo administrativo debe quedar deshabilitado en testing y producción. Las dependencias se instalan desde el lockfile de la raíz.

El script crea tres identidades sintéticas con direcciones `@example.test`: un operador y un importador de una organización temporal, y un auditor de otra. Usa `MessageAction: SUPPRESS`; no envía correos. Las contraseñas aleatorias, los ID tokens y las URL de carga permanecen en memoria. El bloque `finally` intenta borrar todas las identidades cuya creación se intentó, incluso ante un fallo intermedio.

El escenario crea un evento `[SINTÉTICO SMOKE …]`, tres participantes y un CSV con abonos de 500 y 750 MXN, una referencia ambigua y una fila inválida. Verifica que la importación no aplique pagos automáticamente, que el operador confirme los dos abonos y que un reverso de 500 deje un total confirmado de 750 MXN. Comprueba reintento idempotente de confirmación, reenvío del archivo con un solo lote, tres movimientos conservados, rechazo sin JWT, aislamiento de organizaciones y rechazo de confirmación al rol importador.

El procesamiento del CSV se consulta cada dos segundos durante un máximo de 60 segundos; cada solicitud HTTP tiene un timeout de 15 segundos. La autenticación usada para las llamadas de API es administrativa con ID token: este smoke no demuestra por sí mismo el recorrido de navegador de Cognito Hosted UI/PKCE.

El informe seguro se imprime y se escribe en `artifacts/deployments/dev/cloud-smoke.json`. Sólo contiene checks, conteos, importes e identificadores sintéticos. El script devuelve código 1 si falla un check o si no puede borrar alguna identidad. Si el fallo ocurre antes de validar el stack y preparar el escenario, imprime únicamente un código de error de configuración y no crea el informe.

El evento, sus participantes y los movimientos sintéticos permanecen como evidencia de la prueba en DynamoDB; sus identificadores quedan en el informe. Los archivos de entrada siguen la caducidad configurada del bucket. Si falla la limpieza de Cognito, las identidades se identifican por el `runId` del informe y los nombres `smoke-<runId>-operator@example.test`, `smoke-<runId>-othertenant@example.test` y `smoke-<runId>-importer@example.test`; deben borrarse del User Pool de development antes de dar por terminado el chequeo.
