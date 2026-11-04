// Content-bearing workspace and approval frames must be excluded before serialization, even in debug mode.
export function debugFrame(key, frame, write = console.log) {
  if (frame.type?.startsWith('workspace_') || frame.type?.startsWith('approval_')) return
  write(new Date().toTimeString().slice(0, 8), `frame ${key}: ${JSON.stringify(frame).slice(0, 300)}`)
}
