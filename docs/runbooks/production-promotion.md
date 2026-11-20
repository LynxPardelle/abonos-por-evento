# Promoción y actualización conservadora de producción

Este procedimiento actualiza **el stack existente `saldoevento-prod`**, en la cuenta `765932874577`, región `us-east-1`. No crea otra producción ni migra usuarios o datos. El origen principal es `https://saldoevento.zooberiahsystems.com`; `https://saldoevento.lynxpardelle.com` permanece compatible, sin redirección, sobre la misma distribución CloudFront, pool, cliente, tablas y buckets. Stripe permanece deshabilitado; los planes de evaluación se asignan por IAM, sin cobros ni auto-upgrade.

El flujo de promoción es `development → testing → main`. Ejecutar este helper requiere autorización de producción y un checkout **main limpio cuyo HEAD coincida con el main remoto**. El helper no modifica ramas, no hace fetch, merge, commit ni push. Sus pruebas locales usan AWS/Git simulados; no sustituyen una verificación de producción.

## Preparar la promoción

1. Completar el PR de testing a main y revisar sus verificaciones. Usar el checkout main publicado y limpio. Conservar el checkout/testing y las evidencias existentes.
2. Confirmar que `infra/environments/prod.json` contiene exactamente los cinco parámetros: `Stage=prod`, `PublicOrigin=https://saldoevento.zooberiahsystems.com`, `HostedZoneId=Z00733952JM7567FL6HXC`, `SelfRegistrationEnabled=true` y el ARN del certificado ACM aprobado, en `us-east-1` y en la cuenta indicada. El certificado debe estar **ISSUED** y contener ambos nombres explícitos en sus SAN. No se fija un ARN de certificado en el helper.
3. Confirmar los mappings del template: dominio nuevo como principal, dominio y zona anteriores compatibles (`Z05088763QG63CC5SE7PN`). Los registros DNS antiguos conservan sus logical IDs; se agregan los registros nuevos. Revisar ambos callbacks/logout de Cognito, CORS y aliases. No cambiar el pool ni el cliente para resolver diferencias de configuración.
4. Disponer de AWS CLI, PowerShell 7, Node y npm y dependencias ya instaladas según los lockfiles. No usar `NODE_TLS_REJECT_UNAUTHORIZED=0`; cuando el entorno lo necesite, `NODE_USE_SYSTEM_CA=1` sólo en el proceso.
5. Ejecutar las verificaciones y empaquetar desde el commit de main. El modo normal del helper ejecuta `npm test`, `test:web`, `build:web`, `package:frontend`, `validate:infra` y `smoke:frontend`. Ejecutar también `cfn-lint infra/template.yaml` como revisión de infraestructura. No usar el smoke administrativo de testing en producción: el cliente prod excluye `ALLOW_ADMIN_USER_PASSWORD_AUTH`.

## Preparar y revisar el UPDATE

Desde el checkout main, con un nombre nuevo por propuesta:

```powershell
pwsh -NoProfile -File scripts/Deploy-Production.ps1 -ChangeSetName saldoevento-prod-tiers-domain
```

El modo predeterminado sube los paquetes al bootstrap existente `saldoevento-artifacts` y crea un change set **UPDATE**, pero no lo ejecuta ni publica assets. Si las verificaciones ya se ejecutaron sobre ese mismo commit y artefacto, se puede usar evidencia local:

```powershell
pwsh -NoProfile -File scripts/Deploy-Production.ps1 `
  -ChangeSetName saldoevento-prod-tiers-domain `
  -SkipChecks -ChecksEvidencePath artifacts/deployments/prod/checks.json
```

La evidencia JSON debe contener `passed: true`, `sourceCommit` igual al main remoto y `frontendContentSha256` igual a `artifacts/frontend/manifest.json`. No reutilizar evidencia de otro commit, aunque su contenido aparente ser igual. El helper guarda los parámetros efectivos sin introducir overrides ocultos.

Revisar en `artifacts/deployments/prod/` los archivos `<nombre>.json`, `.metadata.json`, `.parameters.json` y `.packaged.yaml`. La metadata fija SHA-256 del helper, template fuente, parámetros fuente/efectivos, template empaquetado, manifiesto, evidencia y review; conserva además las identidades físicas protegidas y las huellas de baseline y destino. El manifiesto se valida por commit, hash agregado del mapa, checksum de cada archivo y conjunto exacto de archivos, sin rutas escapadas ni reparse points.

El helper rechaza creación, eliminación y reemplazo `True` o `Conditional` de recursos protegidos: tablas, buckets, pool/cliente/dominio Cognito, distribución CloudFront y API. Rechaza también nuevas copias de esos recursos para evitar un cambio de identidad o almacenamiento implícito. Las seis entidades con datos conservan `DeletionPolicy` y `UpdateReplacePolicy` en `Retain`. También rechaza reemplazos de otros recursos; sólo permite el caso técnico de permisos Lambda. Una eliminación de permiso Lambda requiere revisar su sustitución equivalente en el change set; no es permiso para retirar acceso necesario. Si estas guardas bloquean una migración legítima, preparar una migración separada; no aflojarlas para forzar este lanzamiento.

