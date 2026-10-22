#!/bin/sh
# The guard is loaded before an update replaces app/. It keeps watching the daemon across the swap.
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE=node
BEST=0
for CANDIDATE in "${SCORPIO_HOME:-$HOME/.scorpio}/node/bin/node" "${SCORPIO_NODE:-}" node; do
  [ -n "$CANDIDATE" ] || continue
  [ "$CANDIDATE" = node ] || [ -x "$CANDIDATE" ] || continue
  NUMBER="$("$CANDIDATE" -p 'const [a,b,c]=process.versions.node.split(".").map(Number); a*1000000+b*1000+c' 2>/dev/null)" || continue
  if [ "$NUMBER" -gt "$BEST" ] 2>/dev/null; then NODE="$CANDIDATE"; BEST="$NUMBER"; fi
done
# Keep R1's ten-second re-check across the install rename gap before loading the guard.
for ATTEMPT in 1 2 3 4 5 6 7 8 9 10; do
  [ -f "$DIR/main.mjs" ] && [ -f "$DIR/guard.mjs" ] && break
  sleep 1
done
[ -f "$DIR/main.mjs" ] && [ -f "$DIR/guard.mjs" ] || exit 0
exec "$NODE" "$DIR/guard.mjs"
