# Adaptador Socket.IO de Fase 03

`RealtimeGateway` valida credenciales de handshake mediante `RealtimeAuthorizer` y obtiene de ese adaptador la audiencia y los identificadores de sala. El cliente no puede solicitar unirse a una sala ni enviar comandos por socket. El gateway une al participante únicamente a su sala privada y al canal de participantes de la Asamblea para las notificaciones comunes de papeleta.

## Integración con Fase 02

- `RealtimeModule` enlaza `REALTIME_AUTHORIZER` con `RealtimeAuthService` de `AuthModule`. El adaptador valida el token de participante, el código aleatorio de Asamblea para público y el mecanismo de moderador configurado; resuelve `assemblyId` y, según audiencia, `sessionId` o `moderatorId`. Nunca confiar en ids o nombres de sala enviados por el cliente.
- El código de Asamblea solo permite estado/canal público de proyección incluso después de cerrar el lobby; `/join` aplica por separado el bloqueo de ingreso. No da acceso a moderación ni sustituye al token de participante. El credential del moderador viaja en el campo `auth` del handshake, no en query/URL.
- Inyectar `RealtimeGateway` en un adaptador de eventos de dominio de Fase 02 y llamar sus métodos tipados (`lobbyState`, `participantJoined`, `roundOpened`, etc.) después de la confirmación de persistencia/transacción. No enviar cuerpos HTTP, tokens, selección individual ni identificadores de sesión a canales compartidos.
- Los eventos son avisos sin garantía de entrega. El cliente recupera estado autoritativo mediante `GET /api/v1/assemblies/:assemblyCode/public-state`, `GET /api/v1/moderator/assemblies/:assemblyId` o `GET /api/v1/participant/me` tras conectar y reconectar; nunca inferir confirmación de voto desde Socket.IO.
- `participant.joined` y cambios con nombres se emiten solo a moderadores. Mientras el lobby está abierto, el proyector autorizado por el código público recupera nombres activos y el total mediante `public-state`; al iniciar una papeleta, esa respuesta deja de incluir la lista. El canal público solo recibe eventos agregados.
- La UI pública no recibe la lista operativa de quién emitió un voto. `participation.count` transporta solo totales agregados a público y moderación; los nombres del lobby no incluyen estado de participación.

## Contrato de conexión

Conectar a namespace `/events` con una credencial en `socket.handshake.auth`:

- Público: `{ audience: 'public', assemblyCode }`
- Participante: `{ audience: 'participant', participantSessionToken }`
- Moderador: `{ audience: 'moderator', assemblyId, moderatorCredential }`

Credencial ausente, inválida, con audiencia distinta o moderator `assemblyId` distinto al validado provoca desconexión. El mecanismo operativo de entrega del acceso de moderador sigue sujeto a la validación institucional de Fase 01/02.