Revisar que no existan `ALLOW_USER_PASSWORD_AUTH`, flujo administrativo prod, SDK de Stripe, endpoints de pago ni variables de Stripe/billing activas. La guardia del helper cubre los flujos explícitos, dependencias declaradas y endpoints/SDK en el artefacto; completar la inspección funcional de runtime-config tras desplegar.

## Ejecutar el review exacto

```powershell
pwsh -NoProfile -File scripts/Deploy-Production.ps1 `
  -Execute -ChangeSetName saldoevento-prod-tiers-domain
```

La ejecución vuelve a comprobar main remoto, los inputs, certificado, change set vivo y recursos existentes. Antes de ejecutar CloudFormation carga únicamente assets con nombre versionado (chunks Angular) al bucket existente, con cache inmutable. No borra chunks anteriores, no usa `--delete` y no publica HTML estático: el HTML lo sirve Angular SSR en Lambda. Así las páginas nuevas encuentran sus chunks desde el primer momento y las páginas abiertas conservan los anteriores.

Los assets con nombre estable (favicon, CSV de ejemplo y fuentes, entre otros) se publican con TTL de 300 segundos **después** de que el UPDATE complete y las identidades/params/template se atestigüen. El diseño evita cambiarlos anticipadamente bajo la versión anterior. Una nueva dependencia crítica con nombre estable debe evaluarse durante el review: conviene versionar su nombre en la aplicación. El helper espera finalmente a que la distribución preservada esté `Deployed` y comprueba ambos aliases; guarda `<nombre>.completed.json` sin credenciales ni tokens.

## Reanudación y fallos

Repetir el mismo comando `-Execute` con los mismos archivos y nombre. No crear otro change set para resolver solamente una subida de assets interrumpida:

- `AVAILABLE`: valida que la baseline no cambió, precarga chunks y ejecuta una vez con token idempotente estable.
- `EXECUTE_IN_PROGRESS`: vuelve a precargar de forma idempotente y espera el UPDATE existente; no ejecuta otro.
- `EXECUTE_COMPLETE`: exige stack `UPDATE_COMPLETE`, template original y parámetros de destino exactos y las mismas identidades físicas; completa la publicación y espera CloudFront. Nunca ejecuta el change set por segunda vez.
- `OBSOLETE`, rollback o estado fallido: se detiene. Si la stack tiene un template posterior o cambiaron los inputs, preparar un nuevo review a partir del estado actual. No borrar/recrear la stack, pool, cliente o buckets. No continuar un rollback de forma automática.

Los chunks precargados que un UPDATE fallido no use pueden permanecer: son aditivos y el helper no realiza limpieza destructiva. Un fallo después de CloudFormation no significa que la aplicación siga en la versión anterior; consultar el estado del stack y reanudar con su review. Conservar los artefactos y hashes para auditoría y recuperación. El helper no ejecuta rollback automático ni cambia datos de negocio.

## Verificación posterior y aceptación

1. Verificar DNS/TLS, `/health`, HTML SSR, assets de ese manifiesto, `/runtime-config.json` sin caché y respuestas `401` sin identidad en rutas protegidas, en **ambos dominios**. Confirmar que ambos conservan el mismo pool/cliente/API/distribución y que el host antiguo funciona sin redirección. No publicar IDs privados, tokens, correos o URLs firmadas en reportes.
2. Comprobar en Cognito sólo con lecturas administrativas que el cliente sigue siendo público, OAuth code/PKCE, callbacks/logout de ambos hosts, atributos organizacionales no escribibles y sin flujo administrativo prod. Confirmar el parámetro efectivo de registro habilitado y Stripe/billing deshabilitados.
3. En navegador, probar landing, acceso y registro/callback en el host nuevo con credenciales/OTP introducidos por el usuario. Verificar acceso de una cuenta ya existente; no volver a provisionarla ni copiar membresías para migrar el dominio. Los dos hosts son orígenes de navegador distintos: una sesión local del host antiguo no implica sesión local en el nuevo; Cognito puede reutilizar su sesión del pool cuando corresponda.
4. Con autorización de datos de prueba, verificar `/app/plan`, cambio de organización, cuotas, cierre/exportación/histórico, plantillas/overview y Equipo administrado/revocación fresca. Separar hechos observados de pasos pendientes; no marcar aceptación humana por un chequeo HTTP.
5. Registrar commit, hashes, change set y resultados sanitizados en la evidencia del release. Mantener Stripe OFF y dejar cualquier alta/cobro comercial para su autorización e implementación posteriores.

Referencias de contratos AWS: [describe-change-set y estados de ejecución](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/describe-change-set.html), [semántica de Replacement](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_ResourceChange.html), [template Original para atestación](https://docs.aws.amazon.com/cli/latest/reference/cloudformation/get-template.html).
