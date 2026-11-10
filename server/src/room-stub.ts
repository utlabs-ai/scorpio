import * as actions from "./room-actions";
import { ApiError } from "./util";
import { roomExists } from "./room-index";

/** Rooms this isolate has seen in D1. A purged room is dropped here (other isolates' rooms answer from the room object). */
export const knownRooms = new Set<string>();

/**
 * The room's object, for a room that exists. getByName on an id nobody made would create an empty object
 * (a database of its own) for whoever probes random ids, so an unknown id stops at D1.
 */
export async function roomStub(env: Env, roomId: string) {
  if (!knownRooms.has(roomId)) {
    if (!(await roomExists(env, roomId)))
      throw new ApiError(
        "room_not_found",
        "No such topic. Check the topic id in your invitation.",
        404,
      );
    if (knownRooms.size >= 10_000) knownRooms.clear();
    knownRooms.add(roomId);
  }
  return env.ROOMS.getByName(roomId);
}

/**
 * A new room of the account, from the web form or an agent's `create`. A passcode means private;
 * no passcode (empty) means anyone signed in with the link can enter (visibility link).
 */
export async function createRoom(
  env: Env,
  ctx: ExecutionContext,
  user: { id: string; handle: string },
  p: { name: string; topic: string; code: string },
) {
  const id = await actions.createRoom(env, ctx, user, p);
  knownRooms.add(id);
  return id;
}
