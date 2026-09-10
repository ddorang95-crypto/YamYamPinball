'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const rooms = new Map();

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
  const code = String(value || 'GROUP').replace(/[^A-Za-z0-9_-]/g, '').toUpperCase();
  return code || 'GROUP';
};

function emptySnapshot() {
  return { balls: [], rot: [], gate: 0, cam: 0, camX: 560, camZoom: 0.82 };
}

function newRoom(code) {
  return {
    code,
    mode: 'group',
    title: 'Yamyam Marble Pinball',
    map: 'wheel',
    status: 'lobby',
    participants: [],
    recentPinballs: [],
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
    raceHostId: null,
    startedAt: 0,
    duration: 0,
    updatedAt: now()
  };
}

function getRoom(code) {
  const key = cleanRoom(code);
  if (!rooms.has(key)) rooms.set(key, newRoom(key));
  return rooms.get(key);
}

function touch(room) { room.updatedAt = now(); }

function copyParticipants(list) {
  return (Array.isArray(list) ? list : []).map((p) => ({
    id: String(p.id || crypto.randomUUID()),
    name: String(p.name || '').trim(),
    count: Math.max(1, Number(p.count || 1) | 0),
    owner: String(p.owner || 'ADMIN'),
    ownerInitial: String(p.ownerInitial || '')
  })).filter((p) => p.name);
}

function saveRecentPinball(room) {
  const participants = copyParticipants(room.participants);
  if (!participants.length) return;
  const signature = participants
    .map((p) => [p.owner, p.name, p.count].join('\u0001'))
    .sort()
    .join('\u0002');
  const previous = Array.isArray(room.recentPinballs) ? room.recentPinballs : [];
  const record = {
    id: crypto.randomUUID(),
    savedAt: now(),
    map: room.map,
    winMode: room.winMode,
    winningRanks: [...(room.winningRanks || [1])],
    totalBalls: participants.reduce((sum, p) => sum + p.count, 0),
    participants,
    signature
  };
  room.recentPinballs = [record, ...previous.filter((item) => item.signature !== signature)].slice(0, 3);
}

function backToLobby(room) {
  room.status = 'lobby';
  room.raceBalls = [];
  room.finishOrder = [];
  room.winners = [];
  room.winnerDeclared = false;
  room.snapshot = emptySnapshot();
  room.raceHostId = null;
  room.startedAt = 0;
  room.duration = 0;
}

function randomSeed() {
  return crypto.randomInt(100000, 2147483000);
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': 'https://yamyam-gauge.ddorang95.chatgpt.site',
    'Vary': 'Origin'
  });
  res.end(body);
}

