# Identity: registro, organizaciones y derechos de uso

El alta pública usa Cognito con correo verificado y Authorization Code con PKCE. El cliente puede escribir únicamente atributos públicos permitidos, como correo y nombre; no puede escribir `custom:organizationId` ni `custom:roles`.

**Estado al 19 de noviembre de 2026:** el piloto publicado mediante [PR #10](https://github.com/LynxPardelle/abonos-por-evento/pull/10), `main` `05b02f31563d88285d22b5085d69d3ba757e6675`, está validado con una cuenta real en https://saldoevento.lynxpardelle.com. El catálogo y las tres funciones nuevas de cuenta descritas aquí pertenecen al incremento local todavía no desplegado. Stripe y Checkout permanecen desactivados.

## Contratos

- `createIdentityService({repository,selfRegistrationEnabled,now?}).ensureMembership(event)` obtiene o crea la membresía del sujeto verificado.
- `createPostConfirmationHandler({service})` atiende `PostConfirmation_ConfirmSignUp` y `PostConfirmation_ConfirmForgotPassword`. No envía correos adicionales.
- `createPreTokenHandler({service})` atiende los eventos Cognito de generación de ID token V1. Añade los claims `custom:organizationId`, `custom:roles` y `custom:tier`.
- `DynamoIdentityRepository({tableName,client?})` guarda un ítem por pool y `sub`, con lectura consistente y creación condicional. `MemoryIdentityRepository` permite probar la misma aplicación sin AWS.

La organización nueva tiene el identificador `org-` seguido de los primeros 32 caracteres hexadecimales de SHA-256 de `JSON.stringify([userPoolId,sub])`. El usuario recibe rol `admin` exclusivamente dentro de esa organización y tier `pilot`. `clientMetadata`, atributos de perfil públicos y cualquier elección de plan de la landing no conceden roles ni funciones pagadas.

PostConfirmation prepara la membresía tras la verificación. PreToken también puede crearla de manera idempotente si la verificación ya terminó y faltó esa preparación. Esta reparación cubre reintentos y permite probar con usuarios administrativos sintéticos sin enviarles correos. Sin correo verificado no se emiten los claims de acceso. Si `SelfRegistrationEnabled` es false, sólo pueden estrenarse membresías con organización y roles asignados previamente por la administración en los atributos protegidos.

Los atributos protegidos de cuentas administrativas existentes se respetan en su primera migración. Después, **IdentityTable es la fuente de verdad de la membresía**: cambiar `custom:roles` o `custom:organizationId` de Cognito no cambia una membresía persistida. Las filas `MEMBERSHIP` se conservan sin copiarlas ni resetearlas al cambiar un plan o añadir un equipo. Los claims `custom:organizationId`, `custom:roles` y `custom:tier:pilot` conservan compatibilidad; el claim de tier no concede un plan.

Una membresía suspendida o corrupta bloquea la emisión de nuevos tokens. Los ID tokens duran quince minutos, pero los handlers AWS de negocio resuelven acceso actual mediante IAM y lecturas consistentes antes de cada petición. Las escrituras agregan condiciones sobre snapshots de membresía y plan a su transacción DynamoDB, para rechazar una revocación o cambio de plan ocurrido entre resolver y confirmar. Una URL S3 PUT ya emitida conserva su validez de hasta cinco minutos; procesar un CSV no aplica abonos sin una nueva confirmación autorizada.

## Catálogo y organización activa

`services/shared/plans.mjs` define el catálogo versionado `2026-11-19.v1`:

| Código    | Eventos no archivados          | Plazas, incluido el propietario | Capacidades adicionales          |
| --------- | ------------------------------ | ------------------------------- | -------------------------------- |
| pilot     | Sin cuota comercial de eventos | 1                               | Operación básica existente       |
| event     | 1                              | 1                               | Cierre y exportación             |
| organizer | 5                              | 1                               | Plantillas y vista entre eventos |
| team      | 20                             | 5                               | Gestión de colaboradores         |

No hay precios, periodos de cobro, Stripe, Checkout, renovación o auto-upgrade. Una asignación manual concede evaluación del producto sin cargos. Una plaza incluye a toda persona colaboradora activa, también con rol auditor. Las cuotas no borran eventos ni ledger y no impiden recuperar la organización personal.

`accounts.mjs` resuelve el plan desde `ORG#{organizationId}/PLAN`; si falta, deriva un piloto sin escribir datos. Sólo una organización personal derivada correctamente de una membresía `source:self-registration` obtiene propietario y base de una plaza conocidos. Una organización administrativa antigua conserva sus roles básicos, pero no se autoasigna propietario ni se presupone una plaza: habilitar Equipo requiere una migración IAM explícita de la base histórica. Ese migrador queda fuera de este incremento y el intento devuelve `LEGACY_BASELINE_REQUIRED`.

Los registros nuevos de colaboradores son `POOL#{pool}#USER#{sub}/ORG#{organizationId}` con índice de consulta `ORG#{organizationId}/MEMBER#{memberId}`; la fila original `MEMBERSHIP` sigue siendo su organización base. Cambios, reactivaciones y revocaciones escriben ambos registros y el contador de plazas en la misma transacción. El lector no crea ni modifica ninguno de esos registros.

El header `X-SaldoEvento-Organization` es una selección candidata. El servidor consulta la membresía actual y no permite elegir otra organización desde cuerpo, claims de roles antiguos o atributos públicos. Sin header se utiliza la organización base. El frontend debe invalidar datos y volver a `/app` cuando cambie el contexto.

## Interfaces de acceso y equipo

- `createAccountsService({repository,usageReader?,userPoolId?,now?})`: `resolve`, `me`, `members`, `updateMember`, `revokeMember` y `admin`.
- `createAccessResolver({identityReader,userPoolId})`: factory de pruebas/local. `resolveAccess(request,requiredRoles,{eventId?,capability?})` usa en AWS `IDENTITY_RESOLVER_FUNCTION_NAME`, valida pool/sujeto y nunca hace fallback a los claims de autorización.
- `buildAccessConditions(actor,{tableName?})`: condiciones DynamoDB para añadir al commit de Eventos o Conciliación; `IDENTITY_TABLE` es el valor por defecto. Compara snapshots completos y no modifica sus arrays ni registros.
- `MemoryAccountsRepository({validateUsage})`: `seed(key,data)` para fixtures, `getItem`, `queryItems`, `transact` y `assertGuardsSync(actorOrGuards)`. Los dominios de memoria ejecutan este último chequeo y su mutación sin `await` intermedio.
- `validateUsage(guard)` debe ser síncrono y puede llamar `eventsRepository.assertUsageGuardSync`. El contador externo es `EventsTable: ORG#{organizationId}/USAGE#EVENTS`, con `version` y `nonArchivedCount` a nivel superior. Un grant de plan necesita ese chequeo en memoria y una `ConditionCheck` externa en DynamoDB.

| Ruta                                                           | Contrato y autorización                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET `/api/v1/me`                                               | Contexto actual, organizaciones permitidas, plan/capacidades/límites/uso; no muestra snapshots internos. |
| GET `/api/v1/organizations/current/members`                    | `{members,version}`; sólo propietario con capacidad `manageTeam`.                                        |
| POST `/api/v1/organizations/current/members/{memberId}/role`   | `{operationId,expectedVersion,roles,eventIds?}` → `{member}`; sólo propietario.                          |
| POST `/api/v1/organizations/current/members/{memberId}/revoke` | `{operationId,expectedVersion}` → `{member}`; sólo propietario.                                          |

`expectedVersion` de las rutas de miembro es la versión del miembro; la asignación IAM usa la versión del plan. Los colaboradores reciben únicamente `operator`, `importer`, `confirmer` o `auditor`. No se puede invitar o elevar a `admin`, cambiar propietario ni modificar su membresía desde esas rutas. `eventIds:null` permite todos los eventos de la organización; una lista limita los eventos y deniega siempre crear eventos, gestionar plantillas y consultar la vista global. Una membresía adicional deja de operar si desaparece su derecho de Equipo; su organización personal permanece accesible.

`/me` devuelve `homeOrganizationId`, `activeOrganizationId`, `organizations` y `organization:{organizationId,plan,capabilities,limits,usage}`. Las capacidades efectivas son `createEvent`, `manageParticipants`, `importPayments`, `confirmPayments`, `reversePayments`, `closeEvent`, `exportEvent`, `manageTemplates`, `viewOverview` y `manageTeam`. Los límites son `maxActiveEvents` y `maxSeats`; el uso de identidad es `{activeSeats,seatBaselineVerified}`. El conteo de eventos corresponde al servicio Eventos.

Invitaciones, envío de correo, enlaces con token y aceptación de invitaciones quedan diferidos explícitamente. Este incremento sólo permite altas de colaboradores mediante IAM a sujetos ya aprovisionados, y administración de sus roles o baja por el propietario.

## Funciones y permisos separados

- `identity/http.handler`: rutas autenticadas de cuenta y equipo; necesita `USER_POOL_ID`, `IDENTITY_TABLE` y permisos de lectura y transacción únicamente en IdentityTable.
- `identity/resolver.handler`: contrato IAM `{internal:{action:'resolveAccess',userPoolId,subject,organizationHint?,eventId?,requiredRoles?,capability?}}`; requiere sólo `GetItem` y `Query` en IdentityTable. Rechaza envelopes HTTP y no ejecuta aprovisionamiento.
- `identity/admin.handler`: contrato IAM `{internal:{action:'grantPlan'|'grantMember',...}}`, sin ruta HTTP o Function URL. `grantPlan` necesita organización, sujeto de su membresía base, código, operación y versión; `grantMember` utiliza el sujeto existente que recibirá la colaboración, roles y scope opcional. El escritor está separado del resolver: invocar al lector no permite conceder planes.

El administrador requiere `IDENTITY_TABLE`, `USER_POOL_ID`, `EVENTS_FUNCTION_NAME`, `EVENTS_TABLE`. Sólo obtiene uso mediante el RPC IAM `getUsage` de Eventos y puede incluir `ConditionCheckItem` sobre su contador. No escribe la tabla de Eventos. La condición conjunta evita que una creación/archivo/reapertura concurrente permita reducir el plan por debajo de su uso. Si el contador no existe, Eventos calcula el total actual y el grant exige que siga ausente: cualquier escritura nueva inicializa el contador y hace fallar esa condición.

Los servicios de negocio invocan únicamente el resolver y tienen la excepción de lectura condicional sobre IdentityTable para proteger el commit. Las acciones IAM se limitan a los ARN de funciones/tablas exactos; el cliente no recibe permisos AWS. Las operaciones guardan registro y resultado por `operationId` y una bitácora separada. La referencia del operador IAM enviada por el CLI es una referencia declarada del operador, no una identidad de llamada inferida por el handler Lambda.

## Asignación manual sin facturación

`scripts/Grant-EvaluationPlan.mjs` verifica cuenta, stack, ambiente, origen, pool y función administrativa exacta. Por defecto sólo lee STS/CloudFormation y muestra el payload; `--execute` es necesario para invocar al escritor. Producción exige además `--allow-production` y autorización de lanzamiento vigente. El output CloudFormation `IdentityAdminFunctionName` debe ser `saldoevento-{stage}-identity-admin`.

```powershell
# Vista previa: no modifica el plan. Sustituir UUID/org/version por datos verificados.
node scripts/Grant-EvaluationPlan.mjs --stack saldoevento-test --subject 11111111-1111-4111-8111-111111111111 --organization-id org-ejemplo --plan team --expected-version 0 --operation-id evaluacion-equipo-001

# Alta de un colaborador ya registrado: inicialmente sólo vista previa.
node scripts/Grant-EvaluationPlan.mjs --stack saldoevento-test --action grantMember --subject 22222222-2222-4222-8222-222222222222 --organization-id org-ejemplo --roles importer,auditor --event-ids evento-001 --expected-version 1 --operation-id colaborador-001
```

Después de revisar, se repite exactamente el mismo comando agregando `--execute`. Una repetición de la misma operación conserva su resultado original; reutilizarla con otros datos produce conflicto. Tras cualquier cambio se consulta `/me` o la lista de miembros para obtener las versiones actuales. No usar modificaciones directas de claims Cognito para conceder tiers o colaboración.

## Infraestructura y ambientes

`infra/template.yaml` incorpora IdentityTable cifrada bajo demanda y con conservación Retain. El incremento local define **cinco funciones de Identidad**: dos triggers Cognito existentes y las funciones separadas de resolver IAM, cuenta HTTP y administración IAM. Los triggers conservan permisos de invocación restringidos al ARN del pool y a la cuenta; el resolver sólo lee; los escritores de cuenta y administración modifican exclusivamente IdentityTable. La excepción del administrador es lectura condicional del contador de EventsTable dentro de la transacción, nunca escritura de eventos. Ninguna de estas funciones administra usuarios Cognito.

El parámetro `SelfRegistrationEnabled` es false por defecto. Los ambientes development y testing lo activan explícitamente. El lanzamiento aprobado del piloto en producción utiliza un override efectivo `true`, conservado en el comprobante de despliegue, aunque el archivo base de parámetros siga cerrado. El flujo administrativo `ALLOW_ADMIN_USER_PASSWORD_AUTH` se habilita únicamente en dev/test para smoke con IAM y usuarios temporales SUPPRESS; permanece deshabilitado en producción. La aplicación pública usa Code/PKCE, sin secreto de cliente ni password grant público.

La confirmación de correo de un registro real la entrega Cognito como parte del alta iniciada por la persona. Las pruebas automáticas no envían mensajes. El piloto de producción ya tiene aceptación con cuenta real; esa evidencia no acredita el despliegue o la aceptación de las funciones nuevas del incremento local. Su promoción y verificación se registran por separado, sin conservar contraseñas, códigos de verificación, cookies o tokens.

## Verificación

```powershell
node --test services/identity/*.test.mjs scripts/Grant-EvaluationPlan.test.mjs services/events/access-integration.test.mjs
npm --prefix web test -- --watch=false --include=src/app/core/session.spec.ts
cfn-lint infra/template.yaml
```

Las pruebas cubren aislamiento por pool/sujeto, preservación de membresías, claims maliciosos ignorados, concurrencia de plazas, actualización/revocación, scopes de evento, cambios de uso entre lectura y commit, separación de handlers IAM/HTTP y condiciones DynamoDB sin doble acción sobre el mismo ítem. Las pruebas del CLI inyectan lecturas e invocación falsas: no ejecutan AWS ni crean usuarios. Las integraciones de Eventos prueban revocación y downgrade frente a actores o conteos obsoletos.

Referencias primarias: [PostConfirmation](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-post-confirmation.html), [PreTokenGeneration V1](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html), [configuración CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cognito-userpool-pretokengenerationconfig.html) y [páginas alojadas Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-authentication-approach.html).
