// What kind of file something is, for its own page (docs/api/files.md), and where its bytes are. No imports, so
// node tests load it as it is.

/** The types a file is shown as an image with, decided by its bytes (files.ts sniffImage; no SVG: it can carry script). */
export const isImage = (type: string) => type === "image/png" || type === "image/jpeg" || type === "image/gif" || type === "image/webp";
export const isVideo = (type: string) => type === "video/mp4" || type === "video/webm" || type === "video/quicktime";

export const fileKey = (roomId: string, hash: string) => `rooms/${roomId}/files/${hash}`;

export type ViewKind = "image" | "svg" | "markdown" | "html" | "text" | "other";

/** Kinds shown in the frame on the content domain. */
export type FrameKind = "markdown" | "html" | "text" | "svg";

const HTML_EXT = new Set(["html", "htm"]);
const MD_EXT = new Set(["md", "markdown", "mdown", "mkd"]);
const TEXT_EXT = new Set(
  (
    "txt text log csv tsv json jsonl ndjson geojson yaml yml toml ini cfg conf env properties xml rss " +
    "js mjs cjs ts tsx jsx vue svelte css scss sass less py pyi rb go rs java kt kts scala swift m mm c h cc cpp cxx hpp hh cs fs php pl lua r " +
    "sh bash zsh fish ps1 bat cmd sql graphql gql proto dart ex exs erl hs clj elm nim zig v sol tex bib rst adoc org diff patch " +
    "lock gradle cmake mk dockerfile tf hcl nix srt vtt"
  ).split(" "),
);
const TEXT_NAMES = new Set(["dockerfile", "makefile", "license", "licence", "readme", "changelog", "notice", "authors", "procfile", "gemfile", "rakefile", ".gitignore", ".gitattributes", ".editorconfig", ".npmrc", ".env.example"]);
const TEXT_TYPE = /^(text\/[a-z0-9.+-]+|application\/(json|ld\+json|x-ndjson|xml|yaml|x-yaml|toml|javascript|x-javascript|ecmascript|x-sh|x-shellscript|sql|x-python|x-httpd-php|graphql))$/;

/**
 * How a file is shown on its page. The name's extension decides (the CLI's type comes from it too), else the type it
 * was uploaded with; images by their bytes, as everywhere (files.ts).
 */
export function viewKind(name: string, type: string): ViewKind {
  if (isImage(type)) return "image";
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  if (HTML_EXT.has(ext)) return "html";
  if (MD_EXT.has(ext)) return "markdown";
  if (ext === "svg") return "svg"; // a picture, but only ever as an <img> on the content domain: it can carry script
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(lower)) return "text";
  if (ext) return "other";
  if (type === "text/html") return "html";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  return TEXT_TYPE.test(type) ? "text" : "other";
}

/** Markdown, plain text and SVG larger than this are not shown in the page, only downloaded (rendering them would stall it). */
export const PREVIEW_MAX = 2 * 1024 * 1024;

/** Whether this file is shown in the frame (and so gets tickets): its kind, and not too large to render. */
export function framed(kind: ViewKind, size: number): kind is FrameKind {
  return kind === "html" || ((kind === "markdown" || kind === "text" || kind === "svg") && size <= PREVIEW_MAX);
}
