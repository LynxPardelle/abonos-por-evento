# Promoción de SaldoEvento a testing

La entrega sigue **feature → development → testing**. La rama `main` y el ambiente de producción permanecen pendientes hasta la prueba con la cuenta real del propietario. Este procedimiento no publica a producción.

## Controles remotos verificados

El 19 de noviembre de 2026 se comprobaron mediante GitHub CLI los controles de `LynxPardelle/abonos-por-evento`:

- La cuenta activa es LynxPardelle; el repositorio admite merge commits.
- `testing` exige PR, resolución de conversaciones y el check `zoo/promotion/testing` del workflow confiable `Cadena de promoción`. El ruleset no admite bypass y permite únicamente merge commit.
- El workflow de promoción acepta hacia testing sólo la rama `development` del mismo repositorio. Lee metadatos y no ejecuta código del origen del PR.
- El environment GitHub `testing` permite únicamente la rama `testing`; el de desarrollo permite `development`.
- El workflow `Verificar SaldoEvento` ejecuta instalación con los tres lockfiles, pruebas Node/Angular, build SSR, empaquetado, smoke del frontend y lint de infraestructura. Debe aprobarse aunque no forme parte del check obligatorio histórico.

## Integración y promoción

1. Comprobar que el worktree de implementación esté limpio, mostrar el título/cuerpo del PR y subir su rama feature al remoto.
2. Crear el PR con base `development`. Esperar las verificaciones del último commit y comprobar que no existan conflictos ni conversaciones pendientes.
3. Integrar con merge commit. No usar `--admin`, no forzar push ni eludir checks.
4. Crear el PR **development → testing**. Esperar `zoo/promotion/testing` y todas las verificaciones de código del último HEAD. Integrar con merge commit, conservando el historial.
5. Obtener el commit remoto resultante de `testing`. Usar un worktree de esa rama, limpio y actualizado por fast-forward; no cambiar el checkout original en `main`.

Los comandos de merge deben fijar `--match-head-commit` al SHA que se verificó para impedir que se integre un HEAD diferente si el PR cambia durante la revisión.

## Despliegue del commit promovido

Desde el worktree limpio de `testing`:

```powershell
npm ci
npm --prefix services ci
npm --prefix web ci
pwsh -NoProfile -File scripts/Deploy-Testing.ps1 -ChangeSetName saldoevento-testing-release
```

Por defecto el script ejecuta las verificaciones y genera una **vista previa sin ejecutarla** en `artifacts/deployments/test/`. Comprueba:

- Rama `testing`, origen del repositorio esperado y `HEAD` idéntico al ref remoto `testing` consultado con `git ls-remote`.
- Cuenta AWS `765932874577`, región `us-east-1`, stack `saldoevento-test` y origen `https://saldoevento-test.lynxpardelle.com`.
- `Stage=test` y registro self-service habilitado para este ambiente.
- Fuente del manifiesto igual al commit promovido, checksums de los archivos del artefacto y evidencia local asociada.
- Bootstrap de artefactos existente y listo. Testing reutiliza su bucket privado; no crea ni modifica el bootstrap de desarrollo.

Para reutilizar verificaciones ya ejecutadas, `-SkipChecks -ChecksEvidencePath <json>` exige un JSON con `passed: true`, `sourceCommit` igual al HEAD promovido y `frontendContentSha256` igual al manifiesto. No permite omitir la identidad del artefacto.

Revisar las acciones y el alcance del change set. Si hay modificaciones o reemplazos de datos, evaluar su impacto antes de ejecutar. Para ejecutar **esa misma** vista previa:

```powershell
pwsh -NoProfile -File scripts/Deploy-Testing.ps1 -Execute -ChangeSetName saldoevento-testing-release
```

El script vuelve a comprobar el commit y los archivos, compara el change set contra la revisión guardada, espera `CREATE_COMPLETE` o `UPDATE_COMPLETE` y publica los estáticos sólo en el bucket devuelto por `saldoevento-test`. Conserva las versiones anteriores y no usa borrado de assets.

## Verificación en testing

```powershell
node scripts/smoke-testing.mjs --region us-east-1
```

El wrapper sólo admite `saldoevento-test`. El helper común rechaza producción y verifica que stack, Stage, origen y pool correspondan al ambiente solicitado. El reporte sanitizado queda en `artifacts/deployments/test/cloud-smoke.json`.

El escenario usa cuatro identidades temporales `@example.test`, con mensajes suprimidos y contraseñas/tokens sólo en memoria. Tres prueban roles y aislamiento de organizaciones administradas; la cuarta no recibe atributos de organización o rol. Su token debe contener una organización derivada por el servidor del pool y del sujeto, rol `admin` y tier `pilot`; debe poder crear su propio evento y no acceder al de la otra organización. Todas se eliminan al finalizar.

El smoke acredita Cognito/JWT, API, carga S3, importación por SQS, abonos, reverso, idempotencia y aprovisionamiento de identidad. El saldo del escenario principal debe ser 75000 unidades menores MXN, con tres movimientos y un único batch. Los datos son sintéticos. El agotamiento real de DLQ, la recepción de un código de verificación en una cuenta real y el recorrido completo de registro en navegador son evidencias diferentes y no se dan por probados con este script.

La autenticación administrativa IAM del smoke sólo se habilita en dev/test. No habilita un grant de contraseña público y no se habilita en producción. La aplicación pública utiliza Authorization Code con PKCE.

## Criterio para cerrar esta promoción

PR de feature integrado en development; PR development → testing integrado con sus checks aprobados; stack testing completo; landing y formulario de registro visibles; smoke testing aprobado y cuatro identidades temporales retiradas. La siguiente promoción a main requiere la prueba de la cuenta real del propietario y una instrucción posterior.
