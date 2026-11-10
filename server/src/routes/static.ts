import { messagePage } from "../message-page";
import { redirect, type Route, type RouteContext } from "./shared";

// Tried after a deployment's own pages (index.ts createWorker): without a homepage of its own, / is the app.
export const publicRoutes: Route[] = [{ method: "GET", match: "/", handler: async () => redirect("/app") }];

export function notFound(c: RouteContext): Response {
  const { lang, user } = c;
  return messagePage(
    lang,
    user,
    "404",
    lang === "zh" ? "没有这个页面。" : "Not found.",
    404,
  );
}
