# SaldoEvento

**Cada abono en su lugar.** Conciliación de pagos externos y saldos por participante para organizadores de eventos.

## Primera versión

Un evento trabaja con una sola moneda: MXN, USD o EUR, todas con dos unidades decimales en este piloto. El organizador registra participantes y sus importes acordados, carga el CSV documentado y revisa sugerencias. Un operador confirma cada abono. Los movimientos confirmados son la fuente de verdad; las filas importadas nunca modifican el saldo por sí solas.

**Flujo:** crear evento → registrar participantes → importar CSV sintético → revisar evidencia → confirmar abono → consultar saldo → reversar con referencia al original.

El archivo puede incluir pagos parciales y referencias ambiguas. Se conservan filas rechazadas. Reenviar un archivo o una operación no debe duplicar abonos. El reverso añade un movimiento compensatorio; no elimina ni edita movimientos confirmados.

## Qué se entrega

Una aplicación Angular con rutas operativas, estado por flujo y frontend SSR servido por Lambda. Los dominios Eventos y Conciliación tienen Lambdas y almacenamiento separados. El importador procesa archivos de manera asíncrona y los errores agotados quedan en DLQ.

La URL de producto prevista es **https://saldoevento.lynxpardelle.com**. Desarrollo y pruebas usan `saldoevento-dev` y `saldoevento-test` bajo el mismo dominio.

## Modelo comercial

Cobro por evento y plan anual para organizadores recurrentes. Medir tiempo de cierre, movimientos sin asignar y correcciones. La primera versión no incorpora checkout, facturación ni procesamiento de pagos.

## Identidad del producto

SaldoEvento sustituye al nombre descriptivo Abonos por Evento. El criterio de elección y la revisión pública de nombres se documentan en [la decisión de diseño](architecture/2026-11-19-saldoevento-design.md). No se afirma exclusividad registral.

## Origen y datos

Proyecto propio a partir del problema comercial de control de eventos y asistentes. Los esquemas, contratos y ejemplos de este repositorio son nuevos. Las pruebas y el modo local usan exclusivamente participantes y movimientos sintéticos.
