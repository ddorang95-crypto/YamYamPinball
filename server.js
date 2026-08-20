'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const rooms = new Map();
const roomStreams = new Map();
const roomSockets = new Map();

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const now = () => Date.now();
const cleanRoom = (value) => {
  const code = String(value || 'YAMYAM').replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
  return code || 'YAMYAM';
};

function emptySnapshot() {
  return { balls: [], rot: [], gate: 0, cam: 0, camX: 560, camZoom: 0.82, seq: 0, raceId: 0 };
}

function ownerInitial(owner) {
  const value = String(owner || '').trim().toLowerCase();
  if (!value) return '';
  if (value.includes('야미') || value === 'y' || value.includes('yami')) return 'Y';
  if (value.includes('꿀혜') || value === 'g' || value.includes('ggul')) return 'G';
  if (value.includes('선하') || value === 'm' || value.includes('seonha')) return 'M';
  if (value.includes('도릿') || value === 'd' || value.includes('dorit')) return 'D';
  return String(owner || '').trim().slice(0, 1).toUpperCase();
}


function newRoom(code) {
  const roomNames = { GROUP: '단체 핀볼', YAMI: '야미 개인 핀볼', GGULHYE: '꿀혜 개인 핀볼', SEONHA: '선하 개인 핀볼', DORIT: '도릿 개인 핀볼' };
  return {
    code,
    mode: code === 'GROUP' ? 'group' : 'solo',
    title: roomNames[code] || 'Yamyam Marble Pinball',
    map: 'wheel',
    status: 'lobby',
    participants: [],
    winMode: 'first',
    winningRanks: [1],
    raceBalls: [],
    finishOrder: [],
    winners: [],
    snapshot: emptySnapshot(),
    raceId: 0,
    seed: 1,
    shuffleNonce: 0,
    winnerDeclared: false,
    winnerPopupAt: 0,
    startedAt: 0,
    duration: 0,
    updatedAt: now(),
    snapshotSeq: 0,
    interactionSeq: 0,
    raceHostId: ''
  };
}

function getRoom(code) {
  const key = cleanRoom(code);
  if (!rooms.has(key)) rooms.set(key, newRoom(key));
  return rooms.get(key);
}

function touch(room) { room.updatedAt = now(); }
function backToLobby(room) {
  room.status = 'lobby';
  room.raceBalls = [];
  room.finishOrder = [];
  room.winners = [];
  room.winnerDeclared = false;
  room.winnerPopupAt = 0;
  room.snapshot = emptySnapshot();
  room.startedAt = 0;
  room.duration = 0;
  room.raceHostId = '';
}

function randomSeed() {
  return crypto.randomInt(100000, 2147483000);
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });
  res.end(body);
}

