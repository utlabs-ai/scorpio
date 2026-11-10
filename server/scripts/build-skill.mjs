#!/usr/bin/env node
// Pack the Skill package for this deployment into web/public/dl/. The server baked in is SCORPIO_PUBLIC_URL, or
// PUBLIC_URL in the repository root's wrangler.jsonc. With neither, the deployment does not know its address yet
// (a deploy button picks it later), so the package names no server: the install command in invitations then
// passes --server with the address the invitation was opened on.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.resolve(here, '..')
const cfg = fs.readFileSync(path.join(server, '../wrangler.jsonc'), 'utf8')
const fromCfg = /"PUBLIC_URL"\s*:\s*"([^"]*)"/.exec(cfg)?.[1]
const url = process.env.SCORPIO_PUBLIC_URL || fromCfg
execFileSync('node', [path.join(server, '../cli/tools/pack.mjs'), ...(url ? ['--server', url] : []), '--dir', path.join(server, '../web/public/dl')], { stdio: 'inherit' })
