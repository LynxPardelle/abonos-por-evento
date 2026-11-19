# Planes de SaldoEvento

**Estado: diseño comercial del 19 de noviembre de 2026.** El piloto puede usarse sin tarjeta cuando el registro esté habilitado en el ambiente. Por Evento, Organizador y Equipo son propuestas para validar; no están a la venta, no activan suscripciones y no tienen un precio aprobado.

## Qué se está vendiendo

SaldoEvento ayuda a un organizador a asignar pagos externos a participantes, revisar coincidencias y cerrar con saldos trazables. La unidad de valor es el evento conciliado y la continuidad de trabajo de su organizador. El monto del dinero registrado no determina la cuota propuesta.

El modelo conserva dos caminos: una contratación por evento para quien organiza ocasionalmente y una suscripción mensual o anual para quien trabaja de forma recurrente. Una suscripción paga el uso del producto; no convierte los movimientos de los participantes en cobros procesados por SaldoEvento.

## Disponible en el piloto

Estas capacidades están implementadas en el núcleo y la interfaz. Su publicación y el registro se verifican por ambiente antes de anunciarlos como disponibles:

- Eventos y participantes con un importe acordado y una moneda por evento: MXN, USD o EUR.
- Importación CSV, sugerencias de coincidencia y filas ambiguas o rechazadas visibles.
- Confirmación explícita, abonos parciales y registro manual con referencia única.
- Saldo por participante, movimientos inmutables y reversos enlazados al original.
- Protección contra operaciones repetidas y escrituras concurrentes.
- Aislamiento por organización y autorización del backend por roles.

El registro nuevo debe crear una organización propia desde el servidor. El piloto no incluye una interfaz de invitaciones, cambio de plan, cobro, factura comercial ni conexión bancaria automática. Los roles existentes en la API no equivalen a una función comercial de invitar un equipo.

**Límites técnicos actuales:** cada CSV admite hasta 1 MiB y 500 filas. El detalle serializado de un batch se limita a 300000 bytes. Esto no limita por sí mismo el número de eventos, participantes totales o importaciones de una organización. No hay cuotas comerciales ni un servicio de entitlements implementados; tampoco debe describirse el piloto como ilimitado.

## Oferta para la landing

| Opción | Para quién | Mensaje público | Estado y acción |
| --- | --- | --- | --- |
| Piloto | Quien quiere comprobar el flujo con un evento propio | Prueba importación, revisión, abonos y saldos. Sin tarjeta. | Disponible sólo donde el registro esté habilitado. CTA: **Crear cuenta de piloto**. |
| Por Evento | Un taller, encuentro, curso o evento ocasional | Un espacio de trabajo enfocado en preparar y cerrar un evento. | **En diseño.** Precio por validar. CTA al piloto, sin compra. |
| Organizador | Quien prepara eventos de manera recurrente | Continúa trabajando con varios eventos y reutiliza la preparación de tus próximos cierres. | **En diseño.** Suscripción mensual/anual por validar. CTA al piloto. |
| Equipo | Quien reparte importación, confirmación y revisión entre varias personas | Un mismo espacio con responsabilidades y acceso por rol. | **En diseño.** Suscripción mensual/anual por validar. Invitaciones aún pendientes. |

Texto breve para la sección: **«Empieza con el piloto. Los planes de pago están en diseño y aún no se pueden contratar.»** No usar un plazo de prueba ficticio, una fecha de cobro, un descuento anual, un precio tachado ni una promesa de gratuidad permanente.

## Hipótesis internas de capacidad

Las siguientes cifras son bandas de trabajo para entrevistas, pruebas de carga y costos. **No son límites operativos actuales ni deben publicarse como prestaciones contratables.** El piloto no aplica automáticamente ninguna de estas cuotas.

| Dimensión propuesta | Por Evento | Organizador | Equipo |
| --- | --- | --- | --- |
| Eventos abiertos simultáneos | 1 | 5 | 20 |
| Personas con capacidad de operar | 1 | 1 | 5 |
| Organización | 1 | 1 | 1 compartida |
| Modalidad comercial | Pago por evento | Mensual o anual | Mensual o anual |
| Participantes por evento | Por definir tras pruebas de carga y demanda | Por definir | Por definir |
| Archivo CSV | Mantener el límite seguro por archivo y permitir dividir lotes | Mismo límite técnico por archivo | Mismo límite técnico hasta rediseñar el importador |

Un evento abierto requiere un ciclo de vida explícito que hoy no existe como regla comercial: borrador, abierto, cerrado y archivado. El evento cerrado debe conservarse consultable; el cierre no debe borrar el ledger. Definir cómo se autorizan correcciones posteriores antes de convertir «evento abierto» en una cuota facturable.

## Funciones que justifican cada tier

| Función | Piloto actual | Por Evento propuesto | Organizador propuesto | Equipo propuesto |
| --- | --- | --- | --- | --- |
| Importar, revisar, confirmar, saldo y reverso | Sí | Incluido | Incluido | Incluido |
| Organización propia por cuenta nueva | Registro en implementación/verificación | Incluido | Incluido | Invitaciones a una organización compartida |
| Resumen exportable del cierre | Pendiente | Sí | Sí | Sí |
| Cierre y archivo explícitos | Pendiente | Sí | Sí | Sí |
| Plantilla reutilizable de participantes y montos | Pendiente | Sin compromiso inicial | Sí | Sí |
| Vista entre varios eventos | Pendiente | No prevista | Sí | Sí |
| Invitaciones y baja de colaboradores | Pendiente | No prevista | No prevista en la hipótesis inicial | Sí |
| Permisos por persona y evento | Roles API disponibles; administración manual | Propietario | Propietario | Importar, confirmar y auditar separados |
| Registro de acciones con actor y fecha para exportación | No ofrecer como auditoría completa | Básico, por implementar | Básico, por implementar | Ampliado, por implementar |
| Integración bancaria o conciliación sin revisión | No | No comprometida | No comprometida | No comprometida |
| SLA o soporte con tiempo garantizado | No | Por definir, sin promesa pública | Por definir | Por definir |

