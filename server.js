'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'game-data.json'), 'utf8'));
const rooms = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function json(res, code, body) {
  const out = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(out);
}

function safeName(v) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  return (s || 'Player').slice(0, 18);
}

function makeId() {
  return crypto.randomBytes(9).toString('hex');
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars[crypto.randomInt(chars.length)];
  } while (rooms.has(code));
  return code;
}

function cleanInt(v, min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function makePlayer(id, profile = {}) {
  const cls = DATA.classes[profile.class] ? profile.class : 'Warrior';
  const base = {
    id,
    name: safeName(profile.name),
    class: cls,
    coins: cleanInt(profile.coins, 0, 1e15),
    maxHp: cleanInt(profile.maxHp, 50, 1e9, 100),
    hp: cleanInt(profile.hp, 0, 1e9, 100),
    damage: cleanInt(profile.damage, 1, 1e12, 20),
    heal: cleanInt(profile.heal, 0, 1e9, 20),
    inventory: Array.isArray(profile.inventory) ? profile.inventory.filter(x => DATA.weapons[x]) : [],
    equipped: DATA.weapons[profile.equipped] ? profile.equipped : null,
    armor: DATA.armor[profile.armor] ? profile.armor : null,
    bonus: 0,
    alive: true,
    stats: {
      battles: 0, victories: 0, defeats: 0, damage: 0, healing: 0,
      coinsEarned: 0, pvpWins: 0, trades: 0, downs: 0, actions: 0
    },
    ready: false,
    highestDefeated: cleanInt(profile.highestDefeated, 0, 999, 0)
  };
  if (!base.inventory.length && DATA.weapons.Axe) {
    base.inventory = ['Axe'];
  }
  if (!base.equipped) base.equipped = base.inventory[0] || 'Axe';
  applyClassAndArmor(base, true);
  base.hp = Math.min(base.maxHp, base.hp || base.maxHp);
  return base;
}

function classData(p) { return DATA.classes[p.class] || DATA.classes.Warrior; }
function armorData(p) { return p.armor ? (DATA.armor[p.armor] || { damage: 0, hp: 0, heal: 0 }) : { damage: 0, hp: 0, heal: 0 }; }

function applyClassAndArmor(p, recalcHp = false) {
  const c = classData(p), a = armorData(p);
  const baseHp = Math.max(50, cleanInt(p.maxHp));
  p.effectiveMaxHp = Math.max(1, Math.trunc((baseHp + a.hp) * c.hpMult));
  p.effectiveDamage = Math.max(1, Math.trunc((p.damage + (DATA.weapons[p.equipped]?.damage || 0) + a.damage) * c.damageMult));
  p.effectiveHeal = Math.max(0, Math.trunc((p.heal + a.heal) * c.healMult));
  if (recalcHp) p.hp = Math.min(p.effectiveMaxHp, Math.max(0, p.hp));
}

function playerSnapshot(p) {
  applyClassAndArmor(p, false);
  return {
    id: p.id, name: p.name, class: p.class, coins: p.coins,
    maxHp: p.effectiveMaxHp, hp: p.hp, damage: p.effectiveDamage,
    heal: p.effectiveHeal, baseMaxHp: p.maxHp, baseDamage: p.damage, baseHeal: p.heal,
    inventory: p.inventory, equipped: p.equipped,
    armor: p.armor, bonus: p.bonus, alive: p.alive, highestDefeated: p.highestDefeated || 0, stats: p.stats
  };
}

function newRoom(hostProfile) {
  const code = roomCode();
  const id = makeId();
  const host = makePlayer(id, hostProfile);
  const room = {
    code,
    hostId: id,
    mode: 'lobby',
    players: new Map([[id, host]]),
    battle: null,
    messages: [],
    updatedAt: Date.now(),
    createdAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function postMessage(room, text) {
  room.messages.push({ id: makeId(), text: String(text).slice(0, 240), at: Date.now() });
  room.messages = room.messages.slice(-30);
}

function availableEnemy(room, enemyId) {
  const enemy = DATA.normalEnemies[String(enemyId)];
  if (!enemy) return null;
  const players = [...room.players.values()];
  if (!players.length) return null;
  const allUnlocked = players.every(p => Number(enemyId) <= 12 || Number(enemyId) <= cleanInt(p.highestDefeated, 0, 999, 0) + 1);
  if (!allUnlocked) return null;
  return { ...enemy, id: Number(enemyId) };
}

function startBattle(room, mode, enemyId, difficulty) {
  const players = [...room.players.values()];
  if (mode === 'pvp' && players.length !== 2) throw new Error('PvP needs exactly 2 players.');
  if ((mode === 'coop' || mode === 'endless') && players.length < 2) throw new Error('Co-op needs at least 2 players.');
  if (mode === 'coop') {
    const e = availableEnemy(room, enemyId);
    if (!e) throw new Error('That enemy is locked or invalid.');
    room.battle = {
      type: 'coop', enemyId: e.id, enemyName: e.name, enemyMaxHp: e.hp, enemyHp: e.hp,
      enemyDamage: e.damage, enemyHeal: e.heal, enemyReward: e.reward,
      turnIndex: 0, wave: 0, difficulty: null, log: [`⚔ ${e.name} appeared!`], over: false,
      contributions: {}
    };
    players.forEach(p => { applyClassAndArmor(p, true); p.hp = p.effectiveMaxHp; p.alive = true; p.bonus = 0; p.stats.battles++; });
  } else if (mode === 'endless') {
    const d = DATA.endless[difficulty] ? difficulty : 'Hard';
    room.battle = { type: 'endless', wave: 1, difficulty: d, ...makeEndlessEnemy(1, d), turnIndex: 0, log: [`♾ Endless ${d} started! Wave 1.`], over: false, contributions: {} };
    players.forEach(p => { applyClassAndArmor(p, true); p.hp = p.effectiveMaxHp; p.alive = true; p.bonus = 0; p.stats.battles++; });
  } else if (mode === 'pvp') {
    room.battle = { type: 'pvp', turnIndex: 0, log: ['⚔ PvP match started!'], over: false };
    players.forEach(p => { applyClassAndArmor(p, true); p.hp = p.effectiveMaxHp; p.alive = true; p.bonus = 0; p.stats.battles++; });
  }
  room.mode = mode;
  room.updatedAt = Date.now();
}

function makeEndlessEnemy(wave, difficulty) {
  const base = DATA.endless[difficulty] || DATA.endless.Hard;
  const index = (wave - 1) % DATA.endlessNames.length;
  const scale = base.hp * Math.pow(base.growth, Math.max(0, wave - 1));
  const dmg = base.damage * Math.pow(base.damageGrowth, Math.max(0, wave - 1));
  const reward = base.reward * Math.pow(base.rewardGrowth, Math.max(0, wave - 1));
  const name = DATA.endlessNames[index] || 'Endless Monster';
  return {
    enemyId: 1000 + wave,
    enemyName: `${name} — Wave ${wave}`,
    enemyMaxHp: Math.max(1, Math.trunc(scale)),
    enemyHp: Math.max(1, Math.trunc(scale)),
    enemyDamage: Math.max(1, Math.trunc(dmg)),
    enemyHeal: Math.max(0, Math.trunc(dmg * 0.65)),
    enemyReward: Math.max(1, Math.trunc(reward))
  };
}

function alivePlayers(room) { return [...room.players.values()].filter(p => p.alive && p.hp > 0); }
function turnPlayer(room) {
  const list = [...room.players.values()];
  if (!list.length) return null;
  for (let i = 0; i < list.length; i++) {
    const idx = (room.battle.turnIndex + i) % list.length;
    if (list[idx].alive && list[idx].hp > 0) return list[idx];
  }
  return null;
}

function nextTurn(room) {
  const list = [...room.players.values()];
  if (!list.length) return;
  room.battle.turnIndex = (room.battle.turnIndex + 1) % list.length;
  for (let i = 0; i < list.length; i++) {
    const p = turnPlayer(room);
    if (p) return;
    room.battle.turnIndex = (room.battle.turnIndex + 1) % list.length;
  }
}

function rewardPlayer(p, amount) {
  p.coins += amount;
  p.stats.coinsEarned += amount;
}

function finishCoop(room, victory) {
  const b = room.battle;
  b.over = true;
  if (victory) {
    for (const p of room.players.values()) {
      rewardPlayer(p, b.enemyReward);
      p.stats.victories++;
      p.highestDefeated = Math.max(cleanInt(p.highestDefeated), b.enemyId);
    }
    postMessage(room, `🏆 Team defeated ${b.enemyName}! Each player earned ${formatNumber(b.enemyReward)} coins.`);
  } else {
    for (const p of room.players.values()) p.stats.defeats++;
    postMessage(room, '💀 The team was defeated.');
  }
}

function maybeEnemyTurn(room) {
  const b = room.battle;
  if (!b || b.over || (b.type !== 'coop' && b.type !== 'endless')) return;
  const target = turnPlayer(room);
  if (!target) {
    finishCoop(room, false);
    return;
  }
  // Enemy acts after the player's action.
  const variance = 0.9 + (crypto.randomInt(201) / 1000); // 0.900 to 1.100
  const dealt = Math.max(1, Math.trunc(b.enemyDamage * variance));
  target.hp = Math.max(0, target.hp - dealt);
  target.stats.downs += target.hp === 0 ? 1 : 0;
  if (target.hp === 0) target.alive = false;
  b.log.push(`👹 ${b.enemyName} dealt ${formatNumber(dealt)} damage to ${target.name}.`);
  if (b.enemyHp > 0 && b.enemyHeal > 0 && crypto.randomInt(100) < 8) {
    const h = Math.min(b.enemyMaxHp - b.enemyHp, b.enemyHeal);
    if (h > 0) {
      b.enemyHp += h;
      b.log.push(`👹 ${b.enemyName} healed ${formatNumber(h)} HP.`);
    }
  }
  nextTurn(room);
  if (!alivePlayers(room).length) finishCoop(room, false);
}

function doCoopAction(room, playerId, action) {
  const b = room.battle;
  const p = room.players.get(playerId);
  if (!b || b.over) throw new Error('No active battle.');
  if (!p || !p.alive) throw new Error('You are down.');
  const active = turnPlayer(room);
  if (!active || active.id !== playerId) throw new Error('It is not your turn.');
  applyClassAndArmor(p, true);

  if (action === 'attack') {
    let dmg = p.effectiveDamage;
    let msg = `${p.name} attacked for ${formatNumber(dmg)}.`;
    if (p.equipped === 'Katana' || p.equipped === 'RPG') {
      if (crypto.randomInt(100) < 10) { dmg *= 2; msg = `💥 CRITICAL! ${p.name} dealt ${formatNumber(dmg)} damage.`; }
    } else if (p.equipped === 'Bow' && crypto.randomInt(100) < 16) {
      dmg *= 2; msg = `🏹 DOUBLE HIT! ${p.name} dealt ${formatNumber(dmg)} damage.`;
    }
    dmg = Math.max(1, Math.trunc(dmg * (1 + p.bonus / 100)));
    b.enemyHp = Math.max(0, b.enemyHp - dmg);
    p.stats.damage += dmg; p.stats.actions++;
    b.contributions[p.id] = b.contributions[p.id] || { damage: 0, healing: 0, name: p.name };
    b.contributions[p.id].damage += dmg;
    b.log.push(msg);
    p.bonus = 0;
  } else if (action === 'heal') {
    const before = p.hp;
    p.hp = Math.min(p.effectiveMaxHp, p.hp + p.effectiveHeal);
    const healed = p.hp - before;
    p.stats.healing += healed; p.stats.actions++;
    b.contributions[p.id] = b.contributions[p.id] || { damage: 0, healing: 0, name: p.name };
    b.contributions[p.id].healing += healed;
    b.log.push(`💚 ${p.name} healed ${formatNumber(healed)} HP.`);
    p.bonus = 0;
  } else if (action === 'super') {
    p.bonus += 50; p.stats.actions++;
    b.log.push(`⚡ ${p.name} built a +${p.bonus}% damage bonus.`);
  } else if (action === 'run') {
    p.stats.defeats++;
    b.over = true;
    b.log.push(`🏃 ${p.name} fled the battle.`);
    room.mode = 'lobby';
    return;
  } else throw new Error('Unknown action.');

  if (b.enemyHp <= 0) {
    if (b.type === 'endless') {
      for (const q of room.players.values()) rewardPlayer(q, b.enemyReward);
      b.log.push(`🏆 Wave ${b.wave} cleared! Each player earned ${formatNumber(b.enemyReward)} coins.`);
      b.wave++;
      Object.assign(b, makeEndlessEnemy(b.wave, b.difficulty));
      for (const q of room.players.values()) { applyClassAndArmor(q, true); q.hp = q.effectiveMaxHp; q.alive = true; q.bonus = 0; }
      b.turnIndex = 0;
      b.log.push(`♾ Wave ${b.wave}: ${b.enemyName} appeared.`);
    } else {
      finishCoop(room, true);
    }
    return;
  }
  maybeEnemyTurn(room);
}

function doPvpAction(room, playerId, action) {
  const b = room.battle, p = room.players.get(playerId);
  if (!b || b.type !== 'pvp' || b.over) throw new Error('No active PvP match.');
  if (!p) throw new Error('Player not found.');
  const active = turnPlayer(room);
  if (!active || active.id !== playerId) throw new Error('It is not your turn.');
  const other = [...room.players.values()].find(x => x.id !== playerId);
  applyClassAndArmor(p, true);
  if (action === 'attack') {
    let dmg = Math.max(1, p.effectiveDamage + Math.trunc(p.effectiveDamage * p.bonus / 100));
    other.hp = Math.max(0, other.hp - dmg);
    p.stats.damage += dmg; p.stats.actions++;
    b.log.push(`⚔ ${p.name} hit ${other.name} for ${formatNumber(dmg)}.`);
    p.bonus = 0;
  } else if (action === 'heal') {
    const before = p.hp;
    p.hp = Math.min(p.effectiveMaxHp, p.hp + p.effectiveHeal);
    const healed = p.hp - before;
    p.stats.healing += healed; p.stats.actions++;
    b.log.push(`💚 ${p.name} healed ${formatNumber(healed)} HP.`);
    p.bonus = 0;
  } else if (action === 'super') {
    p.bonus += 50; p.stats.actions++;
    b.log.push(`⚡ ${p.name} now has +${p.bonus}% damage.`);
  } else if (action === 'run') {
    b.over = true; p.stats.defeats++; other.stats.victories++; other.stats.pvpWins++;
    b.winnerId = other.id; b.log.push(`🏃 ${p.name} fled. ${other.name} wins.`); return;
  } else throw new Error('Unknown action.');
  if (other.hp <= 0) {
    b.over = true; other.alive = false; p.stats.victories++; p.stats.pvpWins++; b.winnerId = p.id;
    b.log.push(`🏆 ${p.name} won the PvP match!`);
  } else nextTurn(room);
}

function serializeRoom(room, viewerId) {
  const players = [...room.players.values()].map(playerSnapshot);
  const b = room.battle ? JSON.parse(JSON.stringify(room.battle)) : null;
  const active = b ? turnPlayer(room) : null;
  if (b) b.activePlayerId = active?.id || null;
  const contributions = b?.contributions || {};
  let carried = null;
  if (b && Object.keys(contributions).length) {
    carried = Object.values(contributions).map(c => ({ ...c, contribution: c.damage + c.healing })).sort((a, z) => z.contribution - a.contribution)[0] || null;
  }
  return {
    code: room.code,
    hostId: room.hostId,
    viewerId,
    mode: room.mode,
    players,
    battle: b ? { ...b, carried } : null,
    messages: room.messages.slice(-20),
    serverTime: Date.now()
  };
}

function formatNumber(n) {
  const x = Number(n) || 0;
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(x);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 200_000) { reject(new Error('Request too large.')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function profileFromBody(body) {
  return {
    name: body.name, class: body.class, coins: body.coins, maxHp: body.maxHp,
    hp: body.hp, damage: body.damage, heal: body.heal, inventory: body.inventory,
    equipped: body.equipped, armor: body.armor, highestDefeated: body.highestDefeated
  };
}

function syncProfile(room, playerId, body) {
  const old = room.players.get(playerId);
  if (!old) throw new Error('Player not found.');
  const incoming = makePlayer(playerId, profileFromBody(body));
  incoming.stats = old.stats;
  incoming.ready = old.ready;
  incoming.highestDefeated = old.highestDefeated || 0;
  room.players.set(playerId, incoming);
  room.updatedAt = Date.now();
}

function handleAction(body) {
  const room = rooms.get(String(body.room || '').toUpperCase());
  if (!room) throw new Error('Room not found.');
  const p = room.players.get(body.player);
  if (!p) throw new Error('Player not found.');
  const action = body.action;

  if (action === 'sync_profile') {
    syncProfile(room, p.id, body.profile || body);
    postMessage(room, `${room.players.get(p.id).name} joined the room.`);
  } else if (action === 'set_mode') {
    if (p.id !== room.hostId) throw new Error('Only the host can change the mode.');
    const mode = ['coop', 'pvp', 'endless'].includes(body.mode) ? body.mode : 'coop';
    if (mode === 'pvp' && room.players.size !== 2) throw new Error('PvP needs exactly 2 players.');
    room.mode = mode;
    room.battle = null;
  } else if (action === 'start') {
    if (p.id !== room.hostId) throw new Error('Only the host can start the match.');
    startBattle(room, room.mode, cleanInt(body.enemyId, 1, 23, 1), body.difficulty);
  } else if (action === 'battle') {
    if (room.mode === 'pvp') doPvpAction(room, p.id, body.move);
    else doCoopAction(room, p.id, body.move);
  } else if (action === 'trade_offer') {
    const target = room.players.get(body.target);
    const coins = cleanInt(body.coins, 0, 1e15, 0);
    const item = String(body.item || '');
    if (!target || target.id === p.id) throw new Error('Invalid trade target.');
    if (coins > p.coins) throw new Error('Not enough coins.');
    if (item && !p.inventory.includes(item)) throw new Error('You do not own that item.');
    room.trade = { id: makeId(), from: p.id, to: target.id, coins, item };
    postMessage(room, `${p.name} sent a trade offer to ${target.name}.`);
  } else if (action === 'trade_answer') {
    const t = room.trade;
    if (!t || t.to !== p.id) throw new Error('No trade offer for you.');
    const from = room.players.get(t.from);
    if (!from) throw new Error('Trader left the room.');
    if (body.accept) {
      if (t.coins > from.coins || (t.item && !from.inventory.includes(t.item))) throw new Error('Trade offer is no longer available.');
      from.coins -= t.coins; p.coins += t.coins;
      if (t.item) { from.inventory = from.inventory.filter(x => x !== t.item); if (from.equipped === t.item) from.equipped = null; p.inventory.push(t.item); }
      from.stats.trades++; p.stats.trades++;
      postMessage(room, `🤝 ${from.name} traded with ${p.name}.`);
    } else postMessage(room, `↩️ ${p.name} declined ${from.name}'s trade.`);
    room.trade = null;
  } else if (action === 'leave') {
    room.players.delete(p.id);
    postMessage(room, `${p.name} left the room.`);
    if (p.id === room.hostId) {
      const first = room.players.values().next().value;
      if (first) room.hostId = first.id;
    }
    if (!room.players.size) rooms.delete(room.code);
  } else throw new Error('Unknown action.');

  room.updatedAt = Date.now();
}

function requestPath(req) {
  try { return new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; }
  catch { return '/'; }
}

async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/room/create') {
      const body = await parseBody(req); const room = newRoom(body); return json(res, 200, { room: room.code, player: room.hostId, state: serializeRoom(room, room.hostId) });
    }
    if (req.method === 'POST' && url.pathname === '/api/room/join') {
      const body = await parseBody(req); const code = String(body.room || '').toUpperCase(); const room = rooms.get(code);
      if (!room) return json(res, 404, { error: 'Room not found.' });
      if (room.players.size >= 3) return json(res, 409, { error: 'Room is full (3 players maximum).' });
      if (room.battle && !room.battle.over) return json(res, 409, { error: 'That room is already in a match.' });
      const id = makeId(); const p = makePlayer(id, body); room.players.set(id, p); postMessage(room, `${p.name} joined the room.`); room.updatedAt = Date.now();
      return json(res, 200, { room: room.code, player: id, state: serializeRoom(room, id) });
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await parseBody(req); handleAction(body); const room = rooms.get(String(body.room || '').toUpperCase());
      if (!room) return json(res, 200, { ok: true, roomClosed: true });
      return json(res, 200, { ok: true, state: serializeRoom(room, body.player) });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const code = String(url.searchParams.get('room') || '').toUpperCase(); const player = url.searchParams.get('player') || '';
      const room = rooms.get(code); if (!room) return json(res, 404, { error: 'Room not found.' });
      if (!room.players.has(player)) return json(res, 403, { error: 'Player not in room.' });
      return json(res, 200, serializeRoom(room, player));
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (err) {
    return json(res, 400, { error: err?.message || 'Request failed.' });
  }
}

const server = http.createServer((req, res) => {
  if (requestPath(req).startsWith('/api/')) return api(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
  let pathname = requestPath(req);
  if (pathname === '/') pathname = '/index.html';
  const safe = path.normalize(pathname).replace(/^([.][.][\\/])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden.' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'File not found.' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.updatedAt > 2 * 60 * 60 * 1000) rooms.delete(code);
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, HOST, () => console.log(`CoolRPG Web running on http://${HOST}:${PORT}`));