function text(res, status, value, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(value));
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate'
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw new Error('요청 데이터가 너무 큽니다.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function asRanks(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

function responseState(res, room, extra = {}) {
  json(res, 200, { ok: true, state: clientState(room), serverNow: now(), ...extra });
}

function clientState(room) {
  const { raceBalls, ...rest } = room;
  return { ...rest, raceBallCount: Array.isArray(raceBalls) ? raceBalls.length : 0 };
}

// 실시간 제어 이벤트에는 수백~수천 개 공 좌표(snapshot)를 싣지 않는다.
// 좌표는 /api/state 폴링으로만 받고, 맵/참가자/결과 이벤트는 가볍게 전파한다.
function eventState(room) {
  const { snapshot, raceBalls, ...rest } = room;
  return { ...rest, snapshotVersion: room.updatedAt, raceBallCount: Array.isArray(raceBalls) ? raceBalls.length : 0 };
}

function handleAction(res, data) {
  const room = getRoom(data.room);
  const action = String(data.action || '');

  switch (action) {
    case 'addParticipant': {
      if (room.status === 'running') throw new Error('레이스 진행 중에는 추가할 수 없습니다.');
      const name = String(data.name || '').trim();
      const owner = String(data.owner || '').trim();
      let count = Math.max(1, Math.min(5000, Number(data.count) || 1));
      if (!name || name.length > 24) throw new Error('닉네임은 1~24자로 입력해 주세요.');
      if (owner.length > 40) throw new Error('멤버 이름이 너무 깁니다.');
      room.participants.push({ id: crypto.randomUUID().replace(/-/g, ''), name, owner, ownerInitial: ownerInitial(owner), count, addedAt: now() });
      backToLobby(room); touch(room); break;
    }
    case 'bulkAdd': {
      if (room.status === 'running') throw new Error('레이스 진행 중에는 추가할 수 없습니다.');
      const owner = String(data.owner || '').trim();
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const name = String(item.name || '').trim();
        const count = Math.max(1, Math.min(5000, Number(item.count) || 1));
        if (name && name.length <= 24) room.participants.push({ id: crypto.randomUUID().replace(/-/g, ''), name, owner, ownerInitial: ownerInitial(owner), count, addedAt: now() });
      }
      backToLobby(room); touch(room); break;
    }
    case 'adjustParticipantGroup': {
      if (room.status === 'running') throw new Error('레이스 진행 중에는 변경할 수 없습니다.');
      const ids = new Set((Array.isArray(data.ids) ? data.ids : []).map(String));
      const owner = String(data.owner || '');
      const admin = Boolean(data.admin);
      const matches = room.participants.filter((p) => ids.has(String(p.id)) && (admin || p.owner === owner));
      if (!matches.length) throw new Error('참가자를 찾을 수 없습니다.');
      const current = matches.reduce((sum, p) => sum + Number(p.count || 0), 0);
      const target = Math.max(0, Math.min(5000, data.count != null ? Number(data.count) : current + Number(data.delta || 0)));
      const keepId = matches[0].id;
      if (target === 0) room.participants = room.participants.filter((p) => !(ids.has(String(p.id)) && (admin || p.owner === owner)));
      else {
        room.participants = room.participants.filter((p) => p.id === keepId || !(ids.has(String(p.id)) && (admin || p.owner === owner)));
        const kept = room.participants.find((p) => p.id === keepId);
        if (kept) kept.count = target;
      }
      backToLobby(room); touch(room); break;
    }
    case 'setMode': {
      if (!['solo', 'group'].includes(data.mode)) throw new Error('잘못된 모드입니다.');
      room.mode = data.mode; touch(room); break;
    }
    case 'setTitle': {
      room.title = String(data.title || '').trim().slice(0, 50); touch(room); break;
    }
    case 'setMap': {
      if (!['wheel', 'greed', 'cascade', 'maze'].includes(data.map)) throw new Error('잘못된 맵입니다.');
      room.map = data.map;
      backToLobby(room);
      room.shuffleNonce += 1;
      room.seed = randomSeed();
      touch(room); break;
    }
    case 'setWin': {
      const mode = String(data.winMode || '').toLowerCase();
      const ranks = asRanks(data.ranks);
      if (!['first', 'last', 'number'].includes(mode)) throw new Error('잘못된 당첨 방식입니다.');
      if (mode === 'number' && !ranks.length) throw new Error('유효한 순위를 입력해 주세요.');
      room.winMode = mode;
      room.winningRanks = mode === 'number' ? ranks : [1];
      touch(room); break;
    }
    case 'shuffle': {
      if (room.status === 'running') throw new Error('레이스 진행 중에는 섞을 수 없습니다.');
      backToLobby(room); room.shuffleNonce += 1; room.seed = randomSeed(); touch(room); break;
    }
    case 'startRace': {
      if (['wheel', 'greed', 'cascade', 'maze'].includes(data.map)) room.map = data.map;
      const mode = String(data.winMode || '').toLowerCase();
      const ranks = asRanks(data.ranks);
      if (['first', 'last', 'number'].includes(mode) && (mode !== 'number' || ranks.length)) {
        room.winMode = mode;
        room.winningRanks = mode === 'number' ? ranks : [1];
      }
      const balls = [];
      for (const p of room.participants) {
        for (let i = 1; i <= Number(p.count || 0); i++) {
          balls.push({ ballId: `${p.id}_${i}`, participantId: p.id, name: p.name, owner: p.owner, ownerInitial: p.ownerInitial || ownerInitial(p.owner), copy: i });
        }
      }
      if (!balls.length) throw new Error('공을 1개 이상 추가해 주세요.');
      room.raceBalls = balls;
      room.finishOrder = [];
      room.winners = [];
      room.winnerDeclared = false;
      room.snapshot = emptySnapshot();
      room.snapshotSeq = 0;
      room.raceId += 1;
      if (!(room.seed > 0)) room.seed = randomSeed();
      room.startedAt = now() + 6000;
      room.duration = 0;
      room.raceHostId = String(data.clientId || '');
      room.status = 'running';
      touch(room);
      broadcastRoom(room);
      json(res, 200, { ok: true, raceId: room.raceId, seed: room.seed, status: room.status, map: room.map, winMode: room.winMode, winningRanks: room.winningRanks, startedAt: room.startedAt, raceHostId: room.raceHostId, serverNow: now() });
      return;
    }
    case 'snapshot': {
      if (room.status === 'running' && String(data.clientId || '') === String(room.raceHostId || '')) {
        const seq = Math.max(0, Number(data.seq) || 0);
        const raceId = Number(data.raceId) || room.raceId;
        // 느리게 도착한 이전 프레임이 최신 화면을 되감는 현상을 차단한다.
        if (raceId === room.raceId && seq >= Number(room.snapshotSeq || 0)) {
          room.snapshotSeq = seq;
          room.snapshot = {
            packed: Number(data.packed || 0) === 1 ? 1 : 0,
            balls: Array.isArray(data.balls) ? data.balls : [],
            rot: Array.isArray(data.rot) ? data.rot : [],
            gate: Number(data.gate || 0),
            cam: Number(data.cam || 0),
            camX: Number(data.camX || 560),
            camZoom: Number(data.camZoom || 0.82),
            focusBallId: String(data.focusBallId || ''),
            focusRemainingMs: Math.max(0, Number(data.focusRemainingMs || 0)),
            winnerResolved: !!data.winnerResolved,
            winnerFlash: data.winnerFlash && typeof data.winnerFlash === 'object' ? data.winnerFlash : null,
            sentAt: Number(data.sentAt || 0),
            seq, raceId
          };
          touch(room);
          broadcastSnapshot(room);
        }
      }
      break;
    }
    case 'interaction': {
      const it = data.interaction && typeof data.interaction === 'object' ? data.interaction : {};
      const seq = Math.max(Number(room.interactionSeq || 0) + 1, Number(it.seq || 0));
      room.interactionSeq = seq;
      broadcastInteraction(room, {
        seq,
        source: String(it.source || '').slice(0, 80),
        type: String(it.type || '').slice(0, 30),
        elementId: String(it.elementId || '').slice(0, 80),
        label: String(it.label || '').slice(0, 80),
        x: Math.max(0, Math.min(1, Number(it.x) || 0)),
        y: Math.max(0, Math.min(1, Number(it.y) || 0)),
        at: now()
      });
      return json(res, 200, { ok: true });
    }
    case 'finishBalls': {
      if (room.status === 'running' && String(data.clientId || '') === String(room.raceHostId || '')) {
        const ids = Array.isArray(data.ballIds) ? data.ballIds.map(String).slice(0, 120) : [];
        for (const id of ids) {
          if (room.finishOrder.some((x) => x.ballId === id)) continue;
          const ball = room.raceBalls.find((x) => x.ballId === id);
          if (ball) room.finishOrder.push({ ballId: ball.ballId, name: ball.name, copy: ball.copy, owner: ball.owner, ownerInitial: ball.ownerInitial || ownerInitial(ball.owner), rank: room.finishOrder.length + 1 });
        }
        if (!room.winnerDeclared && room.finishOrder.length) {
          const wanted = room.winMode === 'last'
            ? [room.raceBalls.length]
            : room.winMode === 'number' ? room.winningRanks : [1];
          const winners = wanted.map((rank) => room.finishOrder[rank - 1]).filter(Boolean);
          if (winners.length === wanted.length) {
            room.winners = winners;
            room.winnerDeclared = true;
            room.winnerPopupAt = now() + 700;
          }
        }
        touch(room);
        broadcastRoom(room);
      }
      return json(res, 200, { ok: true });
    }
    case 'finishBall': {
      if (room.status === 'running' && String(data.clientId || '') === String(room.raceHostId || '')) {
        const id = String(data.ballId || '');
        if (!room.finishOrder.some((x) => x.ballId === id)) {
          const ball = room.raceBalls.find((x) => x.ballId === id);
          if (ball) room.finishOrder.push({ ballId: ball.ballId, name: ball.name, copy: ball.copy, owner: ball.owner, ownerInitial: ball.ownerInitial || ownerInitial(ball.owner), rank: room.finishOrder.length + 1 });
        }
        if (!room.winnerDeclared) {
          let ready = false;
          if (room.winMode === 'first' && room.finishOrder.length >= 1) ready = true;
          else if (room.winMode === 'number' && room.finishOrder.length >= Math.max(...room.winningRanks)) ready = true;
          else if (room.winMode === 'last' && room.finishOrder.length >= room.raceBalls.length) ready = true;
          if (ready) {
            if (room.winMode === 'first') room.winners = [room.finishOrder[0]];
            else if (room.winMode === 'last') room.winners = [room.finishOrder[room.finishOrder.length - 1]];
            else room.winners = room.winningRanks.map((rank) => room.finishOrder[rank - 1]).filter(Boolean);
            room.winnerDeclared = true;
            room.winnerPopupAt = now() + 700;
          }
        }
        touch(room);
      }
      break;
    }
    case 'completeRace': {
      if (room.status === 'running' && String(data.clientId || '') === String(room.raceHostId || '')) { room.status = 'completed'; touch(room); }
      break;
    }
    case 'resetRace': {
      backToLobby(room); room.shuffleNonce += 1; room.seed = randomSeed(); touch(room); break;
    }
    case 'clearParticipants': {
      backToLobby(room); room.participants = []; room.shuffleNonce += 1; room.seed = randomSeed(); touch(room); break;
    }
    default: throw new Error('지원하지 않는 요청입니다.');
  }

  if (action !== 'snapshot' && action !== 'interaction') broadcastRoom(room);

  // 고빈도 요청은 거대한 room 전체를 다시 JSON 직렬화하지 않는다.
  // 이것이 관리자 물리 루프까지 막아 공이 멈춰 보이던 주원인이었다.
  if (action === 'snapshot' || action === 'finishBall' || action === 'completeRace') {
    return json(res, 200, { ok: true, updatedAt: room.updatedAt, status: room.status, winnerDeclared: room.winnerDeclared });
  }
  responseState(res, room);
}


