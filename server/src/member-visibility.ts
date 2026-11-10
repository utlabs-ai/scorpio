import type { Member } from "./room/types";

export type ViewerMember = Pick<Member, "name" | "displayName" | "kind">;

/** A null account is a public-topic viewer; members see computer details only for their own account. */
export function membersFor(members: Member[], account: string): Member[];
export function membersFor(members: Member[], account: null): ViewerMember[];
export function membersFor(members: Member[], account: string | null): (Member | ViewerMember)[];
export function membersFor(members: Member[], account: string | null): (Member | ViewerMember)[] {
  return members.map((m) => {
    if (account === null) return { name: m.name, displayName: m.displayName, kind: m.kind };
    if (m.owner === account) return m;
    const { clis, perm, perms, device, ...visible } = m;
    return { ...visible, perm: null, perms: null, device: device ? { name: device.name, note: device.note } : null };
  });
}
