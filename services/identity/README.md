# Identity: registro y organización inicial

El alta pública usa Cognito con correo verificado y Authorization Code con PKCE. El cliente puede escribir únicamente atributos públicos permitidos, como correo y nombre; no puede escribir `custom:organizationId` ni `custom:roles`.

## Contratos

- `createIdentityService({repository,selfRegistrationEnabled,now?}).ensureMembership(event)` obtiene o crea la membresía del sujeto verificado.
- `createPostConfirmationHandler({service})` atiende `PostConfirmation_ConfirmSignUp` y `PostConfirmation_ConfirmForgotPassword`. No envía correos adicionales.
- `createPreTokenHandler({service})` atiende los eventos Cognito de generación de ID token V1. Añade los claims `custom:organizationId`, `custom:roles` y `custom:tier`.
- `DynamoIdentityRepository({tableName,client?})` guarda un ítem por pool y `sub`, con lectura consistente y creación condicional. `MemoryIdentityRepository` permite probar la misma aplicación sin AWS.

La organización nueva tiene el identificador `org-` seguido de los primeros 32 caracteres hexadecimales de SHA-256 de `JSON.stringify([userPoolId,sub])`. El usuario recibe rol `admin` exclusivamente dentro de esa organización y tier `pilot`. `clientMetadata`, atributos de perfil públicos y cualquier elección de plan de la landing no conceden roles ni funciones pagadas.

PostConfirmation prepara la membresía tras la verificación. PreToken también puede crearla de manera idempotente si la verificación ya terminó y faltó esa preparación. Esta reparación cubre reintentos y permite probar con usuarios administrativos sintéticos sin enviarles correos. Sin correo verificado no se emiten los claims de acceso. Si `SelfRegistrationEnabled` es false, sólo pueden estrenarse membresías con organización y roles asignados previamente por la administración en los atributos protegidos.

Los atributos protegidos de cuentas administrativas existentes se respetan en su primera migración. Después, **IdentityTable es la fuente de verdad de la membresía**: cambiar `custom:roles` o `custom:organizationId` de Cognito no cambia una membresía persistida. La administración debe editar o suspender el registro correspondiente en IdentityTable mediante su acceso IAM autorizado. No hay un endpoint público para cambiar membresías, invitar usuarios ni activar tiers de pago en esta primera versión.

Una membresía suspendida o corrupta bloquea la emisión de nuevos tokens. Los ID tokens ya emitidos pueden seguir aceptándose hasta su caducidad de 15 minutos: la API valida JWT y no consulta IdentityTable en cada operación. El control de revocación inmediata y las invitaciones de equipo pertenecen a una ampliación posterior.

## Infraestructura y ambientes

`infra/template.yaml` incorpora IdentityTable cifrada bajo demanda y con conservación Retain, dos funciones separadas y permisos de invocación de Cognito restringidos al ARN del pool y a la cuenta. Las funciones sólo leen/escriben IdentityTable; no administran usuarios Cognito ni acceden a las tablas financieras.

El parámetro `SelfRegistrationEnabled` es false por defecto. Los ambientes development y testing lo activan explícitamente; producción permanece desactivado hasta la aprobación de lanzamiento. El flujo administrativo `ALLOW_ADMIN_USER_PASSWORD_AUTH` se habilita únicamente en dev/test para smoke con IAM y usuarios temporales SUPPRESS. La aplicación pública usa Code/PKCE, sin secreto de cliente ni password grant público.

La confirmación de correo de un registro real la entrega Cognito como parte del alta iniciada por la persona. Las pruebas automáticas de este repositorio no envían mensajes. El formulario y la entrega del código de verificación deben comprobarse con una cuenta humana antes de publicar en main.

## Verificación

```powershell
node --test services/identity/identity.test.mjs infra/template.test.mjs scripts/validate-infra.test.mjs
npm --prefix web test -- --watch=false --include=src/app/core/session.spec.ts
cfn-lint infra/template.yaml
```

Las pruebas cubren aislamiento por pool/sujeto, reintentos, atributos administrativos, metadatos maliciosos ignorados, correo sin verificar, membresía suspendida y creación DynamoDB concurrente. SessionService prueba la URL signup/signin, PKCE, estado del callback, intercambio único y limpieza de sesión corrupta.

Referencias primarias: [PostConfirmation](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-post-confirmation.html), [PreTokenGeneration V1](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html), [configuración CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cognito-userpool-pretokengenerationconfig.html) y [páginas alojadas Cognito](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-authentication-approach.html).
