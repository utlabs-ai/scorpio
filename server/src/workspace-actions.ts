import { unwrap } from "./room-actions";
import type { Actor } from "./room-do";
import type { RoomStub } from "./routes/shared";
export const workspaceHosts = async (stub: RoomStub, actor: Actor) => unwrap(await stub.workspaceHosts(actor));
export const workspaceSelection = async (stub: RoomStub, actor: Actor, computerId?: string) => unwrap(await stub.workspaceSelection(actor, computerId));
export const workspaceStart = async (stub: RoomStub, actor: Actor, computerId: string, body: unknown) => unwrap(await stub.workspaceStart(actor, computerId, body));
