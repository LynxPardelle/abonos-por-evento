# AWS Lambda para los servicios de dominio

**Estado** Aceptada para la base.

Eventos es dueño de participantes y montos acordados. Conciliación es dueña del ledger y de la proyección de saldo. La API acepta y consulta batches. La Lambda de importación valida estructura, tamaño, moneda e idempotencia y emite sugerencias en un proceso asíncrono. La confirmación es explícita y ejecuta una transacción DynamoDB para anexar el movimiento y actualizar el saldo. Los movimientos confirmados son inmutables y un reverso tiene su propia identidad y apunta al original.

Las funciones escalan por invocación y permiten publicar contratos separados a medida que se desarrollan los dominios. DynamoDB bajo demanda se ajusta a solicitudes variables. Los recursos se describen con SAM para reproducir la configuración y revisar permisos. Se consideró un servicio en contenedor cuando hay trabajo sostenido o bibliotecas con dependencias pesadas. La carga prevista del piloto es intermitente y se ajusta a Lambdas breves.

S3 privado entrega la clave del objeto a una cola SQS Standard con DLQ. La Lambda registra el hash del archivo dentro de organización y evento. Usa reporte parcial de fallos de batch y claves estables para repetición de filas. Step Functions Standard entraría cuando un batch tenga varias etapas que necesiten historial y reanudación independiente. La revisión humana se persiste como estado del batch en DynamoDB.

- [Lambda con Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
- [Transacciones DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transactions.html)
- [Flujos de AWS Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
