/**
 * NOISORE Multiplayer Server — UVS Move Sync G=1
 * WebSocket + Express on Render
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { NoisoreEngine } = require('./engine-server');

// --- UVS crypto (subset of uvs-sdk, no external deps) ---
function sha256(str) { return crypto.createHash('sha256').update(str).digest('hex'); }
function sha512(str) { return crypto.createHash('sha512').update(str).digest('hex'); }
function randomHex(n) { return crypto.randomBytes(n).toString('hex'); }

// ChaCha20 (RFC 8439) — same as uvs-sdk
function chacha20Block(key, nonce, counter) {
  const rotl = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
  const qr = (s, a, b, c, d) => {
    s[a]=(s[a]+s[b])>>>0;s[d]=rotl(s[d]^s[a],16);
    s[c]=(s[c]+s[d])>>>0;s[b]=rotl(s[b]^s[c],12);
    s[a]=(s[a]+s[b])>>>0;s[d]=rotl(s[d]^s[a],8);
    s[c]=(s[c]+s[d])>>>0;s[b]=rotl(s[b]^s[c],7);
  };
  const k = new Uint32Array(8), n2 = new Uint32Array(3);
  for (let i=0;i<8;i++) k[i]=key.readUInt32LE(i*4);
  for (let i=0;i<3;i++) n2[i]=nonce.readUInt32LE(i*4);
  const s = new Uint32Array([0x61707865,0x3320646e,0x79622d32,0x6b206574,k[0],k[1],k[2],k[3],k[4],k[5],k[6],k[7],counter>>>0,n2[0],n2[1],n2[2]]);
  const w = new Uint32Array(s);
  for(let i=0;i<10;i++){qr(w,0,4,8,12);qr(w,1,5,9,13);qr(w,2,6,10,14);qr(w,3,7,11,15);qr(w,0,5,10,15);qr(w,1,6,11,12);qr(w,2,7,8,13);qr(w,3,4,9,14);}
  const out = Buffer.alloc(64);
  for(let i=0;i<16;i++) out.writeUInt32LE((w[i]+s[i])>>>0,i*4);
  return out;
}

class ChaCha20 {
  constructor(key, nonce) {
    this._key=key; this._nonce=nonce; this._counter=0; this._buf=[]; this._totalCalls=0;
  }
  nextUint32() {
    if(!this._buf.length){const b=chacha20Block(this._key,this._nonce,this._counter++);for(let i=0;i<64;i+=4)this._buf.push(b.readUInt32LE(i));}
    this._totalCalls++; return this._buf.shift();
  }
  nextFloat() { return this.nextUint32() / 0x100000000; }
  get calls() { return this._totalCalls; }
  static fromCombinedSeed(hex) {
    const buf = Buffer.from(hex, 'hex');
    return new ChaCha20(buf.slice(0,32), buf.slice(32,44));
  }
}

// --- Room Manager ---
const rooms = new Map();
let roomCounter = 1000;

function generateRoomId() { return String(++roomCounter); }

class Room {
  constructor(id, config) {
    this.id = id;
    this.players = new Map(); // playerId → { ws, name, color }
    this.config = config; // { gridSize, rotate, maxPlayers }
    this.state = 'LOBBY'; // LOBBY → PLAYING → FINISHED
    this.engine = null;
    this.uvs = null;
    this.tick = 0;
    this.pendingMoves = new Map(); // playerId → col
    this.dropPower = 0;
    this.moveTimeout = null;
    this.MOVE_WINDOW_MS = 10000; // 10s to pick column
    this.hostId = null;
  }

  broadcast(msg) {
    const str = JSON.stringify(msg);
    for (const [, p] of this.players) {
      if (p.ws.readyState === 1) p.ws.send(str);
    }
  }

  sendTo(playerId, msg) {
    const p = this.players.get(playerId);
    if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  }

  addPlayer(playerId, name, color, ws) {
    if (this.state !== 'LOBBY') return { error: 'game_in_progress' };
    if (this.players.size >= (this.config.maxPlayers || 6)) return { error: 'room_full' };
    this.players.set(playerId, { ws, name, color });
    if (!this.hostId) this.hostId = playerId;
    this.broadcastLobby();
    return { ok: true };
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    if (playerId === this.hostId) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    if (this.players.size === 0) {
      rooms.delete(this.id);
      return;
    }
    if (this.state === 'LOBBY') this.broadcastLobby();
    else this.broadcast({ type: 'player_left', playerId });
  }

  broadcastLobby() {
    const playerList = [];
    for (const [id, p] of this.players) {
      playerList.push({ id, name: p.name, color: p.color, isHost: id === this.hostId });
    }
    this.broadcast({ type: 'lobby', roomId: this.id, players: playerList, config: this.config });
  }

  startGame() {
    if (this.players.size < 2) return { error: 'need_2_players' };

    // UVS seeds
    const serverSeed = randomHex(32);
    const clientSeed = 'noisore-room-' + this.id + '-' + Date.now();
    const nonce = '1';
    const serverSeedHash = sha256(serverSeed);
    const combinedSeed = sha512(serverSeed + ':' + clientSeed + ':' + nonce);
    const rng = ChaCha20.fromCombinedSeed(combinedSeed);

    this.uvs = { serverSeed, clientSeed, nonce, serverSeedHash, combinedSeed, moves: [] };

    // Engine
    const gs = this.config.gridSize || 6;
    this.engine = new NoisoreEngine(gs, gs, 10, this.config.rotate, rng);
    this.engine.initGrid();

    this.state = 'PLAYING';
    this.tick = 0;

    // Broadcast game start (seed hash, NOT seed)
    this.broadcast({
      type: 'game_start',
      serverSeedHash,
      clientSeed,
      nonce,
      grid: this.engine.copyGrid(),
      config: this.config
    });

    // Start first tick
    this.startTick();
    return { ok: true };
  }

  startTick() {
    this.tick++;
    this.dropPower = this.engine.randDrop();
    this.pendingMoves.clear();

    // Determine player order (sorted by playerId for determinism)
    const order = [...this.players.keys()].sort();

    this.broadcast({
      type: 'tick_start',
      tick: this.tick,
      dropPower: this.dropPower,
      order
    });

    // Timeout: auto-skip after MOVE_WINDOW_MS
    this.moveTimeout = setTimeout(() => this.resolveTick(), this.MOVE_WINDOW_MS);
  }

  receiveMove(playerId, col) {
    if (this.state !== 'PLAYING') return;
    if (this.pendingMoves.has(playerId)) return; // already submitted
    if (col < 0 || col >= this.engine.COLS) return;

    this.pendingMoves.set(playerId, col);

    // Notify others that this player is ready (no reveal of col)
    this.broadcast({ type: 'move_locked', playerId, tick: this.tick });

    // If all players submitted, resolve immediately
    if (this.pendingMoves.size === this.players.size) {
      clearTimeout(this.moveTimeout);
      this.resolveTick();
    }
  }

  resolveTick() {
    // Deterministic order: sort by playerId
    const order = [...this.players.keys()].sort();
    const results = [];
    let winner = null;

    for (const pid of order) {
      const col = this.pendingMoves.has(pid)
        ? this.pendingMoves.get(pid)
        : Math.floor(this.engine.gameRng() * this.engine.COLS); // SKIP → random

      const rngPos = this.engine.rng.calls;
      const dropResult = this.engine.applyDrop(col, this.dropPower);

      // Record move
      this.uvs.moves.push({
        tick: this.tick,
        playerId: pid,
        col,
        dp: this.dropPower,
        rngPos,
        skip: !this.pendingMoves.has(pid)
      });

      results.push({
        playerId: pid,
        name: this.players.get(pid)?.name || pid,
        color: this.players.get(pid)?.color || '#888',
        col,
        dp: this.dropPower,
        path: dropResult.path,
        remaining: dropResult.remaining,
        skip: !this.pendingMoves.has(pid)
      });

      // Check channel after each drop
      if (this.engine.hasChannel()) {
        winner = pid;
        break;
      }
    }

    // Rotation (after all drops in the tick, if no winner)
    let rotated = false;
    if (!winner && this.config.rotate) {
      const rngPos = this.engine.rng.calls;
      this.engine.rotateGridCW();
      this.engine.fillRowIfChannel();
      this.uvs.moves.push({ type: 'rotate', tick: this.tick, rngPos });
      rotated = true;
    }

    // Broadcast tick result
    this.broadcast({
      type: 'tick_result',
      tick: this.tick,
      results,
      grid: this.engine.copyGrid(),
      rotated,
      winner: winner ? {
        playerId: winner,
        name: this.players.get(winner)?.name || winner,
        channel: this.engine.findChannelCells()
      } : null
    });

    if (winner) {
      this.endGame(winner);
    } else {
      // Next tick
      this.startTick();
    }
  }

  endGame(winnerId) {
    this.state = 'FINISHED';

    // UVS reveal
    this.broadcast({
      type: 'game_end',
      winner: {
        playerId: winnerId,
        name: this.players.get(winnerId)?.name || winnerId
      },
      uvs: {
        serverSeed: this.uvs.serverSeed,
        serverSeedHash: this.uvs.serverSeedHash,
        clientSeed: this.uvs.clientSeed,
        nonce: this.uvs.nonce,
        rngCalls: this.engine.rng.calls,
        moves: this.uvs.moves,
        verified: sha256(this.uvs.serverSeed) === this.uvs.serverSeedHash
      }
    });

    // Clean up after 60s
    setTimeout(() => {
      if (rooms.has(this.id) && this.state === 'FINISHED') {
        rooms.delete(this.id);
      }
    }, 60000);
  }
}

// --- Express + WebSocket ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/', (req, res) => {
  res.json({
    name: 'noisore-server',
    version: '1.0.0',
    protocol: 'UVS v2 Move Sync G=1',
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

app.get('/rooms', (req, res) => {
  const list = [];
  for (const [id, room] of rooms) {
    list.push({
      id, state: room.state,
      players: room.players.size,
      maxPlayers: room.config.maxPlayers || 6,
      config: room.config
    });
  }
  res.json(list);
});

// --- WebSocket Protocol ---
wss.on('connection', (ws) => {
  let playerId = 'p-' + randomHex(4);
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create_room': {
        const config = {
          gridSize: Math.min(Math.max(msg.gridSize || 6, 4), 10),
          rotate: msg.rotate !== false,
          maxPlayers: Math.min(Math.max(msg.maxPlayers || 4, 2), 6)
        };
        const roomId = generateRoomId();
        const room = new Room(roomId, config);
        rooms.set(roomId, room);
        currentRoom = room;
        playerId = msg.name || playerId;
        room.addPlayer(playerId, msg.name || 'Player', msg.color || '#f59e0b', ws);
        ws.send(JSON.stringify({ type: 'room_created', roomId, playerId }));
        break;
      }

      case 'join_room': {
        const room = rooms.get(msg.roomId);
        if (!room) { ws.send(JSON.stringify({ type: 'error', error: 'room_not_found' })); break; }
        playerId = msg.name || playerId;
        const result = room.addPlayer(playerId, msg.name || 'Player', msg.color || '#38bdf8', ws);
        if (result.error) { ws.send(JSON.stringify({ type: 'error', error: result.error })); break; }
        currentRoom = room;
        ws.send(JSON.stringify({ type: 'room_joined', roomId: msg.roomId, playerId }));
        break;
      }

      case 'start_game': {
        if (!currentRoom || playerId !== currentRoom.hostId) {
          ws.send(JSON.stringify({ type: 'error', error: 'not_host' }));
          break;
        }
        const result = currentRoom.startGame();
        if (result.error) ws.send(JSON.stringify({ type: 'error', error: result.error }));
        break;
      }

      case 'move': {
        if (!currentRoom) break;
        currentRoom.receiveMove(playerId, msg.col);
        break;
      }

      case 'list_rooms': {
        const list = [];
        for (const [id, r] of rooms) {
          if (r.state === 'LOBBY') {
            list.push({ id, players: r.players.size, config: r.config });
          }
        }
        ws.send(JSON.stringify({ type: 'room_list', rooms: list }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) currentRoom.removePlayer(playerId);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`NOISORE server on :${PORT}`));
