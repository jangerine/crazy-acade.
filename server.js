// ============================================================
//  KEUA ONLINE - 서버 (Express + Socket.io)
//  크레이지아케이드 스타일 실시간 멀티플레이어 물풍선 게임
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// -------------------- 게임 상수 --------------------
const TILE = 40;
const COLS = 15;
const ROWS = 11;
const PLAYER_RADIUS = 14;
const BASE_SPEED = 130;        // px/sec
const SPEED_STEP = 22;         // 아이템당 증가량
const BUBBLE_TIMER = 3000;     // 물풍선 터지는 시간(ms)
const TRAP_TIMEOUT = 9000;     // 붙잡힌 상태 자동 아웃 시간(ms)
const TICK_MS = 1000 / 30;
const MAX_PLAYERS = 4;
const ITEM_DROP_CHANCE = 0.35;

const PLAYER_COLORS = ['#ff5c5c', '#5c9cff', '#5cff8a', '#ffe45c'];
const PLAYER_NAMES_EMOJI = ['🙂', '😎', '🐣', '🐸'];

const rooms = {}; // roomId -> roomState

// -------------------- 유틸 --------------------
function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[id]);
  return id;
}

function tileCenter(col, row) {
  return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 };
}

function posToCell(x, y) {
  return { col: Math.floor(x / TILE), row: Math.floor(y / TILE) };
}

// 맵 생성: 0=빈칸, 1=파괴불가벽, 2=파괴가능벽
function createMap() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
        row.push(1);
      } else if (r % 2 === 0 && c % 2 === 0) {
        row.push(1);
      } else {
        row.push(0);
      }
    }
    grid.push(row);
  }
  // 스폰 코너 주변은 비워두고, 나머지에 파괴가능 벽 배치
  const spawnClear = [
    [1, 1], [2, 1], [1, 2],
    [COLS - 2, 1], [COLS - 3, 1], [COLS - 2, 2],
    [1, ROWS - 2], [2, ROWS - 2], [1, ROWS - 3],
    [COLS - 2, ROWS - 2], [COLS - 3, ROWS - 2], [COLS - 2, ROWS - 3]
  ];
  const clearSet = new Set(spawnClear.map(([c, r]) => `${c},${r}`));

  // 실제 크아 맵처럼 점대칭(180도 회전 대칭) 구조로 생성 -> 어느 스폰에서 시작해도 공평한 맵이 됨
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (grid[r][c] === 1) continue;

      const mirrorR = ROWS - 1 - r;
      const mirrorC = COLS - 1 - c;
      const idx = r * COLS + c;
      const mirrorIdx = mirrorR * COLS + mirrorC;
      if (idx > mirrorIdx) continue; // 짝이 이미 처리됨 -> 스킵 (대칭으로 채워짐)

      if (clearSet.has(`${c},${r}`) || clearSet.has(`${mirrorC},${mirrorR}`)) continue;
      if (grid[mirrorR][mirrorC] === 1) continue; // 대칭 위치가 기둥이면 짝이 안 맞으니 스킵

      if (Math.random() < 0.55) {
        grid[r][c] = 2;
        grid[mirrorR][mirrorC] = 2;
      }
    }
  }
  return grid;
}

function createRoom(hostSocketId, hostName) {
  const roomId = genRoomId();
  const spawns = [
    tileCenter(1, 1),
    tileCenter(COLS - 2, 1),
    tileCenter(1, ROWS - 2),
    tileCenter(COLS - 2, ROWS - 2)
  ];
  rooms[roomId] = {
    id: roomId,
    hostId: hostSocketId,
    state: 'lobby', // lobby | playing | ended
    grid: createMap(),
    items: {},      // "col,row" -> itemType
    bubbles: [],     // {id, col, row, ownerId, range, placedAt, active}
    players: {},     // socketId -> player
    spawns,
    loop: null,
    winnerId: null
  };
  addPlayer(roomId, hostSocketId, hostName, true);
  return roomId;
}

function addPlayer(roomId, socketId, name, isHost) {
  const room = rooms[roomId];
  const slot = Object.keys(room.players).length;
  const spawn = room.spawns[slot % room.spawns.length];
  room.players[socketId] = {
    id: socketId,
    name: name && name.trim() ? name.trim().slice(0, 12) : `플레이어${slot + 1}`,
    color: PLAYER_COLORS[slot % PLAYER_COLORS.length],
    emoji: PLAYER_NAMES_EMOJI[slot % PLAYER_NAMES_EMOJI.length],
    x: spawn.x,
    y: spawn.y,
    speed: BASE_SPEED,
    maxBubbles: 2,
    bubbleRange: 2,
    input: { up: false, down: false, left: false, right: false },
    state: 'alive', // alive | trapped | eliminated
    trappedAt: 0,
    isHost,
    ready: isHost,
    score: 0,
    onOwnBubble: null
  };
}

function publicRoomState(room) {
  return {
    id: room.id,
    state: room.state,
    hostId: room.hostId,
    grid: room.grid,
    items: room.items,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color, emoji: p.emoji,
      ready: p.ready, isHost: p.isHost
    }))
  };
}

function gameSnapshot(room) {
  return {
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color, emoji: p.emoji,
      x: p.x, y: p.y, state: p.state, ready: p.ready
    })),
    bubbles: room.bubbles.map(b => ({
      id: b.id, col: b.col, row: b.row, placedAt: b.placedAt
    })),
    grid: room.grid,
    items: room.items
  };
}

// -------------------- 충돌 체크 --------------------
function isSolid(room, col, row, ignoreBubbleId) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
  const cell = room.grid[row][col];
  if (cell === 1 || cell === 2) return true;
  const bubble = room.bubbles.find(b => b.col === col && b.row === row && b.id !== ignoreBubbleId);
  if (bubble && bubble.solidFor !== 'none') return true;
  return false;
}

function tryMove(room, player, dx, dy) {
  if (dx === 0 && dy === 0) return;
  const r = PLAYER_RADIUS;

  // X축 이동
  if (dx !== 0) {
    const newX = player.x + dx;
    const checkY1 = player.y - r + 2;
    const checkY2 = player.y + r - 2;
    const edgeX = dx > 0 ? newX + r : newX - r;
    const { col: c1 } = posToCell(edgeX, checkY1);
    const { col: c2 } = posToCell(edgeX, checkY2);
    const { row: rr1 } = posToCell(edgeX, checkY1);
    const { row: rr2 } = posToCell(edgeX, checkY2);
    const blocked = blockedForPlayer(room, player, c1, rr1) || blockedForPlayer(room, player, c2, rr2);
    if (!blocked) player.x = newX;
  }
  // Y축 이동
  if (dy !== 0) {
    const newY = player.y + dy;
    const checkX1 = player.x - r + 2;
    const checkX2 = player.x + r - 2;
    const edgeY = dy > 0 ? newY + r : newY - r;
    const { col: c1, row: r1 } = posToCell(checkX1, edgeY);
    const { col: c2, row: r2 } = posToCell(checkX2, edgeY);
    const blocked = blockedForPlayer(room, player, c1, r1) || blockedForPlayer(room, player, c2, r2);
    if (!blocked) player.y = newY;
  }
}

