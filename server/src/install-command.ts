// The install command in a topic's invitation. The Skill package served at /dl/ has this deployment's address
// baked in, unless it was built before the address was known (latest.json says "unbound"): then the command
// passes the address the invitation was opened on. Without a package of its own, the published one.
export type Latest = { file: string; unbound?: boolean };

export function installCommand(base: string, latest: Latest | null): string {
  if (!latest) return "npx -y @utlabs/scorpio";
  return `npx -y ${base}/dl/${latest.file}${latest.unbound === true ? ` --server ${base}` : ""}`;
}
