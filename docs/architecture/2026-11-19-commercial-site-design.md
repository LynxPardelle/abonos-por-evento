# Sitio comercial y registro de SaldoEvento

**Fecha:** 19 de noviembre de 2026. **Estado:** diseño para la implementación solicitada. La disponibilidad de registro y las promociones se acreditan con sus verificaciones; este documento no activa cobros ni autoriza producción.

**Actualización posterior:** el piloto de este diseño ya se publicó con aprobación del propietario mediante PR #10 y fue validado con su cuenta en producción. Las menciones a main pendiente que siguen describen el punto de decisión original. El nuevo incremento de capacidades por tier conserva su [plan separado](../../plan/feature-subscription-tiers-1.md) y permanece local.

## Objetivo

La primera visita debe explicar qué consigue el producto y conducir a una cuenta de piloto. El recorrido de trabajo se mantiene separado de la explicación comercial: `/` presenta SaldoEvento y `/app` abre el espacio operativo. El registro crea una organización aislada desde el servidor. La rama `main` queda pendiente hasta que el propietario pueda probarlo con su cuenta.

## Decisión visual

La propuesta usa un hero a todo lo ancho en verde profundo, superficies crema, tipografía Manrope/DM Sans ya entregada por el propio sitio y una composición centrada en SaldoEvento y el resultado de un cierre. La pantalla debe reconocerse como un producto para organizadores y no como un panel administrativo antes de registrarse.

El recurso visual principal es un ejemplo ilustrativo del flujo del producto y su ledger, con datos identificados como ficticios. Puede mostrar dos abonos de 500.00 y 750.00 MXN y un reverso de 500.00 MXN que dejan 750.00 MXN. No se presenta como el saldo de un cliente, una métrica de rendimiento ni una demostración de que un pago haya sido procesado por SaldoEvento.

La composición tiene un CTA dominante, «Crear cuenta de piloto», y una alternativa «Ver cómo funciona». El acceso de cuentas existentes aparece en navegación. Los estados y los números ayudan a entender el producto; no se agregan mosaicos de indicadores, logotipos de clientes, testimonios o resultados sin evidencia.

Las transiciones deben ser breves y funcionales: entrada de marca/contenido, cambio de estado en el ejemplo y foco/hover de acciones. Respetar `prefers-reduced-motion`. El diseño debe seguir siendo comprensible sin animación.

## Contenido y orden

| Sección | Trabajo de la sección | Acción o evidencia |
| --- | --- | --- |
| Navegación | Identificar marca y acceso | Cómo funciona, planes, preguntas, entrar y crear cuenta. |
| Hero | Comunicar el resultado | «Cada abono en su lugar» y explicación breve de pagos externos/saldos por participante. |
| Recorrido | Explicar tres decisiones | Importar un CSV, revisar la referencia y confirmar el abono. |
| Ejemplo operativo | Probar comprensión del saldo | Abonos, pendiente y reverso con números ficticios y estado explícito. |
| Funciones actuales | Describir lo que ya puede usar el piloto | Importación, revisión humana, abonos manuales, idempotencia, saldo y reversos. |
| Planes | Orientar por frecuencia y tamaño de equipo | Piloto disponible; Por Evento, Organizador y Equipo «En diseño». |
| Preguntas | Resolver objeciones concretas | No necesita tarjeta; no procesa pagos; CSV documentado; una moneda por evento; planes de pago aún sin venta. |
| CTA final | Permitir empezar | Crear cuenta de piloto o entrar a cuenta existente. |

Evitar frases de superioridad no medidas, tiempos garantizados, reducción porcentual de errores y promesas de conciliación bancaria automática. El texto explica el control de pagos externos y la decisión humana que aplica un movimiento.

## Registro y acceso

1. «Crear cuenta de piloto» abre el registro Cognito con el flujo de autorización y PKCE configurado.
2. La persona verifica su correo según el flujo de identidad; no elige una organización o un rol mediante el cliente.
3. El servidor deriva la organización del sujeto confirmado y crea una membresía de propietario idempotente.
4. Los claims de organización/rol emitidos se basan en una membresía administrada por el servidor. Un atributo enviado por un usuario no concede acceso a otro tenant.
5. El callback vuelve a `/app`; la persona crea el evento y participantes, importa el CSV, revisa, confirma y comprueba el saldo.
6. Un intento repetido de registro, confirmación o provisión no debe crear organizaciones duplicadas ni ampliar permisos.

El CTA de alta respeta la habilitación del ambiente. Un registro bloqueado, error de configuración o fallo de verificación tiene un mensaje útil y una ruta de acceso/reintento. No mostrar una compra, un cargo programado ni una suscripción de pago como consecuencia del registro.

La prueba automática con identidades sintéticas no acredita por sí sola la recepción de un correo ni la experiencia completa de una persona. La aceptación final con la cuenta del propietario permanece como condición previa a `main`.

## Planes en la página

La landing presenta cuatro opciones según [PLANES.md](../PLANES.md):

- **Piloto:** funciones actuales y registro sin tarjeta cuando esté habilitado.
- **Por Evento:** propuesta para una ocasión, con contratación por evento futura.
- **Organizador:** propuesta para uso recurrente, con alternativa mensual/anual futura.
- **Equipo:** propuesta de trabajo compartido con invitaciones y controles por persona aún pendientes.

Las tres opciones de pago tienen etiqueta «En diseño». Las cuotas internas de 1/5/20 eventos y 1/1/5 operadores son hipótesis de validación y no deben anunciarse como derechos disponibles. No hay precio aprobado, Checkout, tarjeta ni elección pagada de plan. Todos los caminos públicos de inicio llevan al mismo piloto; no se inscribe a alguien en un tier futuro por pulsar una tarjeta informativa.

## Verificación de aceptación

| Área | Resultado exigido |
| --- | --- |
| SSR y rutas | `/` devuelve contenido comercial reconocible en HTML inicial; `/app` mantiene el flujo operativo y los enlaces profundos existentes. |
| Acceso | CTA de registro y de entrada tienen destinos correctos, PKCE y callback a `/app`. |
| Tenant | Dos cuentas nuevas tienen organizaciones distintas; repetición de provisión conserva la organización; cliente no elige rol/tenant. |
| Honestidad comercial | Ningún tier futuro se anuncia como contratado o disponible; no aparecen precios, testimonios o estadísticas inventadas. |
| Responsividad | Navegación, CTA, ejemplo y comparación de planes se pueden usar en escritorio y móvil sin desbordamiento. |
| Accesibilidad | Orden de títulos coherente, controles con nombre, foco visible, contraste y funcionamiento sin animación. |
| Regresión operativa | Se siguen pudiendo registrar participantes, importar, revisar, confirmar, registrar abono manual y reversar. |
| Entrega | PR a development y promoción revisada a testing; main permanece pendiente. |

## Fuera de esta entrega

Stripe, Checkout, facturación fiscal, cobros a asistentes, invitaciones de equipo, integraciones bancarias, SLA comercial y entitlements de planes pagados. Se diseñan como etapas posteriores y no se presentan como capacidades entregadas. El detalle comercial y los criterios para habilitar cada tier se mantienen en [PLANES.md](../PLANES.md).