function blockedForPlayer(room, player, col, row) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
  const cell = room.grid[row][col];
  if (cell === 1 || cell === 2) return true;
  const bubble = room.bubbles.find(b => b.col === col && b.row === row);
  if (bubble) {
    // 방금 자기가 놓은 물풍선 위에 서있는 동안은 통과 가능
    if (player.onOwnBubble === bubble.id) return false;
    return true;
  }
  return false;
}

// -------------------- 아이템 --------------------
const ITEM_TYPES = ['bubble', 'range', 'speed'];
function maybeDropItem(room, col, row) {
  if (Math.random() < ITEM_DROP_CHANCE) {
    const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
    room.items[`${col},${row}`] = type;
  }
}

function checkItemPickup(room, player) {
  const { col, row } = posToCell(player.x, player.y);
  const key = `${col},${row}`;
  const item = room.items[key];
  if (!item) return;
  delete room.items[key];
  if (item === 'bubble') player.maxBubbles = Math.min(player.maxBubbles + 1, 8);
  if (item === 'range') player.bubbleRange = Math.min(player.bubbleRange + 1, 8);
  if (item === 'speed') player.speed = Math.min(player.speed + SPEED_STEP, BASE_SPEED + SPEED_STEP * 5);
}

// -------------------- 물풍선 --------------------
let bubbleIdCounter = 1;

function placeBubble(room, player) {
  if (player.state !== 'alive') return;
  const activeCount = room.bubbles.filter(b => b.ownerId === player.id).length;
  if (activeCount >= player.maxBubbles) return;
  const { col, row } = posToCell(player.x, player.y);
  if (room.bubbles.some(b => b.col === col && b.row === row)) return;
  if (room.grid[row][col] !== 0) return;

  const bubble = {
    id: bubbleIdCounter++,
    col, row,
    ownerId: player.id,
    range: player.bubbleRange,
    placedAt: Date.now(),
    solidFor: 'all'
  };
  room.bubbles.push(bubble);
  player.onOwnBubble = bubble.id;
}

function popBubble(room, bubble, popped = new Set(), burstsOut = []) {
  if (popped.has(bubble.id)) return [];
  popped.add(bubble.id);
  room.bubbles = room.bubbles.filter(b => b.id !== bubble.id);

  const affectedCells = [{ col: bubble.col, row: bubble.row }];
  const arms = { up: 0, down: 0, left: 0, right: 0 };
  const dirs = [['right', 1, 0], ['left', -1, 0], ['down', 0, 1], ['up', 0, -1]];

  for (const [name, dx, dy] of dirs) {
    for (let step = 1; step <= bubble.range; step++) {
      const c = bubble.col + dx * step;
      const r = bubble.row + dy * step;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      const cell = room.grid[r][c];
      if (cell === 1) break; // 파괴불가 벽에서 정지
      affectedCells.push({ col: c, row: r });
      arms[name] = step; // 이 방향으로 실제 물이 도달한 거리 (연출용)
      if (cell === 2) {
        room.grid[r][c] = 0;
        maybeDropItem(room, c, r);
        break; // 파괴가능 벽은 부수고 정지
      }
      // 경로에 다른 물풍선 있으면 연쇄 폭발
      const chainBubble = room.bubbles.find(b => b.col === c && b.row === r);
      if (chainBubble) {
        const chainCells = popBubble(room, chainBubble, popped, burstsOut);
        affectedCells.push(...chainCells);
      }
    }
  }

  burstsOut.push({
    col: bubble.col, row: bubble.row,
    up: arms.up, down: arms.down, left: arms.left, right: arms.right
  });

  // 플레이어 판정
  for (const pid in room.players) {
    const p = room.players[pid];
    const { col: pc, row: pr } = posToCell(p.x, p.y);
    const hit = affectedCells.some(cell => cell.col === pc && cell.row === pr);
    if (!hit) continue;
    if (p.state === 'alive') {
      p.state = 'trapped';
      p.trappedAt = Date.now();
    } else if (p.state === 'trapped') {
      p.state = 'eliminated';
    }
  }

  return affectedCells;
}

// -------------------- 자유(구출) / 탈락 처리 --------------------
function checkFreeing(room) {
  const alive = Object.values(room.players).filter(p => p.state === 'alive');
  const trapped = Object.values(room.players).filter(p => p.state === 'trapped');
  for (const t of trapped) {
    if (Date.now() - t.trappedAt > TRAP_TIMEOUT) {
      t.state = 'eliminated';
      continue;
    }
    const { col: tc, row: tr } = posToCell(t.x, t.y);
    for (const a of alive) {
      const { col: ac, row: ar } = posToCell(a.x, a.y);
      if (ac === tc && ar === tr) {
        t.state = 'alive';
        t.trappedAt = 0;
        break;
      }
    }
  }
}

function checkWinCondition(room) {
  const remaining = Object.values(room.players).filter(p => p.state !== 'eliminated');
  const totalPlayers = Object.keys(room.players).length;
  if (totalPlayers >= 2 && remaining.length <= 1) {
    room.state = 'ended';
    room.winnerId = remaining[0] ? remaining[0].id : null;
    return true;
  }
  return false;
}

