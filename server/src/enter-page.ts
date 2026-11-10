import { escapeHtml as e } from "./util";
import type { User } from "./auth";
import type { Lang } from "./layout";
import { strings } from "./strings";
import { shellPage, msgCard } from "./shell-page";

/** A private room's passcode form; `next`: a file's page (/v/<id>) to go back to once in, never naming the file. */
export function enterPage(lang: Lang, user: User, roomId: string, error?: string, next?: string | null, status?: number): Response {
  const t = strings(lang);
  // No topic metadata enters this page before the visitor has joined.
  return shellPage(lang, user, {
    title: t.privateTopic,
    pageTitle: "Scorpio",
    path: next || `/r/${roomId}`,
    center: true,
    status,
    body: msgCard({
      icon: "lock",
      title: t.enterCode,
      text: next ? t.fileForCode : undefined,
      inner: `<form method="post" action="/r/${e(roomId)}/enter">${next ? `<input type="hidden" name="next" value="${e(next)}">` : ""}<div class="sx-fld"><input class="sx-in${error ? " sx-bad" : ""}" type="password" name="code" required autocomplete="off" autofocus aria-label="${e(t.enterCode)}">${error ? `<p class="sx-err">${e(error)}</p>` : ""}</div><button class="sx-btn sx-primary sx-lg sx-wide">${e(t.enter)}</button></form>`,
    }),
  });
}