function text(res, status, value, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(value));
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': 'https://yamyam-gauge.ddorang95.chatgpt.site',
    'Vary': 'Origin'
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
  json(res, 200, { ok: true, state: room, ...extra });
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
      room.participants.push({ id: crypto.randomUUID().replace(/-/g, ''), name, owner, count, addedAt: now() });
      backToLobby(room); touch(room); break;
    }
    case 'bulkAdd': {
      if (room.status === 'running') throw new Error('레이스 진행 중에는 추가할 수 없습니다.');
      const owner = String(data.owner || '').trim();
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const name = String(item.name || '').trim();
        const count = Math.max(1, Math.min(5000, Number(item.count) || 1));
        if (name && name.length <= 24) room.participants.push({ id: crypto.randomUUID().replace(/-/g, ''), name, owner, count, addedAt: now() });
      }
      backToLobby(room); touch(room); break;
    }
    case 'syncMvpParticipants': {
      if (room.status === 'running') throw new Error('레이스 진행 중에는 MVP를 등록할 수 없습니다.');
      const merged = new Map();
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const name = String(item && item.name || '').trim().slice(0, 24);
        const owner = String(item && item.owner || '').trim().slice(0, 40);
        const count = Math.floor(Number(item && item.count));
        if (!name || !owner || !Number.isInteger(count) || count < 1 || count > 5000) continue;
        const key = owner.normalize('NFKC').toLocaleLowerCase('ko-KR') + '\\u0000' +
          name.normalize('NFKC').toLocaleLowerCase('ko-KR');
        const current = merged.get(key) || { name, owner, count: 0 };
        current.name = name;
        current.owner = owner;
        current.count = Math.min(5000, current.count + count);
        merged.set(key, current);
      }
      if (!merged.size) throw new Error('등록할 10만원 이상 후원자가 없습니다.');
      const importedKeys = new Set(merged.keys());
      room.participants = room.participants.filter((participant) => {
        const key = String(participant.owner || '').normalize('NFKC').trim().toLocaleLowerCase('ko-KR') + '\\u0000' +
          String(participant.name || '').normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
        return participant.source !== 'MVP_AUTO' && !importedKeys.has(key);
      });
      for (const item of merged.values()) room.participants.push({
        id: crypto.randomUUID().replace(/-/g, ''),
        name: item.name,
        owner: item.owner,
        source: 'MVP_AUTO',
        count: item.count,
        addedAt: now()
      });
      backToLobby(room); room.shuffleNonce += 1; room.seed = randomSeed(); touch(room);
      responseState(res, room, {
        imported: merged.size,
        balls: [...merged.values()].reduce((sum, item) => sum + item.count, 0)
      });
      return;
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
          balls.push({ ballId: `${p.id}_${i}`, participantId: p.id, name: p.name, owner: p.owner, copy: i });
        }
      }
      if (!balls.length) throw new Error('공을 1개 이상 추가해 주세요.');
      saveRecentPinball(room);
      room.raceBalls = balls;
      room.finishOrder = [];
      room.winners = [];
      room.winnerDeclared = false;
      room.snapshot = emptySnapshot();
      room.raceId += 1;
      if (!(room.seed > 0)) room.seed = randomSeed();
      room.startedAt = now() + 250;
      room.duration = 0;
      room.raceHostId = String(data.clientId || '').trim() || null;
      room.status = 'running';
      touch(room);
      json(res, 200, { ok: true, raceId: room.raceId, seed: room.seed, status: room.status, map: room.map, raceHostId: room.raceHostId, winMode: room.winMode, winningRanks: room.winningRanks });
      return;
    }
    case 'snapshot': {
      if (room.status === 'running') {
        room.snapshot = {
          balls: Array.isArray(data.balls) ? data.balls : [],
          rot: Array.isArray(data.rot) ? data.rot : [],
          gate: Number(data.gate || 0),
          cam: Number(data.cam || 0),
          camX: Number(data.camX || 560),
          camZoom: Number(data.camZoom || 0.82)
        };
        touch(room);
      }
      break;
    }
    case 'finishBall': {
      if (room.status === 'running') {
        const id = String(data.ballId || '');
        if (!room.finishOrder.some((x) => x.ballId === id)) {
          const ball = room.raceBalls.find((x) => x.ballId === id);
          if (ball) room.finishOrder.push({ ballId: ball.ballId, name: ball.name, copy: ball.copy, owner: ball.owner, rank: room.finishOrder.length + 1 });
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
          }
        }
        touch(room);
      }
      break;
    }
    case 'completeRace': {
      if (room.status === 'running') { room.status = 'completed'; touch(room); }
      break;
    }
    case 'resetRace': {
      const participants = room.participants;
      backToLobby(room);
      room.participants = participants;
      room.shuffleNonce += 1; room.seed = randomSeed(); touch(room); break;
    }
    case 'restoreRecentPinball': {
      if (room.status === 'running') throw new Error('진행 중인 레이스를 먼저 초기화해 주세요.');
      const historyId = String(data.historyId || '');
      const record = (Array.isArray(room.recentPinballs) ? room.recentPinballs : [])
        .find((item) => item.id === historyId);
      if (!record) throw new Error('복구할 기록을 찾을 수 없습니다.');
      backToLobby(room);
      room.participants = copyParticipants(record.participants);
      if (['wheel', 'greed', 'cascade', 'maze'].includes(record.map)) room.map = record.map;
      if (['first', 'last', 'number'].includes(record.winMode)) room.winMode = record.winMode;
      room.winningRanks = asRanks(record.winningRanks);
      if (!room.winningRanks.length) room.winningRanks = [1];
      room.shuffleNonce += 1; room.seed = randomSeed(); touch(room); break;
    }
    case 'clearParticipants': {
      saveRecentPinball(room);
      backToLobby(room); room.participants = []; room.shuffleNonce += 1; room.seed = randomSeed(); touch(room); break;
    }
    default: throw new Error('지원하지 않는 요청입니다.');
  }

  responseState(res, room);
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
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': 'https://yamyam-gauge.ddorang95.chatgpt.site',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
      });
      return res.end();
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true });
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, { ok: true, state: getRoom(url.searchParams.get('room')) });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`YAMYAM Pinball listening on http://0.0.0.0:${PORT}`);
});
