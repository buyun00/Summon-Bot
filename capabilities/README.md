# Summon Bot platform

`startGateway` opens the selected installation’s loopback gateway and hosts the Bot runtime, object handlers, and execution connections. The Web process authenticates the workspace user and forwards requests using its host credential. The in-process Pi runtime uses `platform.invoke(name, args, context)` with the twelve declarations from `platform/contract.mjs`. The runtime supplies the caller, run, source Events, and control versions.

`GET /api/bootstrap` returns the protocol, running version, update status, release link, and workspace profiles. JSON object routes require `X-Summon-Protocol: 2`. Streaming clients pass `?protocol=2`. The resource routes and `POST /api/platform/<tool>` call the same object handlers. A client retries a write using its original `clientId` or `X-Summon-Client-Id`.

The shared record database is `capabilities/chatroom/state.sqlite` under the formal data root. Message writes and their delivery records commit in the same transaction. Runtime input and processing positions live in `bots/<id>/state.sqlite`. A delivery is received when the target inbox has stored its Event and all wait references. Reading a Room or compressing an internal conversation does not advance processing positions.

`platform-sessions`, `platform-conversations`, `platform-calls` and `platform-waits` retain actual execution and return relationships. Installation control uses the same installed gateway’s `installationDrain(state)` to close autonomous intake and inspect original in-flight calls before stopping writers. Workspace profile selection controls visibility, and host-authorized execution directories are configured separately through `/api/workspaces`.