// -------------------- 게임 루프 --------------------
function startGameLoop(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.state = 'playing';
  room.grid = createMap();
  room.items = {};
  room.bubbles = [];
  room.winnerId = null;

  const ids = Object.keys(room.players);
  ids.forEach((id, idx) => {
    const p = room.players[id];
    const spawn = room.spawns[idx % room.spawns.length];
    p.x = spawn.x;
    p.y = spawn.y;
    p.state = 'alive';
    p.maxBubbles = 2;
    p.bubbleRange = 2;
    p.speed = BASE_SPEED;
    p.onOwnBubble = null;
  });

  io.to(roomId).emit('gameStarted', gameSnapshot(room));

  room.loop = setInterval(() => {
    const dt = TICK_MS / 1000;
    for (const id in room.players) {
      const p = room.players[id];
      if (p.state === 'eliminated') continue;
      let dx = 0, dy = 0;
      if (p.input.left) dx -= 1;
      if (p.input.right) dx += 1;
      if (p.input.up) dy -= 1;
      if (p.input.down) dy += 1;
      if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }

      // 자기 물풍선 위에서 벗어났는지 체크
      if (p.onOwnBubble !== null) {
        const { col, row } = posToCell(p.x, p.y);
        const b = room.bubbles.find(bb => bb.id === p.onOwnBubble);
        if (!b || b.col !== col || b.row !== row) p.onOwnBubble = null;
      }

      if (p.state === 'alive') {
        tryMove(room, p, dx * p.speed * dt, dy * p.speed * dt);
        checkItemPickup(room, p);
      }
    }

    // 물풍선 타이머 체크
    const now = Date.now();
    const toPop = room.bubbles.filter(b => now - b.placedAt >= BUBBLE_TIMER);
    const alreadyPopped = new Set();
    const burstsOut = [];
    for (const b of toPop) {
      if (alreadyPopped.has(b.id)) continue;
      popBubble(room, b, alreadyPopped, burstsOut);
    }

    checkFreeing(room);
    const ended = checkWinCondition(room);

    io.to(roomId).emit('gameState', gameSnapshot(room));

    if (burstsOut.length > 0) {
      io.to(roomId).emit('explosion', { bursts: burstsOut });
    }

    if (ended) {
      clearInterval(room.loop);
      room.loop = null;
      const winner = room.winnerId ? room.players[room.winnerId] : null;
      io.to(roomId).emit('gameEnded', {
        winnerId: room.winnerId,
        winnerName: winner ? winner.name : null
      });
    }
  }, TICK_MS);
}

function resetRoomToLobby(room) {
  room.state = 'lobby';
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  for (const id in room.players) {
    room.players[id].ready = room.players[id].isHost;
  }
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    const roomId = createRoom(socket.id, name);
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, you: socket.id });
    io.to(roomId).emit('roomUpdate', publicRoomState(rooms[roomId]));
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    roomId = (roomId || '').toUpperCase().trim();
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', '존재하지 않는 방 코드입니다.');
    if (room.state === 'playing') return socket.emit('errorMsg', '이미 게임이 진행 중인 방입니다.');
    if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('errorMsg', '방이 가득 찼습니다.');

    addPlayer(roomId, socket.id, name, false);
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, you: socket.id });
    io.to(roomId).emit('roomUpdate', publicRoomState(room));
  });

  socket.on('toggleReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    if (room.players[socket.id].isHost) return; // 호스트는 항상 준비 상태
    room.players[socket.id].ready = !room.players[socket.id].ready;
    io.to(roomId).emit('roomUpdate', publicRoomState(room));
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.id) return;
    const players = Object.values(room.players);
    if (players.length < 2) return socket.emit('errorMsg', '최소 2명이 필요합니다.');
    if (!players.every(p => p.ready)) return socket.emit('errorMsg', '모든 플레이어가 준비되어야 합니다.');
    startGameLoop(roomId);
  });

  socket.on('playAgain', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    resetRoomToLobby(room);
    io.to(roomId).emit('roomUpdate', publicRoomState(room));
    io.to(roomId).emit('backToLobby');
  });

  socket.on('input', ({ roomId, input }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].input = {
      up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right
    };
  });

  socket.on('placeBubble', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const player = room.players[socket.id];
    if (!player) return;
    placeBubble(room, player);
  });

  socket.on('chat', ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    const name = room.players[socket.id].name;
    const clean = String(text || '').slice(0, 120);
    if (!clean.trim()) return;
    io.to(roomId).emit('chat', { name, text: clean });
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room.players[socket.id]) continue;
      const wasHost = room.hostId === socket.id;
      delete room.players[socket.id];

      if (Object.keys(room.players).length === 0) {
        if (room.loop) clearInterval(room.loop);
        delete rooms[roomId];
        continue;
      }
      if (wasHost) {
        const newHostId = Object.keys(room.players)[0];
        room.hostId = newHostId;
        room.players[newHostId].isHost = true;
        room.players[newHostId].ready = true;
      }
      if (room.state === 'playing') {
        checkWinCondition(room);
      }
      io.to(roomId).emit('roomUpdate', publicRoomState(room));
      io.to(roomId).emit('gameState', gameSnapshot(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`KEUA ONLINE 서버 실행 중: http://localhost:${PORT}`);
});// ============================================================
//  KEUA ONLINE - 서버 (Express + Socket.io)
//  크레이지아케이드 스타일 실시간 멀티플레이어 물풍선 게임
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// -------------------- 게임 상수 --------------------
const TILE = 40;
const COLS = 15;
const ROWS = 11;
const PLAYER_RADIUS = 14;
const BASE_SPEED = 130;        // px/sec
const SPEED_STEP = 22;         // 아이템당 증가량
const BUBBLE_TIMER = 3000;     // 물풍선 터지는 시간(ms)
const TRAP_TIMEOUT = 9000;     // 붙잡힌 상태 자동 아웃 시간(ms)
const TICK_MS = 1000 / 30;
const MAX_PLAYERS = 4;
const ITEM_DROP_CHANCE = 0.35;

const PLAYER_COLORS = ['#ff5c5c', '#5c9cff', '#5cff8a', '#ffe45c'];
const PLAYER_NAMES_EMOJI = ['🙂', '😎', '🐣', '🐸'];

const rooms = {}; // roomId -> roomState

// -------------------- 유틸 --------------------
function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[id]);
  return id;
}

function tileCenter(col, row) {
  return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 };
}

function posToCell(x, y) {
  return { col: Math.floor(x / TILE), row: Math.floor(y / TILE) };
}

// 맵 생성: 0=빈칸, 1=파괴불가벽, 2=파괴가능벽
function createMap() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
        row.push(1);
      } else if (r % 2 === 0 && c % 2 === 0) {
        row.push(1);
      } else {
        row.push(0);
      }
    }
    grid.push(row);
  }
  // 스폰 코너 주변은 비워두고, 나머지에 파괴가능 벽 배치
  const spawnClear = [
    [1, 1], [2, 1], [1, 2],
    [COLS - 2, 1], [COLS - 3, 1], [COLS - 2, 2],
    [1, ROWS - 2], [2, ROWS - 2], [1, ROWS - 3],
    [COLS - 2, ROWS - 2], [COLS - 3, ROWS - 2], [COLS - 2, ROWS - 3]
  ];
  const clearSet = new Set(spawnClear.map(([c, r]) => `${c},${r}`));

  // 실제 크아 맵처럼 점대칭(180도 회전 대칭) 구조로 생성 -> 어느 스폰에서 시작해도 공평한 맵이 됨
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (grid[r][c] === 1) continue;

      const mirrorR = ROWS - 1 - r;
      const mirrorC = COLS - 1 - c;
      const idx = r * COLS + c;
      const mirrorIdx = mirrorR * COLS + mirrorC;
      if (idx > mirrorIdx) continue; // 짝이 이미 처리됨 -> 스킵 (대칭으로 채워짐)

      if (clearSet.has(`${c},${r}`) || clearSet.has(`${mirrorC},${mirrorR}`)) continue;
      if (grid[mirrorR][mirrorC] === 1) continue; // 대칭 위치가 기둥이면 짝이 안 맞으니 스킵

      if (Math.random() < 0.55) {
        grid[r][c] = 2;
        grid[mirrorR][mirrorC] = 2;
      }
    }
  }
  return grid;
}

