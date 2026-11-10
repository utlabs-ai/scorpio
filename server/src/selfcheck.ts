// A device-token health connection handled by the Worker, without waking a topic.
import { ApiError, randomId } from "./util";

export function selfcheck(req: Request): Response {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError("bad_request", "Expected a WebSocket upgrade.", 426);
  }
  const [client, server] = Object.values(new WebSocketPair());
  const nonce = randomId(24);
  let done = false;
  server.accept();
  const timeout = setTimeout(() => finish(), 10_000);
  function finish(ok = false) {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    if (ok) server.send(JSON.stringify({ type: "selfcheck_ok" }));
    server.close();
  }
  server.addEventListener("message", (event) => {
    let frame: unknown;
    try { frame = JSON.parse(String(event.data)); } catch { finish(); return; }
    const reply = frame as { type?: unknown; nonce?: unknown } | null;
    finish(reply?.type === "selfcheck" && reply.nonce === nonce);
  });
  server.addEventListener("close", () => finish());
  server.send(JSON.stringify({ type: "selfcheck", nonce }));
  return new Response(null, { status: 101, webSocket: client });
}
