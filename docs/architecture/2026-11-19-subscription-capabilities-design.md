# Capacidades por plan, sin facturación

Fecha: 19 de noviembre de 2026. Implementación posterior al piloto publicado en main 05b02f31563d88285d22b5085d69d3ba757e6675.

## Decisión

Se implementan derechos de uso por organización, asignados administrativamente para evaluación. Un cambio de plan no crea una compra, suscripción de pago, cargo futuro ni movimiento de un participante. Stripe y Checkout permanecen ausentes. Se mantienen Piloto, Por Evento, Organizador y Equipo; no se publican precios.

Se compararon catálogo informativo, capacidades reales por módulos y reconstrucción general del producto. Se elige el segundo: extiende los servicios y Angular actuales, preserva los movimientos existentes y produce recorridos verificables sin introducir facturación.

| Plan | Capacidades de este incremento | Capacidad de evaluación |
| --- | --- | --- |
| Piloto | Flujo operativo actual, organización propia e historial | Sin cuota comercial de eventos; conserva los límites técnicos existentes. No anunciarlo como ilimitado. |
| Por Evento | Núcleo, cierre financiero, reportes CSV y archivo | 1 evento en trabajo y 1 persona |
| Organizador | Por Evento, plantillas de participantes y vista entre eventos | 5 eventos en trabajo y 1 persona |
| Equipo | Organizador, colaboradores con roles, alcance y revocación | 20 eventos en trabajo y 5 personas, incluido propietario y lectores |

Las cifras son derechos de evaluación administrados, no una oferta pagada aprobada. Evento en trabajo significa **no archivado**, aunque su conciliación esté cerrada. Un downgrade no borra datos ni historial. Un sobrecupo impide nuevas altas o desarchivo; no impide leer, corregir operaciones autorizadas o archivar.

## Identidad y derechos

Se conserva la membresía personal y los claims existentes. El plan mutable vive en registros de organización versionados, no en el claim informativo custom:tier. Un resolver Lambda exclusivamente de lectura consulta membresía, roles, alcance y plan actuales, sin caché positiva de permisos. Una Lambda IAM separada administra planes y altas de colaboradores; los servicios no reciben permiso de invocar ese escritor.

GET /api/v1/me devuelve organización personal, espacios permitidos, organización activa, capacidades efectivas y límites. X-SaldoEvento-Organization es un candidato que el servidor valida, nunca una concesión de acceso. La UI invalida su estado al cambiar de espacio. Los roles de colaboradores son operator, importer, confirmer y auditor; no se concede propiedad ni admin mediante una acción de colaboración.

Equipo comienza con **alta asistida por administración IAM**, consulta de miembros y cambios/revocaciones autorizados por propietario. Las invitaciones mediante enlaces y su entrega quedan para una fase posterior; no se presentan como disponibles. Una cuenta conserva su organización personal al colaborar en otra.

El propietario de una organización personal se reconoce a partir de su alta verificada y la derivación existente pool+sujeto. Un admin administrativo legacy no se convierte automáticamente en propietario. Las organizaciones administrativas con base de plazas desconocida no reciben una cuota estricta de equipo sin una migración explícita y verificada.

Los dominios escriben sus propias tablas. Se permiten comprobaciones condicionales de metadata de plan/membresía dentro de transacciones de negocio para impedir exceder cupos o confirmar una escritura con permisos revocados durante la petición. La administración del plan condiciona el contador de uso de Eventos al reducir capacidad. Esta dependencia de lectura es explícita y acotada; no habilita escrituras generales en la tabla de otro dominio. DynamoDB admite estas comprobaciones entre tablas de la misma cuenta y región: [contrato TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).

## Cierre, reapertura y archivo

Conciliación conserva financialStatus y lifecycleVersion en el mismo LEDGER que controla la versión de movimientos. Cada nuevo abono/reverso condiciona que el libro permanezca abierto; cerrar o reabrir no inventa movimientos financieros. El cierre guarda una fotografía inmutable con versión del ledger, revisión del roster, importes exactos, actor y fecha. No se anuncia como una congelación global de todos los metadatos del evento.

Eventos conserva revisión, archivo y contador de eventos en trabajo. Conciliación coordina archivo y reapertura mediante la dirección IAM existente hacia Eventos. Antes de reabrir, Eventos reserva el cupo y marca una transición con OCC; sólo entonces se abre el ledger y se finaliza la transición. Un fallo conserva la reserva y permite reintentar la misma operación. Un archivo concurrente requiere la revisión anterior y ausencia de transición. Así se evita abrir primero y descubrir después que no hay capacidad.

Las altas nuevas de participantes incrementan la revisión del evento en una transacción. El contexto interno lee revisión, participantes y revisión otra vez para detectar cambios. El reporte declara las versiones capturadas; no incorpora cambios posteriores. Las exportaciones de cierres existentes y el acceso al historial se conservan después de un downgrade. Las correcciones posteriores exigen reapertura autorizada y quedan en el historial.

Los CSV se generan en backend, con dinero entero convertido sin float y protección de celdas de texto contra fórmulas. Se conservan las cifras negativas legítimas en columnas monetarias. El tamaño de un snapshot se limita explícitamente para caber en DynamoDB; un exceso falla sin cierre parcial.

## Plantillas y vista entre eventos

Una plantilla contiene exclusivamente nombre, moneda y participantes con nombre, referencia e importe acordado. No copia IDs del evento original, saldos, pagos, archivos ni membresías. El límite técnico inicial es 90 participantes por plantilla: permite crear el nuevo evento, sus participantes, el uso y las condiciones de acceso en una única transacción inferior al límite de 100 acciones. Los reintentos devuelven el resultado original y no consumen otro cupo.

La vista de varios eventos se calcula en backend y agrupa importes por moneda. El navegador no agrega ledgers mediante una cascada de solicitudes. Las personas con alcance a eventos concretos no obtienen una vista general del resto de la organización.

## Entrega y verificación

Se trabaja en codex/subscription-tiers, basada en development con el mismo contenido del piloto publicado. Se conservan main, la cuenta y los registros de producción. La publicación de capacidades nuevas sigue development → testing → main; la aceptación anterior acredita el piloto, no las funciones que aún se están implementando.

Pruebas prioritarias: acceso entre organizaciones, privilegios de propietario, cambio de rol/revocación, último cupo concurrente, replay sin doble consumo, downgrade frente a creación, cierre frente a pago, cierre/reapertura vacíos, archivo frente a reapertura, snapshot estable, CSV seguro y plantilla sin movimientos heredados. Angular verifica permisos, cambio de contexto sin respuestas antiguas, errores de versión/capacidad y ausencia de compra.

Permanecen fuera: Stripe, Checkout, precios, periodos de cobro, facturas, integración bancaria, SLA comercial, auditoría universal e invitaciones autoservicio. Se registran en el plan como etapas posteriores, no como capacidades entregadas.