function createRoom(hostSocketId, hostName) {
  const roomId = genRoomId();
  const spawns = [
    tileCenter(1, 1),
    tileCenter(COLS - 2, 1),
    tileCenter(1, ROWS - 2),
    tileCenter(COLS - 2, ROWS - 2)
  ];
  rooms[roomId] = {
    id: roomId,
    hostId: hostSocketId,
    state: 'lobby', // lobby | playing | ended
    grid: createMap(),
    items: {},      // "col,row" -> itemType
    bubbles: [],     // {id, col, row, ownerId, range, placedAt, active}
    players: {},     // socketId -> player
    spawns,
    loop: null,
    winnerId: null
  };
  addPlayer(roomId, hostSocketId, hostName, true);
  return roomId;
}

function addPlayer(roomId, socketId, name, isHost) {
  const room = rooms[roomId];
  const slot = Object.keys(room.players).length;
  const spawn = room.spawns[slot % room.spawns.length];
  room.players[socketId] = {
    id: socketId,
    name: name && name.trim() ? name.trim().slice(0, 12) : `플레이어${slot + 1}`,
    color: PLAYER_COLORS[slot % PLAYER_COLORS.length],
    emoji: PLAYER_NAMES_EMOJI[slot % PLAYER_NAMES_EMOJI.length],
    x: spawn.x,
    y: spawn.y,
    speed: BASE_SPEED,
    maxBubbles: 2,
    bubbleRange: 2,
    input: { up: false, down: false, left: false, right: false },
    state: 'alive', // alive | trapped | eliminated
    trappedAt: 0,
    isHost,
    ready: isHost,
    score: 0,
    onOwnBubble: null
  };
}

function publicRoomState(room) {
  return {
    id: room.id,
    state: room.state,
    hostId: room.hostId,
    grid: room.grid,
    items: room.items,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color, emoji: p.emoji,
      ready: p.ready, isHost: p.isHost
    }))
  };
}

function gameSnapshot(room) {
  return {
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color, emoji: p.emoji,
      x: p.x, y: p.y, state: p.state, ready: p.ready
    })),
    bubbles: room.bubbles.map(b => ({
      id: b.id, col: b.col, row: b.row, placedAt: b.placedAt
    })),
    grid: room.grid,
    items: room.items
  };
}

// -------------------- 충돌 체크 --------------------
function isSolid(room, col, row, ignoreBubbleId) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
  const cell = room.grid[row][col];
  if (cell === 1 || cell === 2) return true;
  const bubble = room.bubbles.find(b => b.col === col && b.row === row && b.id !== ignoreBubbleId);
  if (bubble && bubble.solidFor !== 'none') return true;
  return false;
}

function tryMove(room, player, dx, dy) {
  if (dx === 0 && dy === 0) return;
  const r = PLAYER_RADIUS;

  // X축 이동
  if (dx !== 0) {
    const newX = player.x + dx;
    const checkY1 = player.y - r + 2;
    const checkY2 = player.y + r - 2;
    const edgeX = dx > 0 ? newX + r : newX - r;
    const { col: c1 } = posToCell(edgeX, checkY1);
    const { col: c2 } = posToCell(edgeX, checkY2);
    const { row: rr1 } = posToCell(edgeX, checkY1);
    const { row: rr2 } = posToCell(edgeX, checkY2);
    const blocked = blockedForPlayer(room, player, c1, rr1) || blockedForPlayer(room, player, c2, rr2);
    if (!blocked) player.x = newX;
  }
  // Y축 이동
  if (dy !== 0) {
    const newY = player.y + dy;
    const checkX1 = player.x - r + 2;
    const checkX2 = player.x + r - 2;
    const edgeY = dy > 0 ? newY + r : newY - r;
    const { col: c1, row: r1 } = posToCell(checkX1, edgeY);
    const { col: c2, row: r2 } = posToCell(checkX2, edgeY);
    const blocked = blockedForPlayer(room, player, c1, r1) || blockedForPlayer(room, player, c2, r2);
    if (!blocked) player.y = newY;
  }
}

function blockedForPlayer(room, player, col, row) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
  const cell = room.grid[row][col];
  if (cell === 1 || cell === 2) return true;
  const bubble = room.bubbles.find(b => b.col === col && b.row === row);
  if (bubble) {
    // 방금 자기가 놓은 물풍선 위에 서있는 동안은 통과 가능
    if (player.onOwnBubble === bubble.id) return false;
    return true;
  }
  return false;
}

// -------------------- 아이템 --------------------
const ITEM_TYPES = ['bubble', 'range', 'speed'];
function maybeDropItem(room, col, row) {
  if (Math.random() < ITEM_DROP_CHANCE) {
    const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
    room.items[`${col},${row}`] = type;
  }
}

function checkItemPickup(room, player) {
  const { col, row } = posToCell(player.x, player.y);
  const key = `${col},${row}`;
  const item = room.items[key];
  if (!item) return;
  delete room.items[key];
  if (item === 'bubble') player.maxBubbles = Math.min(player.maxBubbles + 1, 8);
  if (item === 'range') player.bubbleRange = Math.min(player.bubbleRange + 1, 8);
  if (item === 'speed') player.speed = Math.min(player.speed + SPEED_STEP, BASE_SPEED + SPEED_STEP * 5);
}

// -------------------- 물풍선 --------------------
let bubbleIdCounter = 1;

function placeBubble(room, player) {
  if (player.state !== 'alive') return;
  const activeCount = room.bubbles.filter(b => b.ownerId === player.id).length;
  if (activeCount >= player.maxBubbles) return;
  const { col, row } = posToCell(player.x, player.y);
  if (room.bubbles.some(b => b.col === col && b.row === row)) return;
  if (room.grid[row][col] !== 0) return;

  const bubble = {
    id: bubbleIdCounter++,
    col, row,
    ownerId: player.id,
    range: player.bubbleRange,
    placedAt: Date.now(),
    solidFor: 'all'
  };
  room.bubbles.push(bubble);
  player.onOwnBubble = bubble.id;
}

