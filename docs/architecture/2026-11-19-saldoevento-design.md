# SaldoEvento: primera versión en microservicios

Decisión del 19 de noviembre de 2026, aplicada a petición del propietario para revisar la arquitectura, adoptar una marca de producto y avanzar de forma autónoma.

## Producto y nombre

**SaldoEvento** sustituye a Abonos por Evento en la interfaz, los paquetes, los recursos nuevos y la documentación. Mensaje: **Cada abono en su lugar.** El nombre comunica el resultado del producto: conciliar pagos externos y obtener saldos trazables por participante. No se procesan pagos ni se almacenan datos bancarios completos.

Se comparó con CuadraEvento y AbonaEvento. Las raíces Cuadra y Abona ya aparecen en productos próximos, mientras la búsqueda pública exacta de SaldoEvento no mostró una coincidencia identificable. Esa búsqueda es una comprobación editorial, no una autorización registral. Referencias: [Abona](https://abona.mx/), [Cuadra](https://www.cuadra.cloud/terminos.html), [YaCuadra](https://www.yacuadra.com/co/legal/terminos).

La carpeta y el remoto histórico `abonos-por-evento` conservan su función como localizadores técnicos. Renombrar un repositorio remoto o mover el checkout utilizado para continuar desde remoto es una operación distinta de adoptar la marca en el producto.

## Arquitectura elegida

Un monorepo contiene unidades desplegables separadas: frontend Angular SSR, Eventos, Conciliación e importador asíncrono. Eventos posee sus datos y Conciliación los suyos. Los servicios no leen directamente la tabla del otro; Conciliación obtiene el contexto del evento a través de una invocación IAM de Eventos. El worker pertenece al dominio Conciliación y comparte su almacenamiento, no constituye un tercer dominio de negocio.

El patrón del frontend coincide con el portafolio existente: Angular SSR y Express, adaptador `serverless-http`, Lambda Node.js 24 ARM64, Function URL con autenticación AWS_IAM y CloudFront Origin Access Control. CloudFront sirve `/api/*` desde HTTP API sin caché, el HTML mediante Lambda sin caché y los archivos versionados desde S3 privado. Las fuentes se entregan desde el mismo sitio.

Alternativas evaluadas: una SPA exclusivamente en S3 simplifica la operación, pero no cumple el frontend mediante Lambda solicitado; un contenedor permanente agrega operación y capacidad ociosa al piloto; Step Functions se reserva para importaciones con varias etapas que necesiten reanudación independiente.

## Identidad y límites de datos

El acceso usa Cognito y autorización OAuth con código y PKCE. API Gateway verifica el JWT y cada servicio comprueba identidad, organización y rol. Organización y roles son atributos administrados por el operador de infraestructura; el cliente no puede escribirlos. Las claves de datos incluyen organización y evento. Ningún cuerpo de petición ni cabecera de organización concede acceso.

Los roles distinguen importación, confirmación y lectura; el administrador y el operador tienen las combinaciones documentadas en el contrato. La autorización de infraestructura impide invocaciones internas desde el navegador. Los tokens se conservan en la sesión del navegador y no se incorporan al HTML SSR ni al código compilado.

## Flujo y errores

1. Crear evento con una moneda y participantes con referencia e importe acordado.
2. Calcular SHA-256 del CSV; iniciar un batch idempotente y obtener una URL de carga temporal.
3. Cargar en S3 privado; la notificación pasa por SQS y un worker verifica contenido, huella y moneda.
4. Persistir filas rechazadas y sugerencias. Una referencia ambigua exige elección humana.
5. Confirmar un abono con identificador estable y versión esperada. Una transacción registra el movimiento inmutable y actualiza el saldo.
6. Consultar saldos y movimientos. Un reverso añade un movimiento compensatorio y referencia el original.

Los importes viajan como cadenas de unidades monetarias menores y se calculan con enteros. Repetir una solicitud devuelve su resultado o un conflicto si el contenido cambió. Las confirmaciones concurrentes usan control de versión. Los fallos recuperables del worker se devuelven como fallos parciales de batch; la DLQ conserva los mensajes agotados para revisión y replay controlado.

## Dominios y promoción

| Ambiente | Rama de promoción | URL prevista |
| --- | --- | --- |
| Desarrollo | development | https://saldoevento-dev.lynxpardelle.com |
| Pruebas | testing | https://saldoevento-test.lynxpardelle.com |
| Producción | main | https://saldoevento.lynxpardelle.com |

La zona y el certificado son parámetros de infraestructura. El certificado de CloudFront debe estar en `us-east-1`. La promoción conserva **development → testing → main** y los controles existentes. Una URL configurada no implica que el sitio ya esté desplegado.

## Verificación y cierre

Las verificaciones cubren reglas monetarias, idempotencia, reversos, autorización, aislamiento de organizaciones, parser CSV, fallos parciales, frontend, SSR y estructura de SAM. El piloto local usa exclusivamente datos sintéticos y adaptadores en memoria; no acredita DynamoDB, Cognito, SQS ni entrega real en AWS. Esas comprobaciones se registran separadamente antes de una promoción.
