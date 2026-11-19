# Promoción de SaldoEvento a testing

La entrega sigue **feature → development → testing**, antes de una promoción separada a main. El piloto ya completó la aceptación real y se publicó mediante PR #10 en main `05b02f3`. El incremento de suscripciones continúa local y necesita sus propias verificaciones y aceptación. Este procedimiento no publica a producción ni habilita Stripe.

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

## Capacidades de evaluación

El incremento de suscripciones requiere también el smoke exclusivo de testing:

```powershell
node scripts/smoke-subscriptions-testing.mjs --region us-east-1
```

Además del flujo básico de CSV/S3/SQS, esta prueba debe comprobar planes actuales, cupos, detalle de evento por HTTP, cierre y CSV histórico, archivo/reapertura, plantillas, vista por moneda y colaboración con revocación usando identidades temporales. El reporte no debe contener sujetos, organizaciones o eventos privados, correos, contraseñas, tokens ni URL firmadas. Deben retirarse todas las cuentas temporales antes de declarar éxito. Las fronteras de 20 eventos y 5 personas de Equipo se cubren con pruebas de concurrencia; el smoke no necesita crear 21 eventos o seis personas para repetirlas.

El recibo de despliegue debe fijar el SHA de testing, la CI aprobada para ese SHA, la huella del frontend, el change set ejecutado, el estado final del stack y los resultados sanitizados. Comprobar también HTML/configuración, hashes de assets públicos, rechazos sin JWT y preflight del header de organización. Esos resultados no sustituyen la prueba del propietario con su cuenta antes de main.

## Recuperación de una entrega

Se revisa el change set antes de ejecutarlo; tablas, pool y buckets existentes se conservan. Los bundles JS/CSS versionados del artefacto verificado pueden precargarse únicamente al bucket de testing antes de actualizar la Lambda SSR, sin borrados, para reducir la ventana entre HTML nuevo y publicación de assets. El script termina publicando los assets restantes.

Retener los datos no hace seguro volver a cualquier backend anterior. Después de crear cierres, planes o colaboradores, no se debe restaurar el backend del piloto `05b02f3` para seguir operando: no entiende el estado financiero cerrado, las cuotas ni la revocación actual. Si falla el incremento después de introducir ese estado, se detienen mutaciones en testing y se corrige hacia adelante o se restaura una versión compatible con esos controles. No borrar el historial ni alterar el ledger para simular una recuperación.

## Criterio para cerrar esta promoción

PR de feature integrado en development; PR development → testing integrado con sus checks aprobados; stack testing completo; landing y formulario de registro visibles; smoke básico y smoke de tiers aprobados y todas sus identidades temporales retiradas. La siguiente promoción a main requiere la prueba de los tiers con la cuenta real del propietario y una instrucción posterior. Stripe y Checkout continúan desactivados.
