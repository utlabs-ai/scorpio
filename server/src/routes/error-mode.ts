import { signedRoutes as cardRoutes } from "./cards";
import { appRoutes as homeRoutes } from "./home";
import { signedRoutes as fileRoutes } from "./files";
import { subRoutes, postRoutes } from "./room-page";
export function errorModeOf(path: string): "json" | "negotiate" {
  if (/^\/r\/[^/]+\/workspace\/(?:hosts|ws|request)$/.test(path)) return "json";
  if (/^\/rooms\/[^/]+\/approvals\/[^/]+\/answer$/.test(path)) return "json";
  if (
    ["/api/", "/oauth/", "/push/", "/f/"].some((prefix) =>
      path.startsWith(prefix),
    )
  )
    return "json";
  if (path === "/search")
    return homeRoutes.find((r) => r.match === "/search")?.errors || "negotiate";
  const card = cardRoutes.find(r => typeof r.match !== "string" && r.match.test(path));
  if (card) return card.errors || "negotiate";
  const ticket = /^\/v\/[^/]+\/ticket$/.exec(path);
  if (ticket)
    return (
      fileRoutes.find((r) => typeof r.match !== "string" && r.match.test(path))
        ?.errors || "negotiate"
    );
  const room = /^\/r\/[^/]+\/([A-Za-z]+)(?:\/([^/]+))?$/.exec(path);
  if (room) {
    if (room[2] && room[1] !== "schedules") return "negotiate";
    return (
      [...subRoutes, ...postRoutes].find((r) => r.match === room[1])?.errors ||
      "negotiate"
    );
  }
  return "negotiate";
}
