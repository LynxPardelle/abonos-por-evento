# Interfaz Angular de SaldoEvento

Angular 22.2.6, CLI/SSR 22.2.7 y NgRx Signals22.0.1. Componentes standalone, rutas lazy, Signal Forms y estado por ruta.

Desde la raíz del repositorio instala `npm --prefix web ci`. Ejecuta `npm run dev:api` en una terminal y `npm --prefix web start` en otra; abre http://localhost:4310. La API sintética de loopback 4311 entrega configuración local sin credenciales ni datos reales.

`npm --prefix web test -- --watch=false` verifica la interfaz. `npm --prefix web run build` genera `dist/saldoevento-web/browser` y `server`. Desde la raíz, `npm run package:frontend` prepara el Lambda SSR y `npm run smoke:frontend` invoca el paquete real.

En nube, el acceso es OAuth Code con PKCE; la configuración pública llega de `/runtime-config.json`. Los tokens permanecen en sesión del navegador y las operaciones de dinero se validan en el backend. El frontend SSR no recibe ni incorpora datos privados al HTML inicial.

Consulta [Arquitectura](../docs/architecture/ARCHITECTURE.md), [Contrato](../docs/CONTRATO.md) y [Operación](../docs/OPERACION.md).
