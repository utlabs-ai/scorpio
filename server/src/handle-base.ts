/** The qa- prefix is reserved for test identities; real sign-ins get a distinct account handle. */
export function baseHandle(suggested: string, isTest: boolean): string {
  let base = suggested
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 39)
    .replace(/-$/, "") || "user";
  if (isTest && !base.startsWith("qa-")) base = `qa-${base}`.slice(0, 39);
  if (!isTest && base.startsWith("qa-")) base = `user-${base}`.slice(0, 39);
  return base;
}
