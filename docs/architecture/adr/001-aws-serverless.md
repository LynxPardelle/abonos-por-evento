# AWS Lambda y microservicios para SaldoEvento

**Estado:** aceptada para la primera versión, ampliada el 19 de noviembre de 2026 a petición del propietario.

Eventos posee participantes, moneda e importes acordados. Conciliación posee batches, movimientos y saldos. Cada servicio tiene Lambda y tabla propias; la lectura del contexto de Eventos desde Conciliación se hace mediante contrato interno e IAM. El importador es un worker del dominio Conciliación.

El frontend también usa Lambda: Angular SSR/Express con serverless-http, Function URL AWS_IAM y CloudFront OAC, conforme al patrón del portafolio. Los archivos estáticos se sirven por un origen S3 privado. HTTP API valida JWT Cognito y los servicios autorizan cada recurso por organización y rol. Los subdominios son saldoevento-dev, saldoevento-test y saldoevento bajo lynxpardelle.com.

Los movimientos confirmados son inmutables. Abono y reverso son funciones puras de importes enteros; las escrituras persistentes usan control de versión e idempotencia. S3 alimenta SQS Standard con DLQ. La Lambda de importación verifica huella, tamaño, moneda y estructura, registra sugerencias y fallos parciales, y no aplica abonos automáticamente.

Las funciones escalan por invocación y DynamoDB usa capacidad bajo demanda. Se difiere un contenedor permanente hasta que exista carga sostenida y Step Functions hasta que haya varias etapas con recuperación independiente. S3, logs, datos y otros recursos retenidos pueden generar cargos aun sin invocaciones; las políticas de retención y los límites se declaran por ambiente.

- [Angular SSR](https://angular.dev/guide/ssr)
- [CloudFront OAC y Lambda Function URL](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)
- [Lambda y SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
- [Transacciones DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transactions.html)