La separación por roles es un control de acceso técnico ya existente. La bitácora de auditoría comercial necesita más evidencia que un movimiento inmutable: actor, fecha, correlación, origen, cambios de permisos, exportación y cobertura de errores. No vender «auditoría completa» antes de implementarla y validarla.

## Criterios para habilitar la venta

| Etapa | Trabajo concreto | Criterio de salida |
| --- | --- | --- |
| P0 — Piloto registrable | Confirmación de correo, organización asignada por servidor, roles no editables por cliente, acceso a `/app`, aislamiento y recuperación de intentos repetidos. | Una cuenta nueva puede completar el flujo sin aprovisionamiento manual; los ambientes development y testing tienen evidencia. |
| P1 — Derecho de uso | Modelo de plan por organización, versión de catálogo y servicio de entitlements; cuotas de eventos/operadores comprobadas en backend con condiciones de concurrencia. | Dos solicitudes simultáneas no exceden una cuota; una solicitud idempotente no la consume dos veces. |
| P2 — Por Evento | Ciclo de vida, cierre, consulta histórica y exportación del resumen; definición de qué activa y termina el derecho sobre un evento. | Se puede explicar la compra y reconstruir el cierre sin depender de un estado de pantalla. |
| P3 — Organizador | Plantillas reutilizables, listado entre eventos y reglas de renovación, cambio de plan y acceso al histórico. | Los cambios de periodo o plan no borran movimientos ni producen pérdida silenciosa de acceso a registros. |
| P4 — Equipo | Invitación de un solo uso con caducidad, aceptación autenticada, membresías gestionadas por servidor, permisos por evento, revocación y bitácora. | Una persona invitada no puede elegir otra organización ni ampliar su rol; la revocación se verifica. |
| P5 — Facturación | Diseñar por separado el cobro del SaaS, estados de suscripción, webhooks idempotentes, reintentos y atención de cobros fallidos. Stripe se integra sólo cuando se autorice esa etapa. | La facturación modifica derechos de uso y no crea abonos de participantes. No hay Checkout activo mientras esta etapa esté pendiente. |

Antes de cobrar, definir retención, recuperación, exportación y tratamiento de una suscripción vencida. No borrar el historial financiero ni impedir correcciones de integridad mediante una regla de cobro improvisada. Los archivos CSV originales actualmente caducan a los siete días; esto es distinto de la conservación del ledger y debe comunicarse sin prometer retención perpetua.

## Precio y validación

No se publica un importe hasta contar con un escenario autorizado de un organizador y una estimación de costo por evento/organización. Las decisiones pendientes son: precio por evento, precio mensual, alternativa anual, bandas de capacidad y política de soporte. El interés en una landing no demuestra voluntad de pago.

Validar con entrevistas y pilotos: frecuencia de eventos, participantes por evento, número de operadores, dificultad del cierre, volumen de filas rechazadas, correcciones y necesidad de exportar. Medir tiempo desde importación hasta cierre revisado, sin prometer un ahorro porcentual antes de contar con una comparación real. La métrica comercial principal será la repetición de uso por organizador junto con un cierre correcto, no el volumen monetario de los pagos externos.

## Contexto de mercado consultado

Consulta de páginas oficiales realizada el 19 de noviembre de 2026. Sirve para comparar modelos y segmentación, no para demostrar demanda de SaldoEvento ni trasladar tarifas entre países.

- **Cheddar Up:** combina una entrada gratuita con Pro y Team; diferencia funciones de venta/registro, colaboración y reportes. Su oferta recibe pagos y aplica tarifas de procesamiento. La lección para SaldoEvento es separar el piloto de capacidades avanzadas y de equipo, sin presentar el procesamiento de pagos como una función propia. [Precios oficiales de Cheddar Up](https://www.cheddarup.com/pricing/).
- **Ticket Tailor:** ofrece pago por ticket o créditos anticipados. La página consultada muestra £0.60 por ticket en pago por uso y créditos desde £0.22, más IVA, con costos del procesador separados. Está centrado en venta de entradas mediante procesadores conectados. SaldoEvento puede conservar una opción por evento, pero su unidad de valor propuesta es el cierre y no el ticket vendido. [Precios oficiales de Ticket Tailor](https://www.tickettailor.com/pricing).

## Reglas de comunicación

1. Un único plan registrable ahora: el piloto, según el ambiente y su verificación.
2. Cada tier futuro lleva la etiqueta «En diseño» y precio «Por definir» si aparece un campo de precio.
3. Las funciones pendientes se describen como propuestas, no como una lista de funciones disponibles.
4. No ofrecer conectar un banco, cobrar a asistentes, emitir comprobantes fiscales, enviar invitaciones, exportar reportes o garantizar un SLA mientras no estén implementados y verificados.
5. No declarar datos ilimitados, importaciones sin límite o conservación para siempre; los límites técnicos y los comerciales son conceptos distintos.
6. El registro no activa Stripe, una suscripción de pago ni un cargo futuro automático.

Referencias internas: [Producto](PRODUCTO.md), [Contrato actual](CONTRATO.md), [Arquitectura](architecture/ARCHITECTURE.md) y [Plan de la primera versión](../plan/feature-primera-version-1.md).
