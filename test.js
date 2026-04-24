/**
 * NOISORE Server — Integration Test
 * Simulates 2 players: create room, join, start, play until channel
 */
const WebSocket = require('ws');
const http = require('http');

const PORT = 3002;
process.env.PORT = PORT;

// Start server
require('./server');

function send(ws, msg) { ws.send(JSON.stringify(msg)); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function test() {
  await wait(500); // let server start

  // Check HTTP
  const res = await new Promise((resolve, reject) => {
    http.get('http://localhost:' + PORT, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  console.log('HTTP:', res.name, res.version);

  // Player 1 — create room
  const p1 = new WebSocket('ws://localhost:' + PORT);
  const p1msgs = [];
  p1.on('message', d => p1msgs.push(JSON.parse(d)));
  await wait(200);

  send(p1, { type: 'create_room', name: 'Alice', color: '#f59e0b', gridSize: 6, rotate: true });
  await wait(200);
  
  const created = p1msgs.find(m => m.type === 'room_created');
  console.log('Room created:', created.roomId, 'player:', created.playerId);

  // Player 2 — join room
  const p2 = new WebSocket('ws://localhost:' + PORT);
  const p2msgs = [];
  p2.on('message', d => p2msgs.push(JSON.parse(d)));
  await wait(200);

  send(p2, { type: 'join_room', roomId: created.roomId, name: 'Bob', color: '#38bdf8' });
  await wait(200);

  const joined = p2msgs.find(m => m.type === 'room_joined');
  console.log('Bob joined:', joined.roomId);

  // Lobby state
  const lobby = p1msgs.filter(m => m.type === 'lobby');
  console.log('Lobby players:', lobby[lobby.length-1].players.length);

  // Start game
  send(p1, { type: 'start_game' });
  await wait(300);

  const gameStart1 = p1msgs.find(m => m.type === 'game_start');
  const gameStart2 = p2msgs.find(m => m.type === 'game_start');
  console.log('Game started:', !!gameStart1, 'grid:', gameStart1.grid.length + 'x' + gameStart1.grid[0].length);
  console.log('Seed hash:', gameStart1.serverSeedHash.substring(0, 16) + '...');
  console.log('Same grid for both?', JSON.stringify(gameStart1.grid) === JSON.stringify(gameStart2.grid));

  // Play moves — both pick column 2
  let rounds = 0;
  let winner = null;

  while (rounds < 100 && !winner) {
    const tick1 = p1msgs.find(m => m.type === 'tick_start' && m.tick === rounds + 1);
    if (!tick1) { await wait(500); continue; }

    // Both players pick lightest column (simple strategy)
    send(p1, { type: 'move', col: rounds % 6 });
    send(p2, { type: 'move', col: (rounds + 3) % 6 });
    await wait(300);

    const result = p1msgs.find(m => m.type === 'tick_result' && m.tick === rounds + 1);
    if (result && result.winner) {
      winner = result.winner;
    }
    rounds++;
  }

  if (winner) {
    console.log('Winner after', rounds, 'rounds:', winner.name);
  } else {
    console.log('No winner after', rounds, 'rounds');
  }

  // Check game_end with UVS reveal
  const gameEnd = p1msgs.find(m => m.type === 'game_end');
  if (gameEnd) {
    console.log('UVS verified:', gameEnd.uvs.verified);
    console.log('RNG calls:', gameEnd.uvs.rngCalls);
    console.log('Total moves:', gameEnd.uvs.moves.length);
    console.log('Server seed:', gameEnd.uvs.serverSeed.substring(0, 16) + '...');
  }

  p1.close();
  p2.close();
  
  console.log('\n✓ Test complete');
  process.exit(0);
}

test().catch(e => { console.error(e); process.exit(1); });
