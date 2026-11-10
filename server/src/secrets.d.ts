// Secrets are not in wrangler.jsonc, so `wrangler types` does not see them. All optional:
// a provider without its pair is shown as "not configured" on the sign-in page.
interface Env {
  /** For a deployment used for testing: disallow crawlers and mark Worker responses as noindex. */
  NOINDEX?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Enables the key-protected test sign-in. Leave unset in production. */
  DEV_LOGIN_KEY?: string;
  /** Web Push: the VAPID private key, an ECDSA P-256 JWK. Without it nothing is pushed and the page offers no switch. */
  VAPID_PRIVATE_JWK?: string;
  /** Who push services may contact about our pushes (mailto: or https:); default PUBLIC_URL. */
  VAPID_SUBJECT?: string;
  /** Tests only: how long an upload may stay unsent before it is swept (default 10 minutes). */
  UPLOAD_UNSENT_TTL_MS?: string;
  /** Tests only: how recent an upload must be to be spared by eviction (default 10 minutes). */
  EVICT_RECENT_MS?: string;
  /** Tests only: JSON {"free": {...}, "pro": {...}} of limits to use instead (small ones, to reach them quickly). */
  TEST_LIMITS?: string;
  /** Tests only: JSON {"messages", "files", "bytes"} export limits instead of 100,000 / 1,000 / 2 GiB (export.ts). */
  TEST_EXPORT_LIMITS?: string;
  /** Tests only: JSON {"archiveAfterDays", "binAfterDays"} in days (fractions too) instead of 90 / 90. */
  TEST_RETENTION?: string;
  /** Drive backup: the key the Google refresh tokens are sealed with in D1 (AES-GCM, 32 bytes, base64). Without it, no Drive backup. */
  DRIVE_TOKEN_KEY?: string;
  /** Invites: the key e-mail and machine ids are hashed with (HMAC-SHA256). Without it, no invite is recorded or rewarded. */
  INVITE_SALT?: string;
  /** Tests only: Google's endpoints at <base>/<host>/<path> instead (a fake Google). */
  GOOGLE_API_BASE?: string;
  /** Turnstile on sign-up: the widget's site key and secret. Without both, sign-up is not checked. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** HMAC key for email login codes and rate-ledger digests. */
  LOGIN_CODE_KEY?: string;
  /** The onboarded sending domain; sign-in codes come from no-reply@<it>. */
  EMAIL_SENDING_DOMAIN?: string;
  /** Set only after the hosted release gate has proved an unverified external delivery. */
  EMAIL_LOGIN_DELIVERY_VERIFIED?: string;
  /** Explicit self-hosted choice to run email sign-in without Turnstile. */
  EMAIL_LOGIN_NO_TURNSTILE?: string;
  /** File storage (R2). Without it the deployment takes no files: uploads are refused and everything else finds none. */
  FILES?: R2Bucket;
  EMAIL?: { send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<{ messageId: string }> };
  /** Paying for Pro: Creem's API key (creem_test_… = its sandbox) and the secret its webhook is signed with. */
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  /** Tests only: a stand-in for Creem's API. */
  CREEM_API_BASE?: string;
  /** The ops page's cost tab: a Cloudflare API token with Account Analytics: Read only. Without it the tab says so. */
  CF_ANALYTICS_TOKEN?: string;
  /** The Cloudflare account to read; looked up with the token when unset. */
  CF_ACCOUNT_ID?: string;
  /** Tests only: a stand-in for the Cloudflare API. */
  CF_API_BASE?: string;
  /** A file's own page: the key its content domain's tickets are signed with (any random string, 32+ characters). Without it, files are only downloaded. */
  VIEW_TICKET_KEY?: string;
}
