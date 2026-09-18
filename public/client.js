// ============================================================
//  KEUA ONLINE - 클라이언트
// ============================================================
const socket = io();

const TILE = 40;
let COLS = 15, ROWS = 11;

let myId = null;
let currentRoomId = null;
let isHost = false;

let latestState = null; // 최신 gameState 스냅샷
let explosionFX = [];   // {col,row,expireAt}

// ---------- 화면 전환 ----------
const screens = {
  start: document.getElementById('screen-start'),
  lobby: document.getElementById('screen-lobby'),
  game: document.getElementById('screen-game'),
  result: document.getElementById('screen-result'),
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ---------- 시작 화면 ----------
const inputName = document.getElementById('input-name');
const inputRoomCode = document.getElementById('input-roomcode');
const startError = document.getElementById('start-error');

document.getElementById('btn-create').onclick = () => {
  startError.textContent = '';
  socket.emit('createRoom', { name: inputName.value });
};
document.getElementById('btn-join').onclick = () => {
  startError.textContent = '';
  const code = inputRoomCode.value.trim();
  if (!code) { startError.textContent = '방 코드를 입력하세요.'; return; }
  socket.emit('joinRoom', { roomId: code, name: inputName.value });
};

socket.on('errorMsg', (msg) => {
  startError.textContent = msg;
  document.getElementById('lobby-error').textContent = msg;
});

// ---------- 로비 화면 ----------
const lobbyRoomCode = document.getElementById('lobby-roomcode');
const lobbyPlayers = document.getElementById('lobby-players');
const btnReady = document.getElementById('btn-ready');
const btnStart = document.getElementById('btn-start');

socket.on('roomJoined', ({ roomId, you }) => {
  currentRoomId = roomId;
  myId = you;
  lobbyRoomCode.textContent = roomId;
  document.getElementById('game-roomcode').textContent = roomId;
  showScreen('lobby');
});

socket.on('roomUpdate', (room) => {
  isHost = room.hostId === myId;
  lobbyPlayers.innerHTML = '';
  room.players.forEach(p => {
    const li = document.createElement('li');
    const readyTag = p.isHost
      ? '<span class="tag tag-host">방장</span>'
      : (p.ready ? '<span class="tag tag-ready">준비완료</span>' : '<span class="tag tag-wait">대기중</span>');
    li.innerHTML = `<span class="swatch" style="background:${p.color}">${p.emoji}</span>
                     <span class="pname">${escapeHtml(p.name)}</span> ${readyTag}`;
    lobbyPlayers.appendChild(li);
  });

  if (isHost) {
    btnReady.classList.add('hidden');
    btnStart.classList.remove('hidden');
    const allReady = room.players.every(p => p.ready);
    btnStart.disabled = !(allReady && room.players.length >= 2);
  } else {
    btnReady.classList.remove('hidden');
    btnStart.classList.add('hidden');
    const me = room.players.find(p => p.id === myId);
    btnReady.textContent = me && me.ready ? '준비 취소' : '준비 완료';
  }
});

btnReady.onclick = () => socket.emit('toggleReady', { roomId: currentRoomId });
btnStart.onclick = () => socket.emit('startGame', { roomId: currentRoomId });
document.getElementById('btn-again').onclick = () => socket.emit('playAgain', { roomId: currentRoomId });

// ---------- 게임 화면 ----------
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
canvas.width = COLS * TILE;
canvas.height = ROWS * TILE;

socket.on('gameStarted', (snap) => {
  latestState = snap;
  explosionFX = [];
  showScreen('game');
  requestAnimationFrame(renderLoop);
});

socket.on('gameState', (snap) => {
  latestState = snap;
});

socket.on('explosion', ({ cells }) => {
  const now = Date.now();
  cells.forEach(cell => {
    // cell can be {col,row} objects flattened via Set of ids in server -> we get array from server differently
  });
});

// 서버는 explosion 이벤트에서 bubble id 리스트를 보내므로, 실제 시각효과는 gameState 변화(벽 파괴)로 갈음.
// 대신 물풍선이 사라지는 시점에 간단한 팝 이펙트를 표시하기 위해 이전 프레임과 비교한다.
let prevBubbleIds = new Set();

function detectPops(snap) {
  const currentIds = new Set(snap.bubbles.map(b => b.id));
  prevBubbleIds.forEach(id => {
    if (!currentIds.has(id)) {
      // 이 물풍선이 사라짐 -> 위치를 몰라서 스킵 (간단화를 위해 생략 가능)
    }
  });
  prevBubbleIds = currentIds;
}

const hudPlayers = document.getElementById('hud-players');

function updateHud(snap) {
  hudPlayers.innerHTML = '';
  snap.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'hud-chip' + (p.state === 'eliminated' ? ' eliminated' : '') + (p.state === 'trapped' ? ' trapped' : '');
    chip.innerHTML = `<span class="dot" style="background:${p.color}">${p.emoji}</span>${escapeHtml(p.name)}`;
    hudPlayers.appendChild(chip);
  });
}

