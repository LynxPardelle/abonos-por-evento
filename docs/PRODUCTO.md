# SaldoEvento

**Cada abono en su lugar.** Conciliación de pagos externos y saldos por participante para organizadores de eventos.

## Primera versión

La entrada pública es un sitio comercial en `/`, con un recorrido ilustrativo, capacidades actuales y planes propuestos. `/registro` abre el alta del piloto en Cognito cuando el ambiente lo permite; después de confirmar el correo, el servidor crea una organización propia para la cuenta. La persona entra a `/app` sin elegir tenant ni concederse permisos desde el navegador.

Un evento trabaja con una sola moneda: MXN, USD o EUR, todas con dos unidades decimales en este piloto. El organizador registra participantes y sus importes acordados, carga el CSV documentado y revisa sugerencias. Un operador confirma cada abono. Los movimientos confirmados son la fuente de verdad; las filas importadas nunca modifican el saldo por sí solas.

**Flujo:** conocer el producto → registrarse y verificar correo → entrar a `/app` → crear evento → registrar participantes → importar CSV → revisar evidencia → confirmar abono → consultar saldo → reversar con referencia al original. Las pruebas automáticas usan datos sintéticos.

El archivo puede incluir pagos parciales y referencias ambiguas. Se conservan filas rechazadas. Reenviar un archivo o una operación no debe duplicar abonos. El reverso añade un movimiento compensatorio; no elimina ni edita movimientos confirmados.

También se registra un abono manual cuando el operador ya verificó un comprobante externo, con referencia única y confirmación explícita. La importación y el registro manual llevan el control de pagos externos; SaldoEvento no procesa el dinero de los participantes.

## Qué se entrega

Una aplicación Angular con landing, pantalla de registro, rutas operativas, estado por flujo y frontend SSR servido por Lambda. Los dominios Eventos y Conciliación tienen Lambdas y almacenamiento separados. El importador procesa archivos de manera asíncrona y los errores agotados quedan en DLQ. Identidad conserva membresías en IdentityTable y emite los claims de organización/rol mediante triggers del servidor.

La URL de producto prevista es **https://saldoevento.lynxpardelle.com**. Desarrollo y pruebas usan `saldoevento-dev` y `saldoevento-test` bajo el mismo dominio.

## Modelo comercial

El **Piloto** permite probar las capacidades actuales sin tarjeta donde el registro esté habilitado. Los tiers **Por Evento**, **Organizador** y **Equipo** están en diseño: conservan el modelo por evento y proponen suscripción mensual/anual para trabajo recurrente o compartido. Los precios y cuotas aún no están aprobados ni aplicados por el backend. La primera versión no incorpora Checkout, facturación, cobros Stripe ni procesamiento de pagos a participantes.

[PLANES.md](PLANES.md) separa las funciones disponibles, las propuestas de cada tier y los criterios que faltan para venderlo. La landing no debe anunciar invitaciones de equipo, exportación, integración bancaria, auditoría completa o SLA como prestaciones entregadas. Medir tiempo de cierre, movimientos sin asignar, correcciones y repetición de uso antes de fijar un precio.

## Aceptación y promoción

La entrega se integra mediante PR a `development` y se promueve a `testing` con verificaciones del mismo commit. El estado de ejecución se consulta en los PR, CI y reportes del ambiente. **`main` queda pendiente hasta que el propietario complete la prueba con su cuenta**, incluida la recepción del correo, el registro y un cierre autorizado. Las pruebas administrativas sintéticas no sustituyen esa aceptación.

## Identidad del producto

SaldoEvento sustituye al nombre descriptivo Abonos por Evento. El criterio de elección y la revisión pública de nombres se documentan en [la decisión de diseño](architecture/2026-11-19-saldoevento-design.md). No se afirma exclusividad registral.

## Origen y datos

Proyecto propio a partir del problema comercial de control de eventos y asistentes. Los esquemas, contratos y ejemplos de este repositorio son nuevos. Las pruebas y el modo local usan exclusivamente participantes y movimientos sintéticos.
