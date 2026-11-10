import { passcodeSweepPage } from "./room-index";

/** Seed expiry alarms for failures written before they existed, once across all topics not yet purged. */
export async function sweepPasscodeFailures(env: Env): Promise<void> {
  if (await env.KV.get("passcodeSweepV1")) return;
  let after = await env.KV.get("passcodeSweepV1:after") ?? "";
  let checkpointAt = 0;
  const waitForCheckpoint = async () => {
    // A timer may wake before the wall clock crosses the write window; check again after every wake.
    let remaining: number;
    while ((remaining = 1_000 - (Date.now() - checkpointAt)) > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  };
  for (;;) {
    const page = await passcodeSweepPage(env, after);
    if (!page.length) {
      await env.KV.put("passcodeSweepV1", "done");
      await waitForCheckpoint();
      await env.KV.delete("passcodeSweepV1:after");
      return;
    }
    // Settle the entire page before advancing: a failed call leaves this page for the next daily run.
    const results = await Promise.allSettled(page.map((id) => env.ROOMS.getByName(id).prunePasscodeFailures()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    after = page[page.length - 1];
    // Workers KV permits one write per second to a key, including a fast batch of DO calls.
    await waitForCheckpoint();
    await env.KV.put("passcodeSweepV1:after", after);
    checkpointAt = Date.now();
  }
}