function writeRoomPacket(room, packet) {
  const key = cleanRoom(room.code);
  const clients = roomStreams.get(key);
  if (!clients || !clients.size) return;
  const payload = `data: ${JSON.stringify(packet)}\n\n`;
  for (const res of [...clients]) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
  if (!clients.size) roomStreams.delete(key);
}

function broadcastSnapshot(room) {
  const key = cleanRoom(room.code);
  const clients = roomStreams.get(key);
  if (!clients || !clients.size) return;
  const payload = `data: ${JSON.stringify({ ok: true, kind: 'snapshot', raceId: room.raceId, status: room.status, snapshot: room.snapshot, serverNow: now() })}\n\n`;
  for (const res of [...clients]) {
    try {
      // 느린 관전자에게 이전 프레임을 계속 쌓지 않고 최신 프레임 하나만 보관한다.
      if (res.__snapshotBlocked) { res.__latestSnapshot = payload; continue; }
      const ok = res.write(payload);
      if (!ok) {
        res.__snapshotBlocked = true;
        res.__latestSnapshot = null;
        res.once('drain', () => {
          res.__snapshotBlocked = false;
          const latest = res.__latestSnapshot;
          res.__latestSnapshot = null;
          if (latest) { try { if (!res.write(latest)) res.__snapshotBlocked = true; } catch {} }
        });
      }
    } catch { clients.delete(res); }
  }
  if (!clients.size) roomStreams.delete(key);
}

