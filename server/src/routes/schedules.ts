import type { Actor } from "../room-do";
import * as actions from "../room-actions";
import { ApiError, json } from "../util";
import type { RoomStub } from "./shared";

export async function scheduleList(
  stub: RoomStub,
  actor: Actor,
  id?: string,
): Promise<Response> {
  return json(await actions.schedules(stub, actor, id));
}

export async function scheduleOp(
  stub: RoomStub,
  actor: Actor,
  body: Record<string, unknown>,
  id?: string,
): Promise<Response> {
  if (id)
    throw new ApiError(
      "bad_request",
      "POST schedules takes an op in the body, not an id in the path.",
      404,
    );
  return json(await actions.scheduleOp(stub, actor, body));
}
