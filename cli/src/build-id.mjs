import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

// Identify the unpacked package by its contents, independently of tarball metadata.
export function buildId(dir) {
  const files = []
  function collect(at, relative = '') {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) collect(path.join(at, entry.name), name)
      else if (entry.isFile()) files.push(name)
    }
  }
  collect(dir)
  const hash = createHash('sha256')
  for (const name of files.sort()) {
    const contents = fs.readFileSync(path.join(dir, name))
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(contents.length))
    hash.update(name).update('\0').update(length).update(contents)
  }
  return hash.digest('hex')
}