function popBubble(room, bubble, popped = new Set(), burstsOut = []) {
  if (popped.has(bubble.id)) return [];
  popped.add(bubble.id);
  room.bubbles = room.bubbles.filter(b => b.id !== bubble.id);

  const affectedCells = [{ col: bubble.col, row: bubble.row }];
  const arms = { up: 0, down: 0, left: 0, right: 0 };
  const dirs = [['right', 1, 0], ['left', -1, 0], ['down', 0, 1], ['up', 0, -1]];

  for (const [name, dx, dy] of dirs) {
    for (let step = 1; step <= bubble.range; step++) {
      const c = bubble.col + dx * step;
      const r = bubble.row + dy * step;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      const cell = room.grid[r][c];
      if (cell === 1) break; // 파괴불가 벽에서 정지
      affectedCells.push({ col: c, row: r });
      arms[name] = step; // 이 방향으로 실제 물이 도달한 거리 (연출용)
      if (cell === 2) {
        room.grid[r][c] = 0;
        maybeDropItem(room, c, r);
        break; // 파괴가능 벽은 부수고 정지
      }
      // 경로에 다른 물풍선 있으면 연쇄 폭발
      const chainBubble = room.bubbles.find(b => b.col === c && b.row === r);
      if (chainBubble) {
        const chainCells = popBubble(room, chainBubble, popped, burstsOut);
        affectedCells.push(...chainCells);
      }
    }
  }

  burstsOut.push({
    col: bubble.col, row: bubble.row,
    up: arms.up, down: arms.down, left: arms.left, right: arms.right
  });

  // 플레이어 판정
  for (const pid in room.players) {
    const p = room.players[pid];
    const { col: pc, row: pr } = posToCell(p.x, p.y);
    const hit = affectedCells.some(cell => cell.col === pc && cell.row === pr);
    if (!hit) continue;
    if (p.state === 'alive') {
      p.state = 'trapped';
      p.trappedAt = Date.now();
    } else if (p.state === 'trapped') {
      p.state = 'eliminated';
    }
  }

  return affectedCells;
}

// -------------------- 자유(구출) / 탈락 처리 --------------------
function checkFreeing(room) {
  const alive = Object.values(room.players).filter(p => p.state === 'alive');
  const trapped = Object.values(room.players).filter(p => p.state === 'trapped');
  for (const t of trapped) {
    if (Date.now() - t.trappedAt > TRAP_TIMEOUT) {
      t.state = 'eliminated';
      continue;
    }
    const { col: tc, row: tr } = posToCell(t.x, t.y);
    for (const a of alive) {
      const { col: ac, row: ar } = posToCell(a.x, a.y);
      if (ac === tc && ar === tr) {
        t.state = 'alive';
        t.trappedAt = 0;
        break;
      }
    }
  }
}

function checkWinCondition(room) {
  const remaining = Object.values(room.players).filter(p => p.state !== 'eliminated');
  const totalPlayers = Object.keys(room.players).length;
  if (totalPlayers >= 2 && remaining.length <= 1) {
    room.state = 'ended';
    room.winnerId = remaining[0] ? remaining[0].id : null;
    return true;
  }
  return false;
}

// -------------------- 게임 루프 --------------------
function startGameLoop(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.state = 'playing';
  room.grid = createMap();
  room.items = {};
  room.bubbles = [];
  room.winnerId = null;

  const ids = Object.keys(room.players);
  ids.forEach((id, idx) => {
    const p = room.players[id];
    const spawn = room.spawns[idx % room.spawns.length];
    p.x = spawn.x;
    p.y = spawn.y;
    p.state = 'alive';
    p.maxBubbles = 2;
    p.bubbleRange = 2;
    p.speed = BASE_SPEED;
    p.onOwnBubble = null;
  });

  io.to(roomId).emit('gameStarted', gameSnapshot(room));

  room.loop = setInterval(() => {
    const dt = TICK_MS / 1000;
    for (const id in room.players) {
      const p = room.players[id];
      if (p.state === 'eliminated') continue;
      let dx = 0, dy = 0;
      if (p.input.left) dx -= 1;
      if (p.input.right) dx += 1;
      if (p.input.up) dy -= 1;
      if (p.input.down) dy += 1;
      if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }

      // 자기 물풍선 위에서 벗어났는지 체크
      if (p.onOwnBubble !== null) {
        const { col, row } = posToCell(p.x, p.y);
        const b = room.bubbles.find(bb => bb.id === p.onOwnBubble);
        if (!b || b.col !== col || b.row !== row) p.onOwnBubble = null;
      }

      if (p.state === 'alive') {
        tryMove(room, p, dx * p.speed * dt, dy * p.speed * dt);
        checkItemPickup(room, p);
      }
    }

    // 물풍선 타이머 체크
    const now = Date.now();
    const toPop = room.bubbles.filter(b => now - b.placedAt >= BUBBLE_TIMER);
    const alreadyPopped = new Set();
    const burstsOut = [];
    for (const b of toPop) {
      if (alreadyPopped.has(b.id)) continue;
      popBubble(room, b, alreadyPopped, burstsOut);
    }

    checkFreeing(room);
    const ended = checkWinCondition(room);

    io.to(roomId).emit('gameState', gameSnapshot(room));

    if (burstsOut.length > 0) {
      io.to(roomId).emit('explosion', { bursts: burstsOut });
    }

    if (ended) {
      clearInterval(room.loop);
      room.loop = null;
      const winner = room.winnerId ? room.players[room.winnerId] : null;
      io.to(roomId).emit('gameEnded', {
        winnerId: room.winnerId,
        winnerName: winner ? winner.name : null
      });
    }
  }, TICK_MS);
}

