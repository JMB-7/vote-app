# Desarrollo local

## Requisitos

- Node.js 22.22.3 o posterior de la rama 22 para desarrollo; Node.js 24 LTS para despliegue, npm 10 o posterior.
- Docker Engine y Docker Compose.

## Inicio

1. Copia `.env.example` a `.env` y cambia los valores locales si es necesario. `.env` está excluido de Git.
2. Inicia PostgreSQL: `docker compose up -d postgres`.
3. Instala dependencias desde la raíz: `npm install`.
4. Genera el cliente Prisma: `npm run db:generate --workspace @asdmr/api`.
5. Aplica la migración local: `npm run db:migrate --workspace @asdmr/api`.
6. En una terminal, ejecuta `npm run dev:api`.
7. En otra, ejecuta `npm run dev` y abre `http://localhost:5173`.
8. Comprueba la API en `http://localhost:3000/api/v1/health`.

## Estado de verificación

Registro reproducible más reciente: 2026-10-01. En Node.js 22.22.1/npm 11.13.0, `npm run typecheck` y `npm run build` terminaron correctamente. `npm run test:e2e` pasó 6/6 pruebas (Chromium de escritorio y móvil); Playwright intercepta la API con datos sintéticos, por lo que no valida el recorrido integrado contra API y PostgreSQL. La primera ejecución E2E dentro del sandbox no pudo abrir `127.0.0.1:5173` (`EPERM`); al autorizar el servidor local, la misma suite pasó.

La suite integrada real se ejecuta por separado con `npm run test:e2e:integration` (requiere Docker o las herramientas locales de PostgreSQL y Chromium de Playwright). Instrucciones y formato de evidencia: [docs/e2e-real-postgres.md](docs/e2e-real-postgres.md).


Docker 28.0.4 estaba instalado, pero su daemon no estaba disponible. Se usó PostgreSQL local 15.15 para crear un clúster nuevo y desechable en `/private/tmp`, escuchando solo en `127.0.0.1:55432`, con una base vacía `asdmr_integration`; no se conectó a la base local habitual ni a datos reales. `prisma migrate deploy` aplicó `20261001000000_initial`; `TEST_DATABASE_URL=... npm run test --workspace @asdmr/api` pasó 11/11, incluido el caso de concurrencia, cierre y publicación que antes se omitía. El clúster de prueba se detuvo después de la corrida. La repetición limpia requiere los comandos de abajo.

`k6` no está instalado (`k6 version`: comando no encontrado en la última verificación), por lo que no hay resultado de rendimiento. `tests/load/voting.js` ofrece tres modos (`join`, `vote-retry`, `closed-vote`) que crean Asamblea, participantes y papeleta sintéticos en un staging declarado. Requiere credencial de moderación de staging, etiqueta de corrida y umbrales P95/tasa de error acordados. No ejecutar hasta tener k6 y el staging autorizado; consultar `PHASE_05_VERIFICATION_PLAN.md` para comandos y evidencia requerida. Los ensayos presenciales siguen pendientes.

Pendiente: repetir integración de forma independiente cuando cambie la migración o la lógica de persistencia, ejecutar carga real con k6 y completar ensayos operativos. Consultar `PHASE_05_VERIFICATION_PLAN.md` para dependencias, procedimientos y matriz completa. La comprobación de sintaxis k6 no equivale a ejecutar la carga.

### Repetir integración con una base desechable (PostgreSQL local)

Si Docker no está disponible pero `initdb`, `pg_ctl` y `createdb` existen, estos pasos crean un clúster temporal aislado. Ajusta el puerto si `55432` ya está ocupado. Ejecuta desde la raíz; el usuario local de PostgreSQL debe coincidir con `id -un`.

