# Abonos por Evento

Un organizador importa movimientos de sus canales de pago, revisa sugerencias de asignación y obtiene saldos por participante. El cierre deja un historial de movimientos aplicados, pendientes y reversados para el equipo operativo.

- [Producto y primera versión](docs/PRODUCTO.md)
- [Arquitectura y recursos](docs/architecture/ARCHITECTURE.md)
- [Decisión serverless](docs/architecture/adr/001-aws-serverless.md)
- [Plan de implementación](plan/feature-primera-version-1.md)

La base incluye un frontend local y una plantilla AWS SAM con `GET /health`. Esta ruta sólo verifica que responde la función. La arquitectura documenta las rutas de negocio que se incorporarán en el piloto.

## Desarrollo local

Requiere Node.js 24 a partir de 24.15 en esa línea y npm. Desde la raíz:

```powershell
npm --prefix web ci
npm --prefix web start
```

## Verificación

```powershell
node --test services/health/index.test.mjs
npm --prefix web run build
npm --prefix web test -- --watch=false
cfn-lint infra/template.yaml
```

Con AWS SAM CLI instalado, `sam build --template-file infra/template.yaml` empaqueta la función en local. El template público de salud no requiere base de datos ni recibe datos del negocio. El diseño de la primera versión usa autenticación y separación de datos por organización para sus rutas.