function resetRoomToLobby(room) {
  room.state = 'lobby';
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  for (const id in room.players) {
    room.players[id].ready = room.players[id].isHost;
  }
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    const roomId = createRoom(socket.id, name);
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, you: socket.id });
    io.to(roomId).emit('roomUpdate', publicRoomState(rooms[roomId]));
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    roomId = (roomId || '').toUpperCase().trim();
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', '존재하지 않는 방 코드입니다.');
    if (room.state === 'playing') return socket.emit('errorMsg', '이미 게임이 진행 중인 방입니다.');
    if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('errorMsg', '방이 가득 찼습니다.');

    addPlayer(roomId, socket.id, name, false);
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, you: socket.id });
    io.to(roomId).emit('roomUpdate', publicRoomState(room));
  });

  socket.on('toggleReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    if (room.players[socket.id].isHost) return; // 호스트는 항상 준비 상태
    room.players[socket.id].ready = !room.players[socket.id].ready;
    io.to(roomId).emit('roomUpdate', publicRoomState(room));
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.id) return;
    const players = Object.values(room.players);
    if (players.length < 2) return socket.emit('errorMsg', '최소 2명이 필요합니다.');
    if (!players.every(p => p.ready)) return socket.emit('errorMsg', '모든 플레이어가 준비되어야 합니다.');
    startGameLoop(roomId);
  });

  socket.on('playAgain', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    resetRoomToLobby(room);
    io.to(roomId).emit('roomUpdate', publicRoomState(room));
    io.to(roomId).emit('backToLobby');
  });

  socket.on('input', ({ roomId, input }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].input = {
      up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right
    };
  });

  socket.on('placeBubble', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const player = room.players[socket.id];
    if (!player) return;
    placeBubble(room, player);
  });

  socket.on('chat', ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    const name = room.players[socket.id].name;
    const clean = String(text || '').slice(0, 120);
    if (!clean.trim()) return;
    io.to(roomId).emit('chat', { name, text: clean });
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room.players[socket.id]) continue;
      const wasHost = room.hostId === socket.id;
      delete room.players[socket.id];

      if (Object.keys(room.players).length === 0) {
        if (room.loop) clearInterval(room.loop);
        delete rooms[roomId];
        continue;
      }
      if (wasHost) {
        const newHostId = Object.keys(room.players)[0];
        room.hostId = newHostId;
        room.players[newHostId].isHost = true;
        room.players[newHostId].ready = true;
      }
      if (room.state === 'playing') {
        checkWinCondition(room);
      }
      io.to(roomId).emit('roomUpdate', publicRoomState(room));
      io.to(roomId).emit('gameState', gameSnapshot(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`KEUA ONLINE 서버 실행 중: http://localhost:${PORT}`);
});// ============================================================
//  KEUA ONLINE - 서버 (Express + Socket.io)
//  크레이지아케이드 스타일 실시간 멀티플레이어 물풍선 게임
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// -------------------- 게임 상수 --------------------
const TILE = 40;
const COLS = 15;
const ROWS = 11;
const PLAYER_RADIUS = 14;
const BASE_SPEED = 130;        // px/sec
const SPEED_STEP = 22;         // 아이템당 증가량
const BUBBLE_TIMER = 3000;     // 물풍선 터지는 시간(ms)
const TRAP_TIMEOUT = 9000;     // 붙잡힌 상태 자동 아웃 시간(ms)
const TICK_MS = 1000 / 30;
const MAX_PLAYERS = 4;
const ITEM_DROP_CHANCE = 0.35;

const PLAYER_COLORS = ['#ff5c5c', '#5c9cff', '#5cff8a', '#ffe45c'];
const PLAYER_NAMES_EMOJI = ['🙂', '😎', '🐣', '🐸'];

const rooms = {}; // roomId -> roomState

// -------------------- 유틸 --------------------
function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[id]);
  return id;
}

function tileCenter(col, row) {
  return { x: col * TILE + TILE / 2, y: row * TILE + TILE / 2 };
}

function posToCell(x, y) {
  return { col: Math.floor(x / TILE), row: Math.floor(y / TILE) };
}

// 맵 생성: 0=빈칸, 1=파괴불가벽, 2=파괴가능벽
function createMap() {
  const grid = [];
  for (let r = 0; r < ROWS; r++) {
    const row = [];
    for (let c = 0; c < COLS; c++) {
      if (r === 0 || r === ROWS - 1 || c === 0 || c === COLS - 1) {
        row.push(1);
      } else if (r % 2 === 0 && c % 2 === 0) {
        row.push(1);
      } else {
        row.push(0);
      }
    }
    grid.push(row);
  }
  // 스폰 코너 주변은 비워두고, 나머지에 파괴가능 벽 배치
  const spawnClear = [
    [1, 1], [2, 1], [1, 2],
    [COLS - 2, 1], [COLS - 3, 1], [COLS - 2, 2],
    [1, ROWS - 2], [2, ROWS - 2], [1, ROWS - 3],
    [COLS - 2, ROWS - 2], [COLS - 3, ROWS - 2], [COLS - 2, ROWS - 3]
  ];
  const clearSet = new Set(spawnClear.map(([c, r]) => `${c},${r}`));

  // 실제 크아 맵처럼 점대칭(180도 회전 대칭) 구조로 생성 -> 어느 스폰에서 시작해도 공평한 맵이 됨
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (grid[r][c] === 1) continue;

      const mirrorR = ROWS - 1 - r;
      const mirrorC = COLS - 1 - c;
      const idx = r * COLS + c;
      const mirrorIdx = mirrorR * COLS + mirrorC;
      if (idx > mirrorIdx) continue; // 짝이 이미 처리됨 -> 스킵 (대칭으로 채워짐)

      if (clearSet.has(`${c},${r}`) || clearSet.has(`${mirrorC},${mirrorR}`)) continue;
      if (grid[mirrorR][mirrorC] === 1) continue; // 대칭 위치가 기둥이면 짝이 안 맞으니 스킵

      if (Math.random() < 0.55) {
        grid[r][c] = 2;
        grid[mirrorR][mirrorC] = 2;
      }
    }
  }
  return grid;
}

function createRoom(hostSocketId, hostName) {
  const roomId = genRoomId();
  const spawns = [
    tileCenter(1, 1),
    tileCenter(COLS - 2, 1),
    tileCenter(1, ROWS - 2),
    tileCenter(COLS - 2, ROWS - 2)
  ];
  rooms[roomId] = {
    id: roomId,
    hostId: hostSocketId,
    state: 'lobby', // lobby | playing | ended
    grid: createMap(),
    items: {},      // "col,row" -> itemType
    bubbles: [],     // {id, col, row, ownerId, range, placedAt, active}
    players: {},     // socketId -> player
    spawns,
    loop: null,
    winnerId: null
  };
  addPlayer(roomId, hostSocketId, hostName, true);
  return roomId;
}

function addPlayer(roomId, socketId, name, isHost) {
  const room = rooms[roomId];
  const slot = Object.keys(room.players).length;
  const spawn = room.spawns[slot % room.spawns.length];
  room.players[socketId] = {
    id: socketId,
    name: name && name.trim() ? name.trim().slice(0, 12) : `플레이어${slot + 1}`,
    color: PLAYER_COLORS[slot % PLAYER_COLORS.length],
    emoji: PLAYER_NAMES_EMOJI[slot % PLAYER_NAMES_EMOJI.length],
    x: spawn.x,
    y: spawn.y,
    speed: BASE_SPEED,
    maxBubbles: 2,
    bubbleRange: 2,
    input: { up: false, down: false, left: false, right: false },
    state: 'alive', // alive | trapped | eliminated
    trappedAt: 0,
    isHost,
    ready: isHost,
    score: 0,
    onOwnBubble: null
  };
}