```sh
TEST_PG_DIR="$(mktemp -d /private/tmp/asdmr-pg-test.XXXXXX)"
initdb -D "$TEST_PG_DIR/data" --auth-local=trust --auth-host=trust --no-instructions
pg_ctl -D "$TEST_PG_DIR/data" -l "$TEST_PG_DIR/postgres.log" \
  -o "-h 127.0.0.1 -p 55432" -w start
createdb -h 127.0.0.1 -p 55432 asdmr_integration
DATABASE_URL="postgresql://$(id -un)@127.0.0.1:55432/asdmr_integration?schema=public" \
  npm run db:deploy --workspace @asdmr/api
TEST_DATABASE_URL="postgresql://$(id -un)@127.0.0.1:55432/asdmr_integration?schema=public" \
  npm run test --workspace @asdmr/api
pg_ctl -D "$TEST_PG_DIR/data" -m fast -w stop
```

Si falla antes de `pg_ctl ... stop`, detén explícitamente el clúster con el mismo comando de parada y revisa su log en `$TEST_PG_DIR/postgres.log`. Este procedimiento no debe apuntar a una base que contenga datos existentes.

La API implementa el flujo esencial de Asamblea, sesiones, rondas, votos, cierre y publicación. La conexión en tiempo real es una capa separada; no usar datos personales reales en desarrollo.

Para unit tests y suite de Socket.IO: `npm run test --workspace @asdmr/api`. El test de concurrencia/voto/cierre/publicación se ejecuta cuando `TEST_DATABASE_URL` apunta a una base PostgreSQL desechable con la migración aplicada; usa esa base únicamente para pruebas.

## Variables

Consulta `.env.example`. `POSTGRES_PASSWORD`, `DATABASE_URL` y `MODERATOR_ACCESS_TOKEN` son solo para desarrollo local. Configura el token de moderación con al menos 32 caracteres aleatorios. En cada llamada `/api/v1/moderator/*`, envía `Authorization: Bearer <MODERATOR_ACCESS_TOKEN>`; el QR/código de Asamblea nunca autoriza moderación.

La credencial compartida habilita el MVP técnico, pero no identifica a cada operador individual. No desplegarla para una Asamblea oficial hasta que Secretaría/mesa valide quién modera, cómo se entrega y cómo se rota. Producción requiere secretos administrados por el entorno, HTTPS y una lista CORS específica.

Para preparar una instalación candidata reproducible con Caddy/HTTPS, servicios aislados, migraciones, healthchecks y verificación de backups, consulta [docs/candidate-environment.md](docs/candidate-environment.md). Requiere un host y DNS de prueba autorizados; no uses datos personales reales.

`WEB_ORIGIN` acepta una lista de orígenes exactos separados por comas. Para probar desde un teléfono, agrega el origen LAN del equipo que sirve Vite (por ejemplo, `http://192.168.1.20:5173`) y configura `VITE_API_URL` en `apps/web/.env.local` hacia la API en esa misma IP. Mantén solo los orígenes locales necesarios y reinicia ambos servidores después de cambiar `.env`.

## API implementada

- Delegado: `POST /api/v1/assemblies/:assemblyCode/join`, `GET /api/v1/participant/me` y `POST /api/v1/participant/rounds/:roundId/vote`.
- Proyector: `GET /api/v1/assemblies/:assemblyCode/public-state`; durante el ingreso abierto expone nombres y total de participantes. Cuando inicia una papeleta, oculta la lista y expone solo progreso agregado; los resultados por opción aparecen después de su publicación.
- Moderador: crear/consultar Asamblea, cerrar lobby, corregir/retirar participante, preparar/abrir/cerrar ronda y publicar resultados bajo `/api/v1/moderator/*`.
- La única regla de conteo implementada es `kind: count_only`: se agregan votos por opción tras publicación y no se proclama ganador. La mayoría, abstención, nulidad, empate, repetición y cancelación requieren decisión institucional.

## Documentos de fundamento

- `docs/foundation/ADR-001-architecture.md`: decisiones técnicas iniciales.
- `docs/foundation/decisions-pending.md`: confirmaciones y pendientes institucionales.
- `docs/foundation/state-transitions.md`: estados e invariantes.
- `docs/foundation/data-model.md`: modelo lógico.
- `docs/foundation/api-and-events.md`: borrador HTTP y Socket.IO.

Las decisiones pendientes requieren validación de Secretaría/mesa o del responsable institucional indicado; no deben convertirse en reglas implícitas del software.