function broadcastInteraction(room, interaction) {
  writeRoomPacket(room, { ok: true, kind: 'interaction', interaction, serverNow: now() });
}

function broadcastRoom(room) {
  const key = cleanRoom(room.code);
  const clients = roomStreams.get(key);
  if (!clients || !clients.size) return;
  const payload = `data: ${JSON.stringify({ ok: true, state: eventState(room), serverNow: now() })}\n\n`;
  for (const res of [...clients]) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
  if (!clients.size) roomStreams.delete(key);
}

function openRoomStream(req, res, code) {
  const key = cleanRoom(code);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`retry: 1200\ndata: ${JSON.stringify({ ok: true, state: getRoom(key), serverNow: now() })}\n\n`);
  if (!roomStreams.has(key)) roomStreams.set(key, new Set());
  roomStreams.get(key).add(res);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    const clients = roomStreams.get(key);
    if (clients) { clients.delete(res); if (!clients.size) roomStreams.delete(key); }
  });
}


function wsFrame(text) {
  const payload = Buffer.from(String(text));
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.from([0x81, len]); }
  else if (len <= 0xffff) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
function wsBroadcastSnapshot(room, packet, source) {
  const key = cleanRoom(room.code);
  const clients = roomSockets.get(key);
  if (!clients || !clients.size) return;
  const frame = wsFrame(JSON.stringify(packet));

  const flushLatest = (sock) => {
    if (!sock || sock.destroyed || !sock.writable || !sock.__latestWsFrame) return;
    if (sock.writableLength > 90000) return;
    const latest = sock.__latestWsFrame;
    sock.__latestWsFrame = null;
    try {
      const ok = sock.write(latest);
      if (!ok) sock.once('drain', () => flushLatest(sock));
    } catch {}
  };

  for (const sock of [...clients]) {
    if (sock === source || sock.destroyed || !sock.writable) continue;
    try {
      // 느린 관전자에게 오래된 프레임을 큐로 쌓지 않는다.
      // 송신 버퍼가 차 있으면 현재 프레임은 '최신 1개'로 교체하고 drain 후 그것만 보낸다.
      if (sock.writableLength > 90000) {
        sock.__latestWsFrame = frame;
        if (!sock.__latestDrainBound) {
          sock.__latestDrainBound = true;
          sock.once('drain', () => {
            sock.__latestDrainBound = false;
            flushLatest(sock);
          });
        }
        continue;
      }
      const ok = sock.write(frame);
      if (!ok) {
        sock.__latestWsFrame = frame;
        if (!sock.__latestDrainBound) {
          sock.__latestDrainBound = true;
          sock.once('drain', () => {
            sock.__latestDrainBound = false;
            flushLatest(sock);
          });
        }
      }
    } catch {
      clients.delete(sock);
      try { sock.destroy(); } catch {}
    }
  }
  if (!clients.size) roomSockets.delete(key);
}

