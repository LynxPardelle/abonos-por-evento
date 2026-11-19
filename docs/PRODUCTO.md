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

La URL publicada del piloto es **https://saldoevento.lynxpardelle.com**. Desarrollo y pruebas usan `saldoevento-dev` y `saldoevento-test` bajo el mismo dominio.

## Modelo comercial

El **Piloto** permite registrar eventos, participantes, importaciones, confirmaciones, saldos y reversos sin tarjeta. El incremento de evaluación implementa capacidades para **Por Evento**, **Organizador** y **Equipo**, asignadas por un administrador con IAM. Los modelos de venta por evento y mensual/anual siguen por validar; no hay precio aprobado, contratación, Checkout ni cobros Stripe.

| Evaluación | Eventos en trabajo / personas | Capacidades implementadas en el incremento local |
| --- | --- | --- |
| Piloto | Sin nueva cuota comercial / 1 | Flujo básico existente; conserva sus registros. |
| Por Evento | 1 / 1 | Piloto más cierre financiero con fotografía inmutable y exportación CSV. |
| Organizador | 5 / 1 | Por Evento más plantillas de preparación y vista de eventos en trabajo por moneda. |
| Equipo | 20 / 5 | Organizador más colaboradores con alta asistida, roles, alcance por evento y revocación por el propietario. |

Un evento cerrado sigue en trabajo hasta archivarlo. Archivar libera cupo sin borrar movimientos ni reportes; reabrir comprueba capacidad antes de permitir operaciones financieras. El cierre fija el ledger y la lista capturada para el reporte, sin congelar toda la información del evento. Una plantilla copia únicamente participantes, referencias e importes acordados; el evento nuevo comienza sin abonos. El cupo de personas incluye al propietario y a los auditores.

[PLANES.md](PLANES.md) distingue las capacidades implementadas localmente de las ya publicadas y los criterios pendientes para venderlas. No anunciar funciones locales como disponibles en producción antes de desplegarlas y verificarlas. Las invitaciones por enlace, la integración bancaria, la auditoría universal y un SLA quedan pendientes. Medir tiempo de cierre, movimientos sin asignar, correcciones y repetición de uso antes de fijar un precio.

## Aceptación y promoción

El piloto completó **development → testing → main** con los PR #8, #9 y #10. El propietario autorizó producción y completó el registro y el flujo real con datos sintéticos: dos confirmaciones sumaron 1250.00 MXN, un reverso de 500.00 dejó 750.00 confirmados, 1250.00 pendientes y tres movimientos conservados tras recargar. [Evidencia de producción](verificacion/production-2026-11-19.json).

El incremento de suscripciones está implementado y verificado localmente en `codex/subscription-tiers`, basado en development. **Todavía no está desplegado** y requiere promoción y aceptación propias. [Plan del incremento](../plan/feature-subscription-tiers-1.md). La aceptación del piloto no acredita los cierres ni las capacidades nuevas en AWS.

## Identidad del producto

SaldoEvento sustituye al nombre descriptivo Abonos por Evento. El criterio de elección y la revisión pública de nombres se documentan en [la decisión de diseño](architecture/2026-11-19-saldoevento-design.md). No se afirma exclusividad registral.

## Origen y datos

Proyecto propio a partir del problema comercial de control de eventos y asistentes. Los esquemas, contratos y ejemplos de este repositorio son nuevos. Las pruebas y el modo local usan exclusivamente participantes y movimientos sintéticos.