function publicRoomState(room) {
  return {
    id: room.id,
    state: room.state,
    hostId: room.hostId,
    grid: room.grid,
    items: room.items,
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color, emoji: p.emoji,
      ready: p.ready, isHost: p.isHost
    }))
  };
}

function gameSnapshot(room) {
  return {
    players: Object.values(room.players).map(p => ({
      id: p.id, name: p.name, color: p.color, emoji: p.emoji,
      x: p.x, y: p.y, state: p.state, ready: p.ready
    })),
    bubbles: room.bubbles.map(b => ({
      id: b.id, col: b.col, row: b.row, placedAt: b.placedAt
    })),
    grid: room.grid,
    items: room.items
  };
}

// -------------------- 충돌 체크 --------------------
function isSolid(room, col, row, ignoreBubbleId) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
  const cell = room.grid[row][col];
  if (cell === 1 || cell === 2) return true;
  const bubble = room.bubbles.find(b => b.col === col && b.row === row && b.id !== ignoreBubbleId);
  if (bubble && bubble.solidFor !== 'none') return true;
  return false;
}

function tryMove(room, player, dx, dy) {
  if (dx === 0 && dy === 0) return;
  const r = PLAYER_RADIUS;

  // X축 이동
  if (dx !== 0) {
    const newX = player.x + dx;
    const checkY1 = player.y - r + 2;
    const checkY2 = player.y + r - 2;
    const edgeX = dx > 0 ? newX + r : newX - r;
    const { col: c1 } = posToCell(edgeX, checkY1);
    const { col: c2 } = posToCell(edgeX, checkY2);
    const { row: rr1 } = posToCell(edgeX, checkY1);
    const { row: rr2 } = posToCell(edgeX, checkY2);
    const blocked = blockedForPlayer(room, player, c1, rr1) || blockedForPlayer(room, player, c2, rr2);
    if (!blocked) player.x = newX;
  }
  // Y축 이동
  if (dy !== 0) {
    const newY = player.y + dy;
    const checkX1 = player.x - r + 2;
    const checkX2 = player.x + r - 2;
    const edgeY = dy > 0 ? newY + r : newY - r;
    const { col: c1, row: r1 } = posToCell(checkX1, edgeY);
    const { col: c2, row: r2 } = posToCell(checkX2, edgeY);
    const blocked = blockedForPlayer(room, player, c1, r1) || blockedForPlayer(room, player, c2, r2);
    if (!blocked) player.y = newY;
  }
}

function blockedForPlayer(room, player, col, row) {
  if (row < 0 || row >= ROWS || col < 0 || col >= COLS) return true;
  const cell = room.grid[row][col];
  if (cell === 1 || cell === 2) return true;
  const bubble = room.bubbles.find(b => b.col === col && b.row === row);
  if (bubble) {
    // 방금 자기가 놓은 물풍선 위에 서있는 동안은 통과 가능
    if (player.onOwnBubble === bubble.id) return false;
    return true;
  }
  return false;
}

// -------------------- 아이템 --------------------
const ITEM_TYPES = ['bubble', 'range', 'speed'];
function maybeDropItem(room, col, row) {
  if (Math.random() < ITEM_DROP_CHANCE) {
    const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];
    room.items[`${col},${row}`] = type;
  }
}

function checkItemPickup(room, player) {
  const { col, row } = posToCell(player.x, player.y);
  const key = `${col},${row}`;
  const item = room.items[key];
  if (!item) return;
  delete room.items[key];
  if (item === 'bubble') player.maxBubbles = Math.min(player.maxBubbles + 1, 8);
  if (item === 'range') player.bubbleRange = Math.min(player.bubbleRange + 1, 8);
  if (item === 'speed') player.speed = Math.min(player.speed + SPEED_STEP, BASE_SPEED + SPEED_STEP * 5);
}

// -------------------- 물풍선 --------------------
let bubbleIdCounter = 1;

function placeBubble(room, player) {
  if (player.state !== 'alive') return;
  const activeCount = room.bubbles.filter(b => b.ownerId === player.id).length;
  if (activeCount >= player.maxBubbles) return;
  const { col, row } = posToCell(player.x, player.y);
  if (room.bubbles.some(b => b.col === col && b.row === row)) return;
  if (room.grid[row][col] !== 0) return;

  const bubble = {
    id: bubbleIdCounter++,
    col, row,
    ownerId: player.id,
    range: player.bubbleRange,
    placedAt: Date.now(),
    solidFor: 'all'
  };
  room.bubbles.push(bubble);
  player.onOwnBubble = bubble.id;
}

function popBubble(room, bubble, popped = new Set(), burstsOut = []) {
  if (popped.has(bubble.id)) return [];
  popped.add(bubble.id);
  room.bubbles = room.bubbles.filter(b => b.id !== bubble.id);

  const affectedCells = [{ col: bubble.col, row: bubble.row }];
  const arms = { up: 0, down: 0, left: 0, right: 0 };
  const dirs = [['right', 1, 0], ['left', -1, 0], ['down', 0, 1], ['up', 0, -1]];

  for (const [name, dx, dy] of dirs) {
    for (let step = 1; step <= bubble.range; step++) {
      const c = bubble.col + dx * step;
      const r = bubble.row + dy * step;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) break;
      const cell = room.grid[r][c];
      if (cell === 1) break; // 파괴불가 벽에서 정지
      affectedCells.push({ col: c, row: r });
      arms[name] = step; // 이 방향으로 실제 물이 도달한 거리 (연출용)
      if (cell === 2) {
        room.grid[r][c] = 0;
        maybeDropItem(room, c, r);
        break; // 파괴가능 벽은 부수고 정지
      }
      // 경로에 다른 물풍선 있으면 연쇄 폭발
      const chainBubble = room.bubbles.find(b => b.col === c && b.row === r);
      if (chainBubble) {
        const chainCells = popBubble(room, chainBubble, popped, burstsOut);
        affectedCells.push(...chainCells);
      }
    }
  }

  burstsOut.push({
    col: bubble.col, row: bubble.row,
    up: arms.up, down: arms.down, left: arms.left, right: arms.right
  });

  // 플레이어 판정
  for (const pid in room.players) {
    const p = room.players[pid];
    const { col: pc, row: pr } = posToCell(p.x, p.y);
    const hit = affectedCells.some(cell => cell.col === pc && cell.row === pr);
    if (!hit) continue;
    if (p.state === 'alive') {
      p.state = 'trapped';
      p.trappedAt = Date.now();
    } else if (p.state === 'trapped') {
      p.state = 'eliminated';
    }
  }

  return affectedCells;
}