function parseWsFrames(socket, chunk) {
  socket.__wsBuffer = Buffer.concat([socket.__wsBuffer || Buffer.alloc(0), chunk]);
  let buf = socket.__wsBuffer;
  while (buf.length >= 2) {
    const b0 = buf[0], b1 = buf[1], opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
    let len = b1 & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; const n = buf.readBigUInt64BE(2); if (n > BigInt(4 * 1024 * 1024)) { socket.destroy(); return; } len = Number(n); off = 10; }
    let mask = null;
    if (masked) { if (buf.length < off + 4) break; mask = buf.subarray(off, off + 4); off += 4; }
    if (buf.length < off + len) break;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    buf = buf.subarray(off + len);
    if (opcode === 8) { socket.end(); break; }
    if (opcode === 9) { try { const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]); socket.write(pong); } catch {} continue; }
    if (opcode !== 1) continue;
    try {
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.kind !== 'snapshot' || !msg.snapshot) continue;
      const room = getRoom(socket.__roomCode);
      const seq = Number(msg.snapshot.seq || msg.seq || 0);
      if (seq <= Number(room.snapshotSeq || 0)) continue;
      room.snapshotSeq = seq;
      room.snapshot = msg.snapshot;
      room.status = msg.status || room.status;
      if (msg.raceId != null) room.raceId = Number(msg.raceId) || room.raceId;
      touch(room);
      wsBroadcastSnapshot(room, { kind: 'snapshot', raceId: room.raceId, status: room.status, snapshot: room.snapshot }, socket);
    } catch {}
  }
  socket.__wsBuffer = buf;
}
function openSnapshotSocket(req, socket, head, url) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const roomCode = cleanRoom(url.searchParams.get('room'));
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.__roomCode = roomCode; socket.__wsBuffer = Buffer.alloc(0);
  if (!roomSockets.has(roomCode)) roomSockets.set(roomCode, new Set());
  roomSockets.get(roomCode).add(socket);
  socket.on('data', chunk => parseWsFrames(socket, chunk));
  socket.on('close', () => { const set = roomSockets.get(roomCode); if (set) { set.delete(socket); if (!set.size) roomSockets.delete(roomCode); } });
  socket.on('error', () => { try { socket.destroy(); } catch {} });
  if (head && head.length) parseWsFrames(socket, head);
  const room = getRoom(roomCode);
  try { socket.write(wsFrame(JSON.stringify({ kind: 'snapshot', raceId: room.raceId, status: room.status, snapshot: room.snapshot }))); } catch {}
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  try { rel = decodeURIComponent(rel); } catch { return text(res, 400, 'Bad request'); }
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep) && full !== ROOT) return text(res, 403, 'Forbidden');
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) return text(res, 404, 'Not found');
    const type = mime[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store, no-cache, must-revalidate' });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, { ok: true, state: clientState(getRoom(url.searchParams.get('room'))) });
    if (url.pathname === '/api/frame' && req.method === 'GET') {
      const r = getRoom(url.searchParams.get('room'));
      return json(res, 200, {
        ok: true,
        raceId: r.raceId,
        status: r.status,
        raceHostId: r.raceHostId,
        snapshotSeq: r.snapshotSeq || 0,
        snapshot: r.snapshot,
        finishOrder: r.finishOrder,
        winners: r.winners,
        winnerDeclared: r.winnerDeclared,
        winnerPopupAt: r.winnerPopupAt || 0,
        serverNow: now()
      });
    }
    
    if (url.pathname === '/api/events' && req.method === 'GET') return openRoomStream(req, res, url.searchParams.get('room'));
    if (url.pathname === '/api/action' && req.method === 'POST') {
      try { return handleAction(res, await readJson(req)); }
      catch (error) { return json(res, 400, { ok: false, error: error.message || '오류가 발생했습니다.' }); }
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    return json(res, 500, { ok: false, error: '서버 오류가 발생했습니다.' });
  }
});

server.on('upgrade', (req, socket, head) => {
  try { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (url.pathname === '/api/snapshot-stream') return openSnapshotSocket(req, socket, head, url); } catch {}
  socket.destroy();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`YAMYAM Pinball listening on http://0.0.0.0:${PORT}`);
});
