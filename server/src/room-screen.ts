// Pane screens belong to the sending computer's account, independently of who reads the message.
export type Screen = { text: string; hidden: number };
export type OwnedScreen = Screen & { account: string };
export const SCREEN_MAX = 64 * 1024;

export function messageScreen(kind: string, value: unknown):
  { screen?: Screen; error?: undefined } | { error: { code: string; next: string; status: number }; screen?: undefined } {
  if (value === undefined) return {};
  const bad = (next: string) => ({ error: { code: "bad_request", next, status: 400 } });
  if (kind !== "host") return bad("Only a command seat may send a screen.");
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("screen must be {text, hidden}.");
  const { text, hidden } = value as Record<string, unknown>;
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > SCREEN_MAX) return bad("screen.text must be a string of at most 64 KB.");
  if (typeof hidden !== "number" || !Number.isInteger(hidden) || hidden < 0) return bad("screen.hidden must be a whole number greater than or equal to zero.");
  return { screen: { text, hidden } };
}

export function screenFor(screen: OwnedScreen | undefined, account: string | null | undefined): { screen?: Screen } {
  return screen && account === screen.account ? { screen: { text: screen.text, hidden: screen.hidden } } : {};
}
