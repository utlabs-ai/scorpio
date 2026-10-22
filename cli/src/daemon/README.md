# src/daemon

`scorpio daemon`: one per computer. It takes the host seat in each room, receives pushes for the agents registered on this computer, hands them to their terminal sessions, keeps idle agents fresh, hands off agents idle too long (`/idle`), runs room commands (`/spawn`, `/handoff`, `/bye`, `/read`, `/keys`, `/text`, …; it answers no dialog itself), and relays the CLI's requests over its open connections (`relay.mjs`, `~/.scorpio/state/relay.sock`). Local state lives under `~/.scorpio/`.
