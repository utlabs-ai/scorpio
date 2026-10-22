#!/usr/bin/env node
// Packs the Skill package with a server baked into defaults.json, for the server to serve
// before (or instead of) the npm release. Not shipped in the package.
//   node tools/pack.mjs --server https://scorpio.example.workers.dev --out dist/scorpio.tgz
//   node tools/pack.mjs --server https://scorpio.example.workers.dev --dir dist
// --dir writes scorpio-<version>-<hash>.tgz plus latest.json naming it: npx caches a tarball by
// its URL, so every different package needs a different URL. It also writes latest, a small starter
// that installs whatever latest.json names (tools/latest/): npx -y <server>/dl/latest.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { buildId } from '../src/build-id.mjs'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const server = flag('--server')
const out = flag('--out')
const dir = flag('--dir')
if (!server || !/^https?:\/\/[^/]+/.test(server) || (!out && !dir)) {
  console.error('usage: node tools/pack.mjs --server <https://host> (--out <file.tgz> | --dir <dir>)')
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpio-pack-'))
try {
  const stage = path.join(work, 'package')
  fs.mkdirSync(stage)
  for (const f of [...pkg.files, 'package.json']) {
    const src = path.join(PKG_DIR, f)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(stage, f), { recursive: true })
  }
  fs.writeFileSync(path.join(stage, 'defaults.json'), JSON.stringify({ server: server.replace(/\/+$/, '') }, null, 2) + '\n')
  const build = buildId(stage)
  const res = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: stage, encoding: 'utf8' }))
  const packed = path.join(work, res[0].filename)
  let target
  if (dir) {
    const sha256 = createHash('sha256').update(fs.readFileSync(packed)).digest('hex')
    const file = `scorpio-${res[0].version}-${sha256.slice(0, 10)}.tgz`
    const d = path.resolve(dir)
    fs.mkdirSync(d, { recursive: true })
    target = path.join(d, file)
    const packageTmp = path.join(d, `.${file}.${process.pid}.tmp`)
    fs.copyFileSync(packed, packageTmp)
    fs.renameSync(packageTmp, target)
    // dl/latest, the install command that never changes: the starter in tools/latest, with this server in it.
    // npx keeps a tarball by its URL, so a fixed URL must hold something that never needs to change; the
    // starter reads latest.json each time it runs and installs the package it names.
    const starter = path.join(work, 'latest')
    fs.cpSync(path.join(PKG_DIR, 'tools', 'latest'), starter, { recursive: true })
    fs.writeFileSync(path.join(starter, 'server.json'), JSON.stringify({ server: server.replace(/\/+$/, '') }) + '\n')
    const st = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: starter, encoding: 'utf8' }))
    const starterTmp = path.join(d, `.latest.${process.pid}.tmp`)
    fs.copyFileSync(path.join(work, st[0].filename), starterTmp)
    fs.renameSync(starterTmp, path.join(d, 'latest'))
    // The manifest is the last switch: every file it names is already complete and old packages remain.
    const manifest = path.join(d, 'latest.json')
    const manifestTmp = path.join(d, `.latest.json.${process.pid}.tmp`)
    fs.writeFileSync(manifestTmp, JSON.stringify({ file, version: res[0].version, sha256, build }) + '\n')
    fs.renameSync(manifestTmp, manifest)
  } else {
    target = path.resolve(out)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(packed, target)
  }
  console.log(`${target} (${res[0].name}@${res[0].version}, ${res[0].entryCount} files, server ${server})`)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
