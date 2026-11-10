import type { Actor, Row } from "./room/kernel";
export function mayViewWorkspace(actor: Actor, member: Row | undefined, host: Row | undefined, computerId: string, blocked: boolean): boolean {
  return actor.kind === "human" && actor.name === actor.account && member?.kind === "human" && member.status === "active" &&
    member.owner === actor.account && host?.kind === "host" && host.status === "active" && host.owner === actor.account &&
    host.device_id === computerId && !blocked;
}
