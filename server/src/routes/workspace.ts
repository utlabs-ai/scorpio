import { ApiError, json } from "../util";
import { sameOrigin } from "../auth";
import { roomStub } from "../room-stub";
import { workspaceHosts, workspaceSelection, workspaceStart } from "../workspace-actions";
import { workspacePage } from "../workspace-page";
import { internalUpgrade, type Route, type SignedRouteContext } from "./shared";

const cache = { "Cache-Control": "private, no-store, no-transform" };
async function body(req: Request): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(req.headers.get("content-type") || "") || !req.body) throw new ApiError("workspace_protocol_error", "Expected JSON metadata.");
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16384) { await reader.cancel(); throw new ApiError("workspace_protocol_error", "Workspace metadata is too large.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)); } catch { throw new ApiError("workspace_protocol_error", "Invalid workspace metadata."); }
}
export const signedRoutes: Route<SignedRouteContext>[] = [{
  method: ["GET", "POST"], match: /^\/r\/([A-Za-z0-9_-]{22})\/workspace(?:\/(hosts|ws|request))?$/, errors: "json",
  handler: async ({ req, env, user, url, lang }, m) => {
    const topicId = m![1], sub = m![2] || "", actor = { kind: "human" as const, account: user.handle, name: user.handle };
    const stub = await roomStub(env, topicId).catch(() => { throw new ApiError("workspace_not_found", "Workspace not found.", 404); });
    const computerId = url.searchParams.get("computer") || undefined;
    try {
      if (req.method === "GET" && sub === "hosts") return json(await workspaceHosts(stub, actor), 200, cache);
      if (req.method === "POST" && sub === "request") {
        if (!sameOrigin(req, env)) throw new ApiError("forbidden", "Cross-site request refused.", 403);
        if (!computerId) throw new ApiError("workspace_not_found", "Workspace not found.", 404);
        return json(await workspaceStart(stub, actor, computerId, await body(req)), 200, cache);
      }
      if (req.method === "GET" && sub === "ws") {
        if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket" || !sameOrigin(req, env) || req.headers.get("Origin") !== url.origin) throw new ApiError("forbidden", "Cross-site request refused.", 403);
        const selected = await workspaceSelection(stub, actor, computerId);
        const upgraded = internalUpgrade(req, actor);
        return stub.fetch(new Request(`https://room/workspace?computer=${encodeURIComponent(selected.computer.computerId)}`, upgraded));
      }
      if (req.method === "GET" && sub === "") return workspacePage(lang, { ...await workspaceSelection(stub, actor, computerId), viewerAccount: user.handle }, url.searchParams.get("embed") === "1");
      throw new ApiError("workspace_not_found", "Workspace not found.", 404);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, next: e.next }, e.status, cache);
      throw e;
    }
  },
}];
