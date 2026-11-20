# Planes de SaldoEvento

**Estado al 19 de noviembre de 2026.** El piloto de `main` `05b02f31563d88285d22b5085d69d3ba757e6675`, publicado mediante el [PR #10](https://github.com/LynxPardelle/abonos-por-evento/pull/10), está disponible en https://saldoevento.lynxpardelle.com y fue validado con una cuenta real de producción. Stripe y Checkout permanecen desactivados.

El incremento de catálogo, derechos de uso, cierre, plantillas y Equipo está **desplegado en testing y validado con la cuenta del propietario** en el commit `d752d26c23b8afcc60ef13c64b5f2c4166162e48`, con CI aprobada de 171 pruebas Node y 34 Angular. El propietario aprobó su promoción a main y producción en **https://saldoevento.zooberiahsystems.com**, manteniendo el dominio anterior compatible. **El despliegue y la verificación de producción de este incremento siguen pendientes de su comprobante en el PR correspondiente.** Por Evento, Organizador y Equipo se asignan para evaluación manual mediante IAM, sin compra, cargos o suscripción. No tienen precio aprobado. [Aceptación de testing](verificacion/testing-tiers-owner-2026-11-19.json).

Las tablas siguientes describen las capacidades verificadas en testing y sus diferencias por tier. Esa validación no activa una suscripción ni acredita todavía la publicación del incremento en producción.

## Qué se está vendiendo

SaldoEvento ayuda a un organizador a asignar pagos externos a participantes, revisar coincidencias y cerrar con saldos trazables. La unidad de valor es el evento conciliado y la continuidad de trabajo de su organizador. El monto del dinero registrado no determina la cuota propuesta.

El modelo conserva dos caminos: una contratación por evento para quien organiza ocasionalmente y una suscripción mensual o anual para quien trabaja de forma recurrente. Una suscripción paga el uso del producto; no convierte los movimientos de los participantes en cobros procesados por SaldoEvento.

## Disponible en el piloto

La versión publicada del piloto incluye:

- Eventos y participantes con un importe acordado y una moneda por evento: MXN, USD o EUR.
- Importación CSV, sugerencias de coincidencia y filas ambiguas o rechazadas visibles.
- Confirmación explícita, abonos parciales y registro manual con referencia única.
- Saldo por participante, movimientos inmutables y reversos enlazados al original.
- Protección contra operaciones repetidas y escrituras concurrentes.
- Aislamiento por organización y autorización del backend por roles.

El registro verificado crea una organización propia desde el servidor. Una cuenta nueva de producción es independiente de las cuentas y organizaciones de testing. El piloto publicado no incluye invitaciones, cambio autónomo de plan, cobro, factura comercial ni conexión bancaria automática.

**Límites técnicos del piloto:** cada CSV admite hasta 1 MiB y 500 filas; el detalle serializado de un batch se limita a 300000 bytes. El catálogo de evaluación verificado en testing conserva el piloto sin cuota comercial de eventos. Esto no equivale a ofrecer recursos ilimitados, importaciones sin límites técnicos o retención perpetua.

## Oferta para la landing

| Opción      | Para quién                                                               | Mensaje público                                                     | Estado y acción                                                                                    |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Piloto      | Quien quiere comprobar el flujo con un evento propio                     | Prueba importación, revisión, abonos y saldos. Sin tarjeta.         | Disponible sólo donde el registro esté habilitado. CTA: **Crear cuenta de piloto**.                |
| Por Evento  | Un taller, encuentro, curso o evento ocasional                           | Un espacio de trabajo enfocado en preparar y cerrar un evento.      | Evaluación manual verificada en testing. Precio y compra pendientes.                              |
| Organizador | Quien prepara eventos de manera recurrente                               | Varios eventos, plantillas de participantes y una vista por moneda. | Evaluación manual verificada en testing. Suscripción pendiente.                                   |
| Equipo      | Quien reparte importación, confirmación y revisión entre varias personas | Un mismo espacio con responsabilidades y acceso por rol.            | Equipo administrado mediante IAM verificado en testing. Invitaciones pendientes.                  |

Texto breve para la sección: **«Empieza con el piloto. Los planes de pago están en diseño y aún no se pueden contratar.»** No usar un plazo de prueba ficticio, una fecha de cobro, un descuento anual, un precio tachado ni una promesa de gratuidad permanente.

## Catálogo de evaluación verificado en testing

El catálogo versionado `2026-11-19.v1` aplica estas reglas en el backend desplegado en testing `d752d26`. **Son capacidades de evaluación; no son prestaciones contratables ni describen todavía la configuración del piloto de producción.** La asignación de plan se realiza exclusivamente por un operador IAM autorizado; ninguna tarjeta de la landing o solicitud del cliente concede un tier.

| Dimensión             | Piloto `pilot`      | Por Evento `event` | Organizador `organizer` | Equipo `team`                      |
| --------------------- | ------------------- | ------------------ | ----------------------- | ---------------------------------- |
| Eventos no archivados | Sin cuota comercial | 1                  | 5                       | 20                                 |
| Personas activas      | 1                   | 1                  | 1                       | 5                                  |
| Organización          | Propia              | Propia             | Propia                  | Propia y colaboradores autorizados |
| Activación            | Registro del piloto | Asignación IAM     | Asignación IAM          | Asignación IAM                     |
| Cobros                | Ninguno             | Ninguno            | Ninguno                 | Ninguno                            |
| CSV                   | 1 MiB y 500 filas   | Mismo límite       | Mismo límite            | Mismo límite                       |

Las personas incluyen al propietario y a todos los colaboradores activos, también auditores. Las organizaciones administrativas antiguas conservan sus membresías y acceso básico, pero su base de plazas no se supone igual a uno: Equipo permanece bloqueado hasta una migración IAM explícita de esa base.

Un evento cerrado financieramente sigue consumiendo cuota mientras no se archive. Archivar conserva datos y libera una plaza de evento; reabrir un evento archivado vuelve a reservar capacidad. El contador y las versiones de plan se verifican en transacciones para impedir exceder el límite con solicitudes concurrentes. Un downgrade por debajo del uso de eventos o personas se rechaza; no borra movimientos ni revoca silenciosamente la organización personal.

## Funciones que justifican cada tier

| Función                                          | Piloto                                                             | Por Evento en evaluación (testing)                         | Organizador en evaluación (testing)             | Equipo en evaluación (testing)                                   |
| ------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| Importar, revisar, confirmar, saldo y reverso    | Sí                                                                 | Incluido                                                   | Incluido                                        | Incluido                                                         |
| Organización propia por cuenta nueva             | Publicado y validado                                               | Conservada                                                 | Conservada                                      | Conservada al participar en otro equipo                          |
| Cierre financiero y exportación CSV              | No concede cierres nuevos o reporte actual                         | Verificado en testing                                     | Verificado en testing                          | Verificado en testing                                            |
| Consulta de un cierre histórico autorizado       | Disponible en testing, incluso después de un downgrade             | Sí                                                         | Sí                                              | Sí                                                               |
| Plantilla de participantes y montos              | No crea o aplica plantillas                                        | No crea o aplica plantillas                                | Verificado en testing, hasta 90 participantes   | Mismo límite                                                     |
| Vista entre eventos por moneda                   | No                                                                 | No                                                         | Verificado en testing                          | Verificado en testing                                            |
| Alta de colaboradores                            | No                                                                 | No                                                         | No                                              | IAM a sujetos ya registrados                                     |
| Roles y baja de colaboradores                    | No administra colaboradores                                        | Propietario                                                | Propietario                                     | Propietario administra roles y revocación; verificado en testing |
| Invitaciones por enlace o correo                 | Pendiente                                                          | No                                                         | No                                              | Diferidas explícitamente                                         |
| Permisos por persona y evento                    | Roles básicos                                                      | Propietario                                                | Propietario                                     | Roles operator/importer/confirmer/auditor y scope de eventos     |
| Registro de acciones con actor y fecha           | No ofrecer como auditoría completa                                 | Nuevos movimientos y cierres conservan actor/fecha          | Igual                                           | Además, bitácora de permisos y asignaciones del incremento      |
| Integración bancaria o conciliación sin revisión | No                                                                 | No comprometida                                            | No comprometida                                 | No comprometida                                                  |
| SLA o soporte con tiempo garantizado             | No                                                                 | Por definir, sin promesa pública                           | Por definir                                     | Por definir                                                      |

El cierre guarda un snapshot inmutable de saldos, movimientos y revisión del padrón; es un cierre financiero y no un cierre general de inscripciones. Su tamaño máximo es 300000 bytes. El CSV exportado admite hasta 1 MiB, protege celdas de texto frente a fórmulas y no convierte importes a números de punto flotante. Un reporte histórico autorizado sigue disponible después de un downgrade. Las plantillas no copian abonos o saldos y la vista global agrupa por moneda sin sumar MXN, USD y EUR en un total único.

La bitácora disponible no constituye una promesa de auditoría completa, exportación de toda actividad, SLA o retención perpetua. Los movimientos antiguos pueden carecer de actor o fecha añadidos en el nuevo incremento.

## Criterios para habilitar la venta

| Etapa                   | Trabajo concreto                                                                                                                                                                      | Criterio de salida                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| P0 — Piloto registrable | Publicado mediante PR #10 y validado con una cuenta real en producción.                                                                                                               | Mantener la aceptación y las verificaciones por ambiente.                                                                             |
| P1 — Derecho de uso     | Catálogo por organización, resolver actual y cuotas transaccionales verificados en AWS/testing.                                                                                      | Acreditar la publicación autorizada en producción con su comprobante; conservar permisos, reintentos y cuotas.                         |
| P2 — Por Evento         | Cierre, snapshot, archivo, reapertura recuperable y CSV verificados en testing; aceptación humana aprobada.                                                                            | Acreditar producción; la compra y duración comercial del derecho siguen pendientes.                                                    |
| P3 — Organizador        | Plantillas y vista por moneda verificadas en testing; conservación histórica aceptada con la cuenta del propietario.                                                                 | Acreditar producción; periodos y renovación siguen diferidos.                                                                         |
| P4 — Equipo             | Alta IAM, roles, scopes, baja y bitácora verificados en testing; revocación con el mismo JWT aceptada.                                                                                | Acreditar producción. Invitaciones con enlaces expirables y aceptación autenticada permanecen pendientes.                              |
| P5 — Facturación        | Diseñar por separado el cobro del SaaS, estados de suscripción, webhooks idempotentes, reintentos y atención de cobros fallidos. Stripe se integra sólo cuando se autorice esa etapa. | La facturación modifica derechos de uso y no crea abonos de participantes. No hay Checkout activo mientras esta etapa esté pendiente. |

Antes de cobrar, definir retención, recuperación, exportación y tratamiento de una suscripción vencida. No borrar el historial financiero ni impedir correcciones de integridad mediante una regla de cobro improvisada. Los archivos CSV originales actualmente caducan a los siete días; esto es distinto de la conservación del ledger y debe comunicarse sin prometer retención perpetua.

## Precio y validación

No se publica un importe hasta contar con un escenario autorizado de un organizador y una estimación de costo por evento/organización. Las decisiones pendientes son precio por evento, precio mensual, alternativa anual, capacidad comercial definitiva y política de soporte. Los límites del catálogo verificado son reglas de evaluación, no una oferta de venta. El interés en una landing no demuestra voluntad de pago.

Validar con entrevistas y pilotos: frecuencia de eventos, participantes por evento, número de operadores, dificultad del cierre, volumen de filas rechazadas, correcciones y necesidad de exportar. Medir tiempo desde importación hasta cierre revisado, sin prometer un ahorro porcentual antes de contar con una comparación real. La métrica comercial principal será la repetición de uso por organizador junto con un cierre correcto, no el volumen monetario de los pagos externos.

## Contexto de mercado consultado

Consulta histórica de páginas oficiales realizada el 19 de noviembre de 2026; las cifras siguientes no se han vuelto a verificar en este incremento. Sirven para comparar modelos y segmentación, no para demostrar demanda de SaldoEvento ni trasladar tarifas entre países.

- **Cheddar Up:** combina una entrada gratuita con Pro y Team; diferencia funciones de venta/registro, colaboración y reportes. Su oferta recibe pagos y aplica tarifas de procesamiento. La lección para SaldoEvento es separar el piloto de capacidades avanzadas y de equipo, sin presentar el procesamiento de pagos como una función propia. [Precios oficiales de Cheddar Up](https://www.cheddarup.com/pricing/).
- **Ticket Tailor:** ofrece pago por ticket o créditos anticipados. La página consultada muestra £0.60 por ticket en pago por uso y créditos desde £0.22, más IVA, con costos del procesador separados. Está centrado en venta de entradas mediante procesadores conectados. SaldoEvento puede conservar una opción por evento, pero su unidad de valor propuesta es el cierre y no el ticket vendido. [Precios oficiales de Ticket Tailor](https://www.tickettailor.com/pricing).

## Reglas de comunicación

1. Un único plan registrable ahora: el piloto, según el ambiente y su verificación.
2. Indicar el ambiente verificado: los tiers de evaluación están probados en testing; su publicación de producción sigue pendiente del comprobante autorizado. La oferta comercial permanece «En diseño», sin precio aprobado.
3. Las funciones pendientes se describen como propuestas, no como una lista de funciones disponibles.
4. No ofrecer conectar un banco, cobrar a asistentes, emitir comprobantes fiscales, enviar invitaciones o garantizar un SLA. Cierre, exportación, plantillas y Equipo requieren la promoción y verificación del incremento antes de anunciarse como disponibles en producción.
5. No declarar datos ilimitados, importaciones sin límite o conservación para siempre; los límites técnicos y los comerciales son conceptos distintos.
6. El registro no activa Stripe, una suscripción de pago ni un cargo futuro automático.

Referencias internas: [Producto](PRODUCTO.md), [Contrato actual](CONTRATO.md), [Arquitectura](architecture/ARCHITECTURE.md) y [Plan de la primera versión](../plan/feature-primera-version-1.md).
