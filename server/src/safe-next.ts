// Where a sign-in or a language switch may send the browser next: only somewhere on this site. Decided by
// the URL parser browsers use, so "/\evil.com", "//evil.com", "https://evil.com" and their tab or newline variants,
// which all resolve to another host, fall back to "/". What comes back is a path, never an address.
// A path the parser itself leaves starting with "//" (from "/.//evil.com", "https://this-site//evil.com", ...)
// is on this site to the parser but another host to a browser reading it back as a Location, so it is "/" too.

export function localNext(next: string | null | undefined, origin: string): string {
  if (!next) return "/";
  let to: URL;
  try {
    to = new URL(next, origin);
  } catch {
    return "/";
  }
  if (to.origin !== new URL(origin).origin) return "/";
  if (to.pathname.startsWith("//") || to.pathname.startsWith("/\\")) return "/";
  return to.pathname + to.search + to.hash;
}
