// workerd's nodejs_compat gives the Worker Node's zlib; wrangler's types do not describe it. Only what zip.ts uses.
declare module "node:zlib" {
  /** CRC-32 of `data`, continued from `value` (the CRC so far; 0 at the start). */
  export function crc32(data: Uint8Array | string, value?: number): number;
}
