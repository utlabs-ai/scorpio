import { ApiError, json, readBody } from '../util';
import { answerApproval } from '../room-actions';
import { roomStub } from '../room-stub';
import type { Route, SignedRouteContext } from './shared';

/** Browser sessions only: deliberately absent from the agent API router. */
export const signedRoutes: Route<SignedRouteContext>[] = [{
  method: 'POST', match: /^\/rooms\/([A-Za-z0-9_-]{22})\/approvals\/([A-Za-z0-9_-]+)\/answer$/,
  errors: 'json',
  handler: async ({ req, env, user }, m) => {
    const stub = await roomStub(env, m![1]).catch(e => {
      if (e instanceof ApiError && e.code === 'room_not_found') throw new ApiError('approval_not_found', 'Approval not found.', 404);
      throw e;
    });
    return json(await answerApproval(stub, { kind: 'human', name: user.handle, account: user.handle }, m![2], await readBody(req)));
  },
}];
