import assert from 'node:assert/strict'
import test from 'node:test'
import { ticketFileAvailable } from '../src/room-file-ticket.ts'

test('a preview requires the current undeleted file and the signed hash', () => {
  assert.equal(ticketFileAvailable({ hash: 'current', deleted_at: null }, 'current'), true)
  assert.equal(ticketFileAvailable(undefined, 'current'), false)
  assert.equal(ticketFileAvailable({ hash: 'current', deleted_at: 123 }, 'current'), false)
  assert.equal(ticketFileAvailable({ hash: 'changed', deleted_at: null }, 'current'), false)
})
