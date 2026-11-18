// The host supplies the originating Room. A receipt destination never grants file access.
export function workspaceGranted(get, actor, id, projectRoom, fixedWorkspace) {
  if (projectRoom) {
    const room = get('rooms', projectRoom.id);
    if (!room?.members.includes(actor.id)) return false;
    if (fixedWorkspace && room.workspace?.id !== fixedWorkspace) return false;
    if (room.workspace) return room.workspace.id === id;
  }
  return actor.kind === 'user' || Boolean(get('platform-access', actor.id)?.workspace_ids?.includes(id));
}
