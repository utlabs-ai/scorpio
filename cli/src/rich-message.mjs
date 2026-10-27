import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CliError } from './client.mjs'
import { labelWidth } from './label-width.mjs'

export const CARD_MAX = 256 * 1024
const ONE_LINE = /[\p{Cc}\u2028\u2029]/u
const NEXT = {
  bad_buttons: 'Buttons: 1 to 4 per message, up to 12 CJK or 24 Latin characters each, on one line, all different. Trim them and send again.',
  card_too_large: 'The card is over 256 KB. Aggregate or downsample the data, drop unused parts, and send again.',
  card_summary_required: 'A card needs summary= (1 to 300 characters, one line): what the chart shows and its key numbers. Search and anyone who cannot see the chart read that line.',
}
const bad = (code) => { throw new CliError(code, NEXT[code]) }

// Validate before uploading attachments, so an invalid card or button never sends part of a message.
export function richMessageArgs(args) {
  const body = {}
  if (args.buttons !== undefined) {
    const raw = args.buttons.split('|')
    const labels = raw.map(s => s.trim())
    if (labels.length > 4 || raw.some(s => ONE_LINE.test(s)) ||
        labels.some(s => !s || labelWidth(s) > 24) || new Set(labels).size !== labels.length) bad('bad_buttons')
    body.buttons = labels
  }
  if (args.card === undefined) {
    if (args.summary !== undefined) throw new CliError('bad_request', 'summary= goes with card=<file>.')
    return body
  }
  if (!args.summary?.trim() || Array.from(args.summary).length > 300 || ONE_LINE.test(args.summary)) bad('card_summary_required')
  const file = path.resolve(args.card.replace(/^~(?=\/|$)/, os.homedir()))
  let html
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error('not a file')
    if (stat.size > CARD_MAX) bad('card_too_large')
    html = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('bad_request', 'Cannot read card=. Give a readable HTML fragment file.')
  }
  if (Buffer.byteLength(html, 'utf8') > CARD_MAX) bad('card_too_large')
  body.card = { kind: 'html', summary: args.summary, html }
  return body
}