// -------------------- 자유(구출) / 탈락 처리 --------------------
function checkFreeing(room) {
  const alive = Object.values(room.players).filter(p => p.state === 'alive');
  const trapped = Object.values(room.players).filter(p => p.state === 'trapped');
  for (const t of trapped) {
    if (Date.now() - t.trappedAt > TRAP_TIMEOUT) {
      t.state = 'eliminated';
      continue;
    }
    const { col: tc, row: tr } = posToCell(t.x, t.y);
    for (const a of alive) {
      const { col: ac, row: ar } = posToCell(a.x, a.y);
      if (ac === tc && ar === tr) {
        t.state = 'alive';
        t.trappedAt = 0;
        break;
      }
    }
  }
}

function checkWinCondition(room) {
  const remaining = Object.values(room.players).filter(p => p.state !== 'eliminated');
  const totalPlayers = Object.keys(room.players).length;
  if (totalPlayers >= 2 && remaining.length <= 1) {
    room.state = 'ended';
    room.winnerId = remaining[0] ? remaining[0].id : null;
    return true;
  }
  return false;
}

// -------------------- 게임 루프 --------------------
function startGameLoop(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.state = 'playing';
  room.grid = createMap();
  room.items = {};
  room.bubbles = [];
  room.winnerId = null;

  const ids = Object.keys(room.players);
  ids.forEach((id, idx) => {
    const p = room.players[id];
    const spawn = room.spawns[idx % room.spawns.length];
    p.x = spawn.x;
    p.y = spawn.y;
    p.state = 'alive';
    p.maxBubbles = 2;
    p.bubbleRange = 2;
    p.speed = BASE_SPEED;
    p.onOwnBubble = null;
  });

  io.to(roomId).emit('gameStarted', gameSnapshot(room));

  room.loop = setInterval(() => {
    const dt = TICK_MS / 1000;
    for (const id in room.players) {
      const p = room.players[id];
      if (p.state === 'eliminated') continue;
      let dx = 0, dy = 0;
      if (p.input.left) dx -= 1;
      if (p.input.right) dx += 1;
      if (p.input.up) dy -= 1;
      if (p.input.down) dy += 1;
      if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }

      // 자기 물풍선 위에서 벗어났는지 체크
      if (p.onOwnBubble !== null) {
        const { col, row } = posToCell(p.x, p.y);
        const b = room.bubbles.find(bb => bb.id === p.onOwnBubble);
        if (!b || b.col !== col || b.row !== row) p.onOwnBubble = null;
      }

      if (p.state === 'alive') {
        tryMove(room, p, dx * p.speed * dt, dy * p.speed * dt);
        checkItemPickup(room, p);
      }
    }

    // 물풍선 타이머 체크
    const now = Date.now();
    const toPop = room.bubbles.filter(b => now - b.placedAt >= BUBBLE_TIMER);
    const alreadyPopped = new Set();
    const burstsOut = [];
    for (const b of toPop) {
      if (alreadyPopped.has(b.id)) continue;
      popBubble(room, b, alreadyPopped, burstsOut);
    }

    checkFreeing(room);
    const ended = checkWinCondition(room);

    io.to(roomId).emit('gameState', gameSnapshot(room));

    if (burstsOut.length > 0) {
      io.to(roomId).emit('explosion', { bursts: burstsOut });
    }

    if (ended) {
      clearInterval(room.loop);
      room.loop = null;
      const winner = room.winnerId ? room.players[room.winnerId] : null;
      io.to(roomId).emit('gameEnded', {
        winnerId: room.winnerId,
        winnerName: winner ? winner.name : null
      });
    }
  }, TICK_MS);
}

function resetRoomToLobby(room) {
  room.state = 'lobby';
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  for (const id in room.players) {
    room.players[id].ready = room.players[id].isHost;
  }
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    const roomId = createRoom(socket.id, name);
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, you: socket.id });
    io.to(roomId).emit('roomUpdate', publicRoomState(rooms[roomId]));
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    roomId = (roomId || '').toUpperCase().trim();
    const room = rooms[roomId];
    if (!room) return socket.emit('errorMsg', '존재하지 않는 방 코드입니다.');
    if (room.state === 'playing') return socket.emit('errorMsg', '이미 게임이 진행 중인 방입니다.');
    if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit('errorMsg', '방이 가득 찼습니다.');

    addPlayer(roomId, socket.id, name, false);
    socket.join(roomId);
    socket.emit('roomJoined', { roomId, you: socket.id });
    io.to(roomId).emit('roomUpdate', publicRoomState(room));
  });

  socket.on('toggleReady', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    if (room.players[socket.id].isHost) return; // 호스트는 항상 준비 상태
    room.players[socket.id].ready = !room.players[socket.id].ready;
    io.to(roomId).emit('roomUpdate', publicRoomState(room));
  });

  socket.on('startGame', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.id) return;
    const players = Object.values(room.players);
    if (players.length < 2) return socket.emit('errorMsg', '최소 2명이 필요합니다.');
    if (!players.every(p => p.ready)) return socket.emit('errorMsg', '모든 플레이어가 준비되어야 합니다.');
    startGameLoop(roomId);
  });

  socket.on('playAgain', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
    resetRoomToLobby(room);
    io.to(roomId).emit('roomUpdate', publicRoomState(room));
    io.to(roomId).emit('backToLobby');
  });

  socket.on('input', ({ roomId, input }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].input = {
      up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right
    };
  });

  socket.on('placeBubble', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const player = room.players[socket.id];
    if (!player) return;
    placeBubble(room, player);
  });

  socket.on('chat', ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    const name = room.players[socket.id].name;
    const clean = String(text || '').slice(0, 120);
    if (!clean.trim()) return;
    io.to(roomId).emit('chat', { name, text: clean });
  });

  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room.players[socket.id]) continue;
      const wasHost = room.hostId === socket.id;
      delete room.players[socket.id];

      if (Object.keys(room.players).length === 0) {
        if (room.loop) clearInterval(room.loop);
        delete rooms[roomId];
        continue;
      }
      if (wasHost) {
        const newHostId = Object.keys(room.players)[0];
        room.hostId = newHostId;
        room.players[newHostId].isHost = true;
        room.players[newHostId].ready = true;
      }
      if (room.state === 'playing') {
        checkWinCondition(room);
      }
      io.to(roomId).emit('roomUpdate', publicRoomState(room));
      io.to(roomId).emit('gameState', gameSnapshot(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`KEUA ONLINE 서버 실행 중: http://localhost:${PORT}`);
});
