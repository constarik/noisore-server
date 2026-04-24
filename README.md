# NOISORE Multiplayer Server

UVS v2 Move Sync G=1 — WebSocket multiplayer for SOIRON mode.

## Protocol

### WebSocket Messages (Client → Server)

| Type | Fields | Description |
|------|--------|-------------|
| `create_room` | name, color, gridSize, rotate, maxPlayers | Create a room, become host |
| `join_room` | roomId, name, color | Join existing room |
| `start_game` | — | Host starts the game |
| `move` | col | Submit column choice for current tick |
| `list_rooms` | — | List open lobbies |

### WebSocket Messages (Server → Client)

| Type | Fields | Description |
|------|--------|-------------|
| `room_created` | roomId, playerId | Room created successfully |
| `room_joined` | roomId, playerId | Joined room |
| `lobby` | players[], config | Lobby state update |
| `game_start` | serverSeedHash, clientSeed, grid, config | Game begins (seed committed) |
| `tick_start` | tick, dropPower, order[] | New tick — pick your column |
| `move_locked` | playerId, tick | A player locked in their move |
| `tick_result` | tick, results[], grid, rotated, winner | Tick resolved — drops applied |
| `game_end` | winner, uvs{serverSeed, moves, verified} | Game over — seed revealed |
| `player_left` | playerId | Player disconnected |
| `error` | error | Error message |

### Game Flow

1. Host creates room → players join
2. Host starts → server generates ChaCha20 seed, initializes grid
3. Each tick: server sends dropPower → players pick column → 10s timeout
4. Server applies drops in deterministic order (sorted playerId)
5. After all drops: rotation (if enabled)
6. Channel found → game ends, serverSeed revealed, UVS verified

## Deploy on Render

1. Push to GitHub
2. New Web Service → connect repo
3. Build: `npm install`
4. Start: `node server.js`
5. Environment: `PORT` (auto-set by Render)

## Local Dev

```bash
npm install
node server.js  # starts on :3001
```