function renderLoop() {
  if (screens.game.classList.contains('hidden')) return;
  if (latestState) {
    draw(latestState);
    updateHud(latestState);
  }
  requestAnimationFrame(renderLoop);
}

function draw(snap) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 바닥
  ctx.fillStyle = '#dff4ff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  for (let c = 0; c <= COLS; c++) {
    ctx.beginPath(); ctx.moveTo(c * TILE, 0); ctx.lineTo(c * TILE, canvas.height); ctx.stroke();
  }
  for (let r = 0; r <= ROWS; r++) {
    ctx.beginPath(); ctx.moveTo(0, r * TILE); ctx.lineTo(canvas.width, r * TILE); ctx.stroke();
  }

  // 벽
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = snap.grid[r][c];
      if (cell === 1) drawHardWall(c, r);
      else if (cell === 2) drawSoftWall(c, r);
    }
  }

  // 아이템
  Object.entries(snap.items).forEach(([key, type]) => {
    const [c, r] = key.split(',').map(Number);
    drawItem(c, r, type);
  });

  // 물풍선
  snap.bubbles.forEach(b => drawBubbleObj(b));

  // 플레이어
  snap.players.forEach(p => drawPlayer(p));
}

function drawHardWall(c, r) {
  const x = c * TILE, y = r * TILE;
  ctx.fillStyle = '#7f96ad';
  roundRect(x + 2, y + 2, TILE - 4, TILE - 4, 6);
  ctx.fill();
  ctx.fillStyle = '#9fb2c4';
  roundRect(x + 6, y + 6, TILE - 12, TILE - 12, 4);
  ctx.fill();
}
function drawSoftWall(c, r) {
  const x = c * TILE, y = r * TILE;
  ctx.fillStyle = '#e0b16b';
  roundRect(x + 2, y + 2, TILE - 4, TILE - 4, 8);
  ctx.fill();
  ctx.fillStyle = '#f0cd8f';
  roundRect(x + 6, y + 6, TILE - 12, TILE - 12, 6);
  ctx.fill();
}
function drawItem(c, r, type) {
  const x = c * TILE + TILE / 2, y = r * TILE + TILE / 2;
  const icons = { bubble: '💧', range: '🔥', speed: '👟' };
  ctx.font = '22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icons[type] || '❓', x, y);
}
function drawBubbleObj(b) {
  const x = b.col * TILE + TILE / 2, y = b.row * TILE + TILE / 2;
  const age = (Date.now() - b.placedAt) / 3000;
  const pulse = 1 + Math.sin(Date.now() / 120) * 0.05 * (age > 0.7 ? 3 : 1);
  const radius = (TILE / 2 - 4) * pulse;
  const grad = ctx.createRadialGradient(x - 5, y - 5, 2, x, y, radius);
  grad.addColorStop(0, '#eaffff');
  grad.addColorStop(0.5, '#7fd8ff');
  grad.addColorStop(1, '#2a9fe0');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2;
  ctx.stroke();
}
function drawPlayer(p) {
  const x = p.x, y = p.y;
  ctx.save();
  if (p.state === 'eliminated') { ctx.globalAlpha = 0.15; }
  if (p.state === 'trapped') {
    // 잡힌 상태: 큰 물풍선 안에 갇힌 모습
    const grad = ctx.createRadialGradient(x - 4, y - 4, 2, x, y, 17);
    grad.addColorStop(0, '#eaffff');
    grad.addColorStop(0.6, '#7fd8ff');
    grad.addColorStop(1, '#1e8fd0');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }
  // 캐릭터 원
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(x, y, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
  // 이모지 얼굴
  ctx.font = '15px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.emoji, x, y - 1);
  ctx.restore();

  // 이름표
  ctx.font = 'bold 10px sans-serif';
  ctx.fillStyle = '#22364a';
  ctx.textAlign = 'center';
  ctx.fillText(p.name, x, y - 22);
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 결과 화면 ----------
socket.on('gameEnded', ({ winnerId, winnerName }) => {
  const title = document.getElementById('result-title');
  const sub = document.getElementById('result-sub');
  const btnAgain = document.getElementById('btn-again');
  const waitMsg = document.getElementById('result-wait');
  if (winnerId === myId) {
    title.textContent = '🎉 승리했습니다!';
  } else if (winnerName) {
    title.textContent = '아쉽지만 패배...';
  } else {
    title.textContent = '게임 종료';
  }
  sub.textContent = winnerName ? `승자: ${winnerName}` : '무승부';
  if (isHost) {
    btnAgain.classList.remove('hidden');
    waitMsg.classList.add('hidden');
  } else {
    btnAgain.classList.add('hidden');
    waitMsg.classList.remove('hidden');
  }
  showScreen('result');
});

socket.on('backToLobby', () => {
  showScreen('lobby');
});

// ---------- 입력 처리 (키보드) ----------
const keyState = { up: false, down: false, left: false, right: false };
const keyMap = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};

window.addEventListener('keydown', (e) => {
  if (document.activeElement === document.getElementById('chat-input')) return;
  const dir = keyMap[e.code];
  if (dir && !keyState[dir]) {
    keyState[dir] = true;
    sendInput();
  }
  if (e.code === 'Space') {
    e.preventDefault();
    socket.emit('placeBubble', { roomId: currentRoomId });
  }
});
window.addEventListener('keyup', (e) => {
  const dir = keyMap[e.code];
  if (dir) {
    keyState[dir] = false;
    sendInput();
  }
});
function sendInput() {
  if (!currentRoomId) return;
  socket.emit('input', { roomId: currentRoomId, input: keyState });
}

// ---------- 모바일 컨트롤 ----------
document.querySelectorAll('.dpad-btn').forEach(btn => {
  const dir = btn.dataset.dir;
  const start = (e) => { e.preventDefault(); keyState[dir] = true; sendInput(); };
  const end = (e) => { e.preventDefault(); keyState[dir] = false; sendInput(); };
  btn.addEventListener('touchstart', start);
  btn.addEventListener('touchend', end);
  btn.addEventListener('mousedown', start);
  btn.addEventListener('mouseup', end);
  btn.addEventListener('mouseleave', end);
});
document.getElementById('btn-bubble').addEventListener('click', () => {
  socket.emit('placeBubble', { roomId: currentRoomId });
});

// ---------- 채팅 ----------
const chatInput = document.getElementById('chat-input');
const chatLog = document.getElementById('chat-log');
chatInput.addEventListener('keydown', (e) => {
  if (e.code === 'Enter' && chatInput.value.trim()) {
    socket.emit('chat', { roomId: currentRoomId, text: chatInput.value });
    chatInput.value = '';
    chatInput.blur();
  }
});
socket.on('chat', ({ name, text }) => {
  const div = document.createElement('div');
  div.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}
