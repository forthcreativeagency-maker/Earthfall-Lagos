// =================================================================
// EARTHFALL — Multiplayer Server
// EarthCoins economy · voice relay · character selection · betting
// =================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', 1);   // ← add this line
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
  pingInterval: 10000,
  maxHttpBufferSize: 5e5,
});

app.use(express.static(path.join(__dirname, 'public')));

const rateLimit = require('express-rate-limit');

// Rate-limit payment endpoints so a bot can't spam Paystack
app.use('/paystack/initialize', rateLimit({
  windowMs: 60 * 1000,     // 1 minute
  max: 10,                 // 10 requests per minute per IP
  message: { error: 'Too many requests, slow down' },
}));
app.use('/paystack/verify', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
}));
app.use('/paystack/webhook', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
}));

// Logs directory
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
const FLAGGED_LOG = path.join(LOG_DIR, 'flagged-messages.log');
const COIN_LOG = path.join(LOG_DIR, 'coin-transactions.log');

// =================================================================
// CONFIG
// =================================================================
const CONFIG = {
  MAX_PLAYERS_PER_ROOM: 12,
  MAX_ROOMS: 500,
  ROOM_CODE_LENGTH: 4,
  ROOM_IDLE_TIMEOUT_MS: 30 * 60 * 1000,
  NAME_MAX_LENGTH: 16,
  MESSAGE_MAX_LENGTH: 200,
  REJOIN_WINDOW_MS: 60 * 1000,
  VOICE_B64_MAX_LENGTH: 200000,
  VOICE_DURATION_MAX_MS: 60000,

  // ------- EarthCoins economy -------
  STARTING_COINS: 1000,
  MIN_BET: 100,
  MAX_BET: 5000,
  WINNER_SHARE: 0.40,
  SIDE_BETTOR_SHARE: 0.60,

  ENTRY_FEE_GROUP: 5,
  ENTRY_FEE_SOLO: 2,

  // Milestone rewards (group mode — stackable)
  REWARD_MILESTONE_1: 5,    // reached 1500m
  REWARD_MILESTONE_2: 10,   // reached 6000m (sun fall)
  REWARD_MILESTONE_3: 15,   // reached 9500m (past rush)
  REWARD_MOON_GROUP: 40,    // reached moon (group)

  // Solo — flat moon payout (does not stack)
  REWARD_MOON_SOLO: 40,
  SOLO_STACK_MILESTONES: true,   // 5/10/15 do still stack in solo; only moon is flat

  // Altitude thresholds (in meters)
  MILESTONE_1_M: 1500,
  MILESTONE_2_M: 6000,
  MILESTONE_3_M: 9500,
  MOON_M: 48000,

  // Free-entry fallback
  FREE_ENTRY_PER_DAY: 1,
  FREE_ENTRY_COOLDOWN_MS: 24 * 60 * 60 * 1000,   // 24h

  // Player-to-player transfers
  TRANSFER_MIN: 1,
  TRANSFER_MAX: 100000,

  // [JUMP-MODE] Game mode config
  GAME_MODES: ['climb', 'jump'],
  DEFAULT_GAME_MODE: 'climb',
  GAME_MODE_NAMES: { climb: 'THE CLIMB', jump: 'THE JUMP' },
  // [JUMP-MODE] Jump-specific economy (independent from Climb)
  JUMP_MILESTONE_1_M: 1000,
  JUMP_MILESTONE_2_M: 4000,
  JUMP_MILESTONE_3_M: 8000,
  JUMP_MOON_M: 18000,
};

const ALLOWED_CHARACTERS = ['normal_m', 'normal_f', 'agbero', 'tech', 'police'];

// =================================================================
// POWER-UPS CATALOG (single source of truth)
// =================================================================
const POWERUPS = {
  shield: {
    id: 'shield',
    label: 'Shield',
    icon: '🛡',
    price: 200,
    description: 'Blocks one debris hit. Consumed on use.',
  },
  flask: {
    id: 'flask',
    label: 'Full Flask',
    icon: '💧',
    price: 100,
    description: 'Instantly restores grip strength to 100%.',
  },
  speed: {
    id: 'speed',
    label: 'Speed Boost',
    icon: '⚡',
    price: 150,
    description: 'Climb 70% faster for 8 seconds without extra grip drain.',
    durationMs: 8000,
  },
  magnet: {
    id: 'magnet',
    label: 'Magnet',
    icon: '🧲',
    price: 250,
    description: 'Auto-collect every rain drop for 10 seconds.',
    durationMs: 10000,
  },
  phase: {
    id: 'phase',
    label: 'Phase',
    icon: '👻',
    price: 300,
    description: 'Pass through debris for 6 seconds.',
    durationMs: 6000,
  },
};

function isValidPowerupId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(POWERUPS, id);
}

// =================================================================
// SESSION TOKENS
// =================================================================
function makeSessionToken() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

// =================================================================
// CHAT MODERATION
// =================================================================
const FLAGGED_TERMS = [
  'murder', 'kill you', 'kill u', 'kill myself', 'kys',
  'stab', 'shoot you', 'gun', 'weapon',
  'kidnap', 'abduct', 'traffick', 'sex traffic',
  'suicide', 'cut myself', 'end my life',
  'rape', 'molest', 'pedo', 'child porn', 'cp',
  'i will find you', 'i know where you live',
  'bomb', 'explosive',
  'nigger', 'faggot', 'kike', 'chink',
];

function normalizeForFilter(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[.\-_ ]+/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/@/g, 'a').replace(/\$/g, 's');
}

function checkMessage(text) {
  const normalized = normalizeForFilter(text);
  for (const term of FLAGGED_TERMS) {
    const termNorm = normalizeForFilter(term);
    if (!termNorm) continue;
    if (normalized.includes(termNorm)) return { flagged: true, term };
  }
  return { flagged: false };
}

function logFlagged(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFile(FLAGGED_LOG, line, err => { if (err) console.error('log err:', err); });
}

function logCoin(entry) {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFile(COIN_LOG, line, err => { if (err) console.error('coin log err:', err); });
}
// =================================================================
// ROOM MANAGEMENT
// =================================================================
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < CONFIG.ROOM_CODE_LENGTH; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function makeUniqueRoomCode() {
  let code = generateRoomCode();
  let safety = 0;
  while (rooms.has(code) && safety < 200) {
    code = generateRoomCode();
    safety++;
  }
  return code;
}

function makeRoom(hostId) {
  const code = makeUniqueRoomCode();
  const room = {
    code,
    players: new Map(),
    recent: new Map(),
    bets: new Map(),
    betHistory: [],
    payoutResolved: false,
    entryCharged: false,
    createdAt: Date.now(),
    lastActive: Date.now(),
    state: 'lobby',
    hostId,
    isSolo: false,
    // [JUMP-MODE] Game mode fields — default to Climb, so existing behavior
    // is preserved byte-for-byte for rooms that never vote.
    gameMode: CONFIG.DEFAULT_GAME_MODE,
    gameModeVotes: new Map(),   // playerId -> 'climb' | 'jump'
    // [JUMP-MODE] Solo-in-room choice (does NOT lock the room's gameMode)
    soloModeChoice: null,       // 'climb' | 'jump' | null
  };
  rooms.set(code, room);
  return room;
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    ready: p.ready,
    color: p.color,
    worldY: p.worldY,
    ropeIndex: p.ropeIndex,
    alive: p.alive,
    altitude: p.altitude,
    finished: p.finished,
    character: p.character || 'normal_m',
    coins: p.coins,
  };
}

function roomSummary(room) {
  return {
    code: room.code,
    playerCount: room.players.size,
    maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
    state: room.state,
  };
}

function findOpenRoom() {
  for (const room of rooms.values()) {
    if (room.state === 'lobby' && !room.isSolo &&
        room.players.size < CONFIG.MAX_PLAYERS_PER_ROOM) {
      return room;
    }
  }
  return null;
}

function pickFreeRopeIndex(room) {
  const counts = [0, 0, 0, 0, 0];
  for (const p of room.players.values()) {
    if (p.ropeIndex >= 0 && p.ropeIndex < 5) counts[p.ropeIndex]++;
  }
  let best = 0;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] < counts[best]) best = i;
  }
  return best;
}

// =================================================================
// [JUMP-MODE] GAME MODE VOTING HELPERS
// =================================================================
function tallyGameModeVotes(room) {
  const counts = { climb: 0, jump: 0 };
  for (const vote of room.gameModeVotes.values()) {
    if (vote === 'climb' || vote === 'jump') counts[vote]++;
  }
  return counts;
}

// Returns the winner of the current vote, or null if tied / no votes.
function winningGameMode(room) {
  const counts = tallyGameModeVotes(room);
  if (counts.climb === counts.jump) return null;
  return counts.climb > counts.jump ? 'climb' : 'jump';
}

// Is one side strictly ahead AND has at least one vote? (majority signal)
function gameModeLocked(room) {
  return winningGameMode(room) !== null;
}

function broadcastGameModeUpdate(room) {
  if (!room) return;
  const counts = tallyGameModeVotes(room);
  io.to(room.code).emit('gameModeUpdate', {
    gameMode: room.gameMode,
    votes: counts,
    locked: gameModeLocked(room),
    winning: winningGameMode(room),
  });
}

// =================================================================
// EARTHCOINS ECONOMY HELPERS
// =================================================================

function canAffordEntry(p, isSolo) {
  const fee = isSolo ? CONFIG.ENTRY_FEE_SOLO : CONFIG.ENTRY_FEE_GROUP;
  return p.coins >= fee;
}

function chargeEntryFee(p, isSolo, roomCode) {
  const fee = isSolo ? CONFIG.ENTRY_FEE_SOLO : CONFIG.ENTRY_FEE_GROUP;
  p.coins -= fee;
  logCoin({
    type: 'entry_fee', playerId: p.id, playerName: p.name,
    amount: -fee, balance: p.coins, roomCode, mode: isSolo ? 'solo' : 'group',
  });
  return fee;
}

function grantDailyFreeEntry(p) {
  const now = Date.now();
  const lastFree = p.lastFreeEntryAt || 0;
  if (now - lastFree < CONFIG.FREE_ENTRY_COOLDOWN_MS) {
    return false;   // still in cooldown
  }
  p.lastFreeEntryAt = now;
  p.hasUsedFreeEntryToday = true;
  logCoin({
    type: 'free_entry_granted', playerId: p.id, playerName: p.name,
    balance: p.coins,
  });
  return true;
}

function isFreeEntryAvailable(p) {
  const now = Date.now();
  const lastFree = p.lastFreeEntryAt || 0;
  return now - lastFree >= CONFIG.FREE_ENTRY_COOLDOWN_MS;
}

// Milestone rewards — computed as a delta from the last altitude the
// player crossed. Called every altitude update during a race.
function computeMilestoneRewards(room, player, newAltitude) {
  if (!player.milestoneState) {
    player.milestoneState = {
      m1: false, m2: false, m3: false, moon: false,
      rewardThisRace: 0,
    };
  }
  const ms = player.milestoneState;
  let totalGranted = 0;

  // [JUMP-MODE] Use the correct thresholds depending on which game is
  // running in this room. Jump has its own shorter altitude curve
  // (1000/4000/8000) so it must not be gated on the Climb thresholds.
  const isJump = room.gameMode === 'jump';
  const M1 = isJump ? CONFIG.JUMP_MILESTONE_1_M : CONFIG.MILESTONE_1_M;
  const M2 = isJump ? CONFIG.JUMP_MILESTONE_2_M : CONFIG.MILESTONE_2_M;
  const M3 = isJump ? CONFIG.JUMP_MILESTONE_3_M : CONFIG.MILESTONE_3_M;

  if (!ms.m1 && newAltitude >= M1) {
    ms.m1 = true;
    totalGranted += CONFIG.REWARD_MILESTONE_1;
  }
  if (!ms.m2 && newAltitude >= M2) {
    ms.m2 = true;
    totalGranted += CONFIG.REWARD_MILESTONE_2;
  }
  if (!ms.m3 && newAltitude >= M3) {
    ms.m3 = true;
    totalGranted += CONFIG.REWARD_MILESTONE_3;
  }

  if (totalGranted > 0) {
    player.coins += totalGranted;
    ms.rewardThisRace += totalGranted;
    logCoin({
      type: 'milestone_reward',
      mode: isJump ? 'jump' : 'climb',
      playerId: player.id, playerName: player.name,
      amount: totalGranted, balance: player.coins, roomCode: room.code,
    });
  }

  return totalGranted;
}

// Full run reward — called when a player wins (reaches the moon).
// Solo: moon reward is flat (5/10/15 do not apply if milestones were already
//       granted during the run — they were, so only the moon payout is added).
// Group: moon reward stacks on top of milestone payouts.
function grantMoonReward(room, player) {
  const isSolo = room.isSolo;
  const reward = isSolo ? CONFIG.REWARD_MOON_SOLO : CONFIG.REWARD_MOON_GROUP;
  player.coins += reward;
  logCoin({
    type: isSolo ? 'moon_reward_solo' : 'moon_reward_group',
    playerId: player.id, playerName: player.name,
    amount: reward, balance: player.coins, roomCode: room.code,
  });
  return reward;
}

function resetMilestoneState(player) {
  player.milestoneState = {
    m1: false, m2: false, m3: false, moon: false,
    rewardThisRace: 0,
  };
}

// Player-to-player transfer
function transferCoins(room, fromPlayer, toPlayer, amount) {
  if (!fromPlayer || !toPlayer) return { ok: false, error: 'Player not found' };
  if (fromPlayer.id === toPlayer.id) return { ok: false, error: 'Cannot transfer to yourself' };
  const amt = Math.floor(Number(amount) || 0);
  if (amt < CONFIG.TRANSFER_MIN) return { ok: false, error: `Minimum transfer is ${CONFIG.TRANSFER_MIN}` };
  if (amt > CONFIG.TRANSFER_MAX) return { ok: false, error: `Maximum transfer is ${CONFIG.TRANSFER_MAX}` };
  if (fromPlayer.coins < amt) return { ok: false, error: 'Not enough coins' };

  fromPlayer.coins -= amt;
  toPlayer.coins += amt;

  logCoin({
    type: 'transfer', fromId: fromPlayer.id, fromName: fromPlayer.name,
    toId: toPlayer.id, toName: toPlayer.name, amount: amt,
    fromBalance: fromPlayer.coins, toBalance: toPlayer.coins,
    roomCode: room.code,
  });

  // Ensure both players exist in the db before writing, so the write never
  // silently no-ops on auto-matched players or players who joined before
  // the db layer was added.
  try {
    if (!db.getPlayer(fromPlayer.id)) {
      db.createPlayer({ id: fromPlayer.id, name: fromPlayer.name, coins: fromPlayer.coins + amt, character: fromPlayer.character || 'normal_m' });
    }
    if (!db.getPlayer(toPlayer.id)) {
      db.createPlayer({ id: toPlayer.id, name: toPlayer.name, coins: toPlayer.coins - amt, character: toPlayer.character || 'normal_m' });
    }
    db.addCoins(fromPlayer.id, -amt, 'transfer_sent', { toName: toPlayer.name, roomCode: room.code });
    db.addCoins(toPlayer.id, amt, 'transfer_received', { fromName: fromPlayer.name, roomCode: room.code });
  } catch (e) {
    console.error('[db] transfer persist failed:', e.message);
  }

  return { ok: true, fromBalance: fromPlayer.coins, toBalance: toPlayer.coins };
}

// =================================================================
// AUTH TOKEN CLEANUP (purge expired tokens hourly)
// =================================================================
setInterval(() => {
  try { db.purgeExpiredAuthTokens(); } catch (e) { console.error('[auth] purge failed:', e.message); }
}, 60 * 60 * 1000);

// =================================================================
// IDLE SWEEP
// =================================================================
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const [tok, entry] of room.recent) {
      if (now - entry.leftAt > CONFIG.REJOIN_WINDOW_MS) {
        room.recent.delete(tok);
      }
    }
    const idle = now - room.lastActive > CONFIG.ROOM_IDLE_TIMEOUT_MS;
    const emptyAndNoRecent = room.players.size === 0 && room.recent.size === 0;
    if (idle || emptyAndNoRecent) {
      io.to(code).emit('roomClosed', { reason: idle ? 'idle' : 'empty' });
      rooms.delete(code);
      console.log(`[room ${code}] closed (${idle ? 'idle' : 'empty'})`);
    }
  }
}, 30 * 1000);
// =================================================================
// SOCKET HANDLING
// =================================================================
io.on('connection', socket => {
  console.log('[connect]', socket.id);

  let currentRoomCode = null;
  let playerName = 'Climber';
  let playerCharacter = 'normal_m';

  function currentRoom() {
    if (!currentRoomCode) return null;
    return rooms.get(currentRoomCode) || null;
  }

  function sendLobbyStateTo(socketTarget) {
    const room = currentRoom();
    if (!room) return;
    socketTarget.emit('lobbyState', {
      roomCode: room.code,
      hostId: room.hostId,
      state: room.state,
      players: Array.from(room.players.values()).map(publicPlayer),
      maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
      bets: betsToObject(room),
      betHistory: room.betHistory.slice(-20),
      // [JUMP-MODE]
      gameMode: room.gameMode,
      gameModeVotes: tallyGameModeVotes(room),
      gameModeLocked: gameModeLocked(room),
      gameModeWinning: winningGameMode(room),
    });
  }

  function broadcastLobbyState() {
    const room = currentRoom();
    if (!room) return;
    io.to(room.code).emit('lobbyState', {
      roomCode: room.code,
      hostId: room.hostId,
      state: room.state,
      players: Array.from(room.players.values()).map(publicPlayer),
      maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
      bets: betsToObject(room),
      betHistory: room.betHistory.slice(-20),
      // [JUMP-MODE]
      gameMode: room.gameMode,
      gameModeVotes: tallyGameModeVotes(room),
      gameModeLocked: gameModeLocked(room),
      gameModeWinning: winningGameMode(room),
    });
  }

  // =================================================================
  // [JUMP-MODE] VOTE FOR GAME MODE
  // =================================================================
  socket.on('voteGameMode', ({ gameMode } = {}) => {
    const room = currentRoom();
    if (!room) return;
    if (room.state === 'playing') return;   // votes lock during a race
    if (!CONFIG.GAME_MODES.includes(gameMode)) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    // Toggle: voting for the same mode again removes your vote
    const current = room.gameModeVotes.get(socket.id);
    if (current === gameMode) {
      room.gameModeVotes.delete(socket.id);
    } else {
      room.gameModeVotes.set(socket.id, gameMode);
    }

    room.lastActive = Date.now();
    broadcastGameModeUpdate(room);
    broadcastLobbyState();
  });

  // [JUMP-MODE] Solo-in-room game choice.
  // This does NOT touch room.gameMode — solo races are player-scoped.
  socket.on('setSoloGameMode', ({ gameMode } = {}) => {
    const room = currentRoom();
    if (!room) return;
    if (!CONFIG.GAME_MODES.includes(gameMode)) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    room.soloModeChoice = gameMode;   // last one wins; only used by soloer
    socket.emit('soloGameModeAck', { gameMode });
  });

  function sanitizeName(name) {
    let n = String(name || 'Climber').trim().slice(0, CONFIG.NAME_MAX_LENGTH);
    if (!n) n = 'Climber';
    const check = checkMessage(n);
    if (check.flagged) n = 'Climber';
    return n;
  }

  function sanitizeCharacter(id) {
    const s = String(id || '').trim();
    return ALLOWED_CHARACTERS.includes(s) ? s : 'normal_m';
  }

  function makePlayer(id, name, room, character) {
    const palette = [
      '#0ff', '#f0f', '#ff0', '#0f0',
      '#ff8c1a', '#8cf', '#fc8', '#8f8',
    ];
    return {
      id,
      name,
      ready: false,
      color: palette[room.players.size % palette.length],
      worldY: -100,
      ropeIndex: pickFreeRopeIndex(room),
      alive: true,
      altitude: 0,
      finished: false,
      joinedAt: Date.now(),
      warnings: 0,
      sessionToken: makeSessionToken(),
      character: sanitizeCharacter(character),
      coins: CONFIG.STARTING_COINS,
      lastFreeEntryAt: 0,
      milestoneState: { m1: false, m2: false, m3: false, moon: false, rewardThisRace: 0 },
    };
  }

  function betsToObject(room) {
    const out = {};
    for (const [bettorId, list] of room.bets) {
      out[bettorId] = list.map(b => ({ targetId: b.targetId, amount: b.amount }));
    }
    return out;
  }

  // ---------- LIST ROOMS ----------
  socket.on('listRooms', () => {
    const list = Array.from(rooms.values())
      .filter(r => r.state === 'lobby' && r.players.size < CONFIG.MAX_PLAYERS_PER_ROOM)
      .map(roomSummary)
      .slice(0, 50);
    socket.emit('roomList', { rooms: list });
  });

  // =================================================================
  // AUTH — SIGNUP / LOGIN / LOGOUT
  // =================================================================
  // Socket state for the logged-in user (if any).
  // Kept in closure scope so each socket has its own identity.
  let loggedInUserId = null;
  let loggedInToken = null;

  // Email format check — simple but reasonable
  function isValidEmail(e) {
    if (typeof e !== 'string') return false;
    const s = e.trim();
    if (s.length < 5 || s.length > 254) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  // Username: 3–16 chars, letters/numbers/underscore only
  function isValidUsername(u) {
    if (typeof u !== 'string') return false;
    const s = u.trim();
    if (s.length < 3 || s.length > 16) return false;
    return /^[A-Za-z0-9_]+$/.test(s);
  }

  // Password: at least 6 chars, no other constraints (users can use anything)
  function isValidPassword(p) {
    return typeof p === 'string' && p.length >= 6 && p.length <= 200;
  }

  socket.on('auth:signup', ({ username, email, password, character } = {}) => {
    try {
      // Validate inputs
      if (!isValidUsername(username)) {
        socket.emit('auth:signupResult', { ok: false, error: 'Username must be 3–16 characters, letters/numbers/underscore only' });
        return;
      }
      if (!isValidEmail(email)) {
        socket.emit('auth:signupResult', { ok: false, error: 'Please enter a valid email address' });
        return;
      }
      if (!isValidPassword(password)) {
        socket.emit('auth:signupResult', { ok: false, error: 'Password must be at least 6 characters' });
        return;
      }

      // Check uniqueness
      if (db.getUserByUsername(username)) {
        socket.emit('auth:signupResult', { ok: false, error: 'That username is taken' });
        return;
      }
      if (db.getUserByEmail(email)) {
        socket.emit('auth:signupResult', { ok: false, error: 'That email is already registered' });
        return;
      }

      // Create user
      const char = sanitizeCharacter(character);
      const user = db.createUser({
        username: username.trim(),
        email: email.trim().toLowerCase(),
        password,
        character: char,
      });

      // Issue a session token
      const token = db.makeUserSession(user.id);
      loggedInUserId = user.id;
      loggedInToken = token;

      socket.emit('auth:signupResult', {
        ok: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          coins: user.coins,
          character: user.character,
        },
      });
      // New user — empty inventory, but send it so the client is in sync
      socket.emit('shop:inventory', { ok: true, inventory: {} });
      console.log(`[auth] signup: ${user.username} (${user.email})`);
    } catch (e) {
      console.error('[auth] signup failed:', e.message);
      socket.emit('auth:signupResult', { ok: false, error: 'Signup failed — please try again' });
    }
  });

  socket.on('auth:login', ({ username, password } = {}) => {
    try {
      if (typeof username !== 'string' || typeof password !== 'string') {
        socket.emit('auth:loginResult', { ok: false, error: 'Enter your username and password' });
        return;
      }

      // Look up by username or email — allow either
      const user = db.getUserByUsername(username.trim()) || db.getUserByEmail(username.trim());
      if (!user) {
        socket.emit('auth:loginResult', { ok: false, error: 'Wrong username or password' });
        return;
      }

      if (!db.verifyPassword(password, user.password_hash)) {
        socket.emit('auth:loginResult', { ok: false, error: 'Wrong username or password' });
        return;
      }

      // Issue session
      const token = db.makeUserSession(user.id);
      loggedInUserId = user.id;
      loggedInToken = token;
      socket.emit('auth:loginResult', {
        ok: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          coins: user.coins,
          character: user.character,
        },
      });
      // Send the player's inventory so the shop is already populated
      const inv = db.getUserInventory(user.id);
      socket.emit('shop:inventory', { ok: true, inventory: inv });
      console.log(`[auth] login: ${user.username}`);
    } catch (e) {
      console.error('[auth] login failed:', e.message);
      socket.emit('auth:loginResult', { ok: false, error: 'Login failed — please try again' });
    }
  });

  socket.on('auth:resume', ({ token } = {}) => {
    // Called on reconnect if the client has a stored token
    try {
      if (!token || typeof token !== 'string') return;
      const session = db.getSessionByToken(token);
      if (!session) {
        socket.emit('auth:resumeResult', { ok: false, error: 'Session expired' });
        return;
      }
      loggedInUserId = session.user.id;
      loggedInToken = token;
      socket.emit('auth:resumeResult', {
        ok: true,
        token,
        user: {
          id: session.user.id,
          username: session.user.username,
          email: session.user.email,
          coins: session.user.coins,
          character: session.user.character,
        },
      });
      // Send their inventory too
      const inv = db.getUserInventory(session.user.id);
      socket.emit('shop:inventory', { ok: true, inventory: inv });
      console.log(`[auth] resume: ${session.user.username}`);
    } catch (e) {
      console.error('[auth] resume failed:', e.message);
      socket.emit('auth:resumeResult', { ok: false, error: 'Session expired' });
    }
  });

  socket.on('auth:logout', () => {
    try {
      if (loggedInToken) db.destroySession(loggedInToken);
      loggedInUserId = null;
      loggedInToken = null;
      socket.emit('auth:logoutResult', { ok: true });
      console.log(`[auth] logout: ${socket.id}`);
    } catch (e) {
      console.error('[auth] logout failed:', e.message);
      socket.emit('auth:logoutResult', { ok: false });
    }
  });

  // =================================================================
  // SHOP — power-up purchase and inventory sync
  // =================================================================
  function sendInventory() {
    if (!loggedInUserId) {
      socket.emit('shop:inventory', { ok: true, inventory: {} });
      return;
    }
    try {
      const inv = db.getUserInventory(loggedInUserId);
      socket.emit('shop:inventory', { ok: true, inventory: inv });
    } catch (e) {
      console.error('[shop] inventory fetch failed:', e.message);
      socket.emit('shop:inventory', { ok: false, inventory: {} });
    }
  }

  socket.on('shop:getInventory', () => {
    sendInventory();
  });

  socket.on('shop:buy', ({ powerupId, quantity } = {}) => {
    try {
      if (!loggedInUserId) {
        socket.emit('shop:buyResult', { ok: false, error: 'Sign up to unlock the shop' });
        return;
      }
      if (!isValidPowerupId(powerupId)) {
        socket.emit('shop:buyResult', { ok: false, error: 'Unknown power-up' });
        return;
      }
      const qty = Math.max(1, Math.min(99, Math.floor(Number(quantity) || 1)));
      const unit = POWERUPS[powerupId];
      const totalCost = unit.price * qty;

      const user = db.getUserById(loggedInUserId);
      if (!user) {
        socket.emit('shop:buyResult', { ok: false, error: 'Account not found' });
        return;
      }
      if (user.coins < totalCost) {
        socket.emit('shop:buyResult', {
          ok: false,
          error: `Not enough coins (need ${totalCost} 🪙, you have ${user.coins})`,
        });
        return;
      }

      // Deduct coins
      const newBalance = db.addUserCoins(loggedInUserId, -totalCost, 'shop_purchase', {
        powerupId, quantity: qty, unitPrice: unit.price,
      });
      if (newBalance === null) {
        socket.emit('shop:buyResult', { ok: false, error: 'Coin deduction failed' });
        return;
      }

      // Add to inventory
      const newQuantity = db.addUserInventoryItem(loggedInUserId, powerupId, qty);

      // Fetch inventory to send the full picture
      const inv = db.getUserInventory(loggedInUserId);

      socket.emit('shop:buyResult', {
        ok: true,
        powerupId,
        quantity: qty,
        newBalance,
        newInventoryQuantity: newQuantity,
        inventory: inv,
      });

      // Broadcast updated lobby state so the coin badge updates on everyone's screen
      broadcastLobbyState();

      console.log(`[shop] ${user.username} bought ${qty}x ${powerupId} for ${totalCost}🪙`);
    } catch (e) {
      console.error('[shop] buy failed:', e.message);
      socket.emit('shop:buyResult', { ok: false, error: 'Purchase failed — try again' });
    }
  });

  socket.on('shop:use', ({ powerupId } = {}) => {
    try {
      if (!loggedInUserId) {
        socket.emit('shop:useResult', { ok: false, error: 'Sign up to use power-ups' });
        return;
      }
      if (!isValidPowerupId(powerupId)) {
        socket.emit('shop:useResult', { ok: false, error: 'Unknown power-up' });
        return;
      }
      const room = currentRoom();
      if (!room) {
        socket.emit('shop:useResult', { ok: false, error: 'Not in a room' });
        return;
      }
      const p = room.players.get(socket.id);
      if (!p) {
        socket.emit('shop:useResult', { ok: false, error: 'Player not found' });
        return;
      }
      if (room.state !== 'playing') {
        socket.emit('shop:useResult', { ok: false, error: 'Can only use power-ups during a race' });
        return;
      }
      if (!p.alive || p.finished) {
        socket.emit('shop:useResult', { ok: false, error: 'You are not racing right now' });
        return;
      }

      const owned = db.getUserInventoryItem(loggedInUserId, powerupId);
      if (owned < 1) {
        socket.emit('shop:useResult', { ok: false, error: 'You do not own this power-up' });
        return;
      }

      // Consume one
      const newQuantity = db.addUserInventoryItem(loggedInUserId, powerupId, -1);
      const inv = db.getUserInventory(loggedInUserId);

      socket.emit('shop:useResult', {
        ok: true,
        powerupId,
        newInventoryQuantity: newQuantity,
        inventory: inv,
      });

      // Tell the client to trigger the effect. The client owns the actual
      // in-game effect for now — the server just authorizes the consumption
      // and broadcasts to nearby players (for later PvP features).
      socket.emit('shop:activate', {
        powerupId,
        durationMs: POWERUPS[powerupId].durationMs || 0,
      });

      // Optional: broadcast to room so others can see an aura/animation
      socket.to(room.code).emit('shop:activatedBy', {
        playerId: socket.id,
        playerName: p.name,
        powerupId,
      });

      console.log(`[shop] ${p.name} used ${powerupId} (${newQuantity} left)`);
    } catch (e) {
      console.error('[shop] use failed:', e.message);
      socket.emit('shop:useResult', { ok: false, error: 'Could not use power-up' });
    }
  });

  // ---------- USER-AWARE HELPERS ----------

  // Returns the current logged-in user row, or null.
  function currentUser() {
    if (!loggedInUserId) return null;
    try { return db.getUserById(loggedInUserId); } catch (e) { return null; }
  }

  // Central coin mutator. Updates the socket-based player row (legacy)
  // AND the user account row (if logged in). Never replaces either.
  function grantCoins(player, amount, reason, meta) {
    if (!player || !Number.isFinite(amount) || amount === 0) return;
    player.coins += amount;

    // Legacy socket row (only if it exists in the players table)
    try {
      if (db.getPlayer(player.id)) {
        db.addCoins(player.id, amount, reason, meta || null);
      }
    } catch (e) { console.error('[db] player coin write failed:', e.message); }

    // User account row (only if logged in)
    if (loggedInUserId) {
      try {
        db.addUserCoins(loggedInUserId, amount, reason, meta || null);
      } catch (e) { console.error('[db] user coin write failed:', e.message); }
    }
  }

  // Central profile sync. Updates the user's character when they pick one.
  function syncUserCharacter(character) {
    if (!loggedInUserId) return;
    try { db.updateUserCharacter(loggedInUserId, character); } catch (e) {}
  }

  // ---------- CREATE ROOM ----------
  socket.on('createRoom', ({ name, character } = {}) => {
    if (currentRoomCode) return;
    if (rooms.size >= CONFIG.MAX_ROOMS) {
      socket.emit('error', { message: 'Server is at capacity. Try again later.' });
      return;
    }
    playerName = sanitizeName(name);
    playerCharacter = sanitizeCharacter(character);

    const room = makeRoom(socket.id);
    room.isSolo = false;
    currentRoomCode = room.code;

    const player = makePlayer(socket.id, playerName, room, playerCharacter);
    room.players.set(socket.id, player);

    socket.join(room.code);

    // Persist this player to the database so coins survive restarts
    try {
      const existing = db.getPlayer(socket.id);
      if (!existing) {
        db.createPlayer({
          id: socket.id,
          name: playerName,
          character: playerCharacter,
          coins: player.coins,
        });
      } else {
        // Returning player — sync their saved coins into memory
        player.coins = existing.coins;
        db.updateProfile(socket.id, playerName, playerCharacter);
      }
      db.createSession({ token: player.sessionToken, playerId: socket.id });
    } catch (e) {
      console.error('[db] createRoom persist failed:', e.message);
    }

    // If logged in, the account is authoritative for coins + character
    const cu = currentUser();
    if (cu) {
      player.coins = cu.coins;
      player.character = cu.character || playerCharacter;
      db.updateProfile(socket.id, playerName, player.character);
      syncUserCharacter(player.character);
    }

    socket.emit('roomJoined', {
      roomCode: room.code,
      you: { id: socket.id, name: playerName, color: player.color, character: playerCharacter, coins: player.coins },
      state: room.state,
      players: Array.from(room.players.values()).map(publicPlayer),
      hostId: room.hostId,
      maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
      sessionToken: player.sessionToken,
      bets: betsToObject(room),
      betHistory: room.betHistory.slice(-20),
      config: {
        entryFeeGroup: CONFIG.ENTRY_FEE_GROUP,
        entryFeeSolo: CONFIG.ENTRY_FEE_SOLO,
        rewardM1: CONFIG.REWARD_MILESTONE_1,
        rewardM2: CONFIG.REWARD_MILESTONE_2,
        rewardM3: CONFIG.REWARD_MILESTONE_3,
        rewardMoonGroup: CONFIG.REWARD_MOON_GROUP,
        rewardMoonSolo: CONFIG.REWARD_MOON_SOLO,
        minBet: CONFIG.MIN_BET,
        maxBet: CONFIG.MAX_BET,
      },
    });

    broadcastLobbyState();
    console.log(`[room ${room.code}] created by ${playerName}`);
  });

  // ---------- JOIN ROOM ----------
  socket.on('joinRoom', ({ roomCode, name, character } = {}) => {
    if (currentRoomCode) return;
    const code = String(roomCode || '').toUpperCase().trim();
    if (!code) { socket.emit('joinError', { message: 'Invalid room code' }); return; }
    const room = rooms.get(code);
    if (!room) { socket.emit('joinError', { message: 'Room not found' }); return; }
    if (room.players.size >= CONFIG.MAX_PLAYERS_PER_ROOM) {
      socket.emit('joinError', { message: `Room is full (${CONFIG.MAX_PLAYERS_PER_ROOM}/${CONFIG.MAX_PLAYERS_PER_ROOM})` }); return;
    }
    // Allow joining a room that is mid-race — the joiner becomes a
    // "waiting" player. They stay in the lobby until the current race
    // ends, then they can ready up with everyone else.
    const joiningMidRace = (room.state === 'playing');
    playerName = sanitizeName(name);
    playerCharacter = sanitizeCharacter(character);

    currentRoomCode = code;
    const player = makePlayer(socket.id, playerName, room, playerCharacter);

    // If they joined mid-race, flag them as waiting. They'll be ignored
    // by the race loop until the current race ends.
    if (joiningMidRace) {
      player.waiting = true;
      player.ready = false;
      player.alive = true;          // so display doesn't show them as dead
      player.finished = false;
      player.altitude = 0;
      player.worldY = -100;
    }

    room.players.set(socket.id, player);
    room.lastActive = Date.now();

    socket.join(code);

    // Persist this player to the database so their coins survive restarts
    try {
      const existing = db.getPlayer(socket.id);
      if (!existing) {
        db.createPlayer({
          id: socket.id,
          name: playerName,
          character: playerCharacter,
          coins: player.coins,
        });
      } else {
        player.coins = existing.coins;
        db.updateProfile(socket.id, playerName, playerCharacter);
      }
      db.createSession({ token: player.sessionToken, playerId: socket.id });
    } catch (e) {
      console.error('[db] joinRoom persist failed:', e.message);
    }

    // If logged in, the account is authoritative for coins + character
    const cu = currentUser();
    if (cu) {
      player.coins = cu.coins;
      player.character = cu.character || playerCharacter;
      db.updateProfile(socket.id, playerName, player.character);
      syncUserCharacter(player.character);
    }

    socket.emit('roomJoined', {
      roomCode: code,
      you: { id: socket.id, name: playerName, color: player.color, character: playerCharacter, coins: player.coins },
      state: room.state,
      waiting: joiningMidRace,
      players: Array.from(room.players.values()).map(publicPlayer),
      hostId: room.hostId,
      maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
      sessionToken: player.sessionToken,
      bets: betsToObject(room),
      betHistory: room.betHistory.slice(-20),
      config: {
        entryFeeGroup: CONFIG.ENTRY_FEE_GROUP,
        entryFeeSolo: CONFIG.ENTRY_FEE_SOLO,
        rewardM1: CONFIG.REWARD_MILESTONE_1,
        rewardM2: CONFIG.REWARD_MILESTONE_2,
        rewardM3: CONFIG.REWARD_MILESTONE_3,
        rewardMoonGroup: CONFIG.REWARD_MOON_GROUP,
        rewardMoonSolo: CONFIG.REWARD_MOON_SOLO,
        minBet: CONFIG.MIN_BET,
        maxBet: CONFIG.MAX_BET,
      },
    });

    broadcastLobbyState();

    io.to(code).emit('chatMessage', {
      id: 'system', name: 'System',
      text: `${playerName} joined the room`, system: true,
    });

    console.log(`[room ${code}] ${playerName} joined (total: ${room.players.size})`);
  });

  // ---------- REJOIN ROOM ----------
  socket.on('rejoinRoom', ({ roomCode, sessionToken, name, character } = {}) => {
    if (currentRoomCode) return;
    const code = String(roomCode || '').toUpperCase().trim();
    if (!code || !sessionToken) {
      socket.emit('joinError', { message: 'Rejoin failed — missing token.' });
      return;
    }
    const room = rooms.get(code);
    if (!room) { socket.emit('joinError', { message: 'Room no longer exists.' }); return; }
    const entry = room.recent.get(sessionToken);
    if (!entry) { socket.emit('joinError', { message: 'Rejoin window expired.' }); return; }
    if (Date.now() - entry.leftAt > CONFIG.REJOIN_WINDOW_MS) {
      room.recent.delete(sessionToken);
      socket.emit('joinError', { message: 'Rejoin window expired.' });
      return;
    }

       room.recent.delete(sessionToken);
    const snap = entry.player;
    snap.id = socket.id;
    snap.joinedAt = Date.now();
    if (character) snap.character = sanitizeCharacter(character);
    playerName = snap.name;
    playerCharacter = snap.character || 'normal_m';

    room.players.set(socket.id, snap);
    room.lastActive = Date.now();
    currentRoomCode = code;

    socket.join(code);

    // Give the rejoining player a fresh DB row keyed by the new socket id
    try {
      if (!db.getPlayer(socket.id)) {
        db.createPlayer({
          id: socket.id,
          name: snap.name,
          character: snap.character || 'normal_m',
          coins: snap.coins,
        });
      }
      db.createSession({ token: sessionToken, playerId: socket.id });
    } catch (e) {
      console.error('[db] rejoin persist failed:', e.message);
    }

    // If logged in, account coins take precedence
    const cuR = currentUser();
    if (cuR) {
      snap.coins = cuR.coins;
      snap.character = cuR.character || snap.character;
    }

    socket.emit('roomJoined', {
      roomCode: code,
      you: { id: socket.id, name: snap.name, color: snap.color, character: snap.character, coins: snap.coins },
      state: room.state,
      players: Array.from(room.players.values()).map(publicPlayer),
      hostId: room.hostId,
      maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
      sessionToken,
      rejoined: true,
      bets: betsToObject(room),
      betHistory: room.betHistory.slice(-20),
      config: {
        entryFeeGroup: CONFIG.ENTRY_FEE_GROUP,
        entryFeeSolo: CONFIG.ENTRY_FEE_SOLO,
        rewardM1: CONFIG.REWARD_MILESTONE_1,
        rewardM2: CONFIG.REWARD_MILESTONE_2,
        rewardM3: CONFIG.REWARD_MILESTONE_3,
        rewardMoonGroup: CONFIG.REWARD_MOON_GROUP,
        rewardMoonSolo: CONFIG.REWARD_MOON_SOLO,
        minBet: CONFIG.MIN_BET,
        maxBet: CONFIG.MAX_BET,
      },
    });

    broadcastLobbyState();

    io.to(code).emit('chatMessage', {
      id: 'system', name: 'System',
      text: `${snap.name} rejoined the climb`, system: true,
    });

    console.log(`[room ${code}] ${snap.name} REJOINED`);
  });

  // ---------- AUTO-MATCH ----------
  socket.on('autoMatch', ({ name, character } = {}) => {
    if (currentRoomCode) return;
    playerName = sanitizeName(name);
    playerCharacter = sanitizeCharacter(character);

    let room = findOpenRoom();
    if (!room) {
      room = makeRoom(socket.id);
      room.isSolo = false;
      console.log(`[room ${room.code}] auto-created`);
    }

    currentRoomCode = room.code;
    const player = makePlayer(socket.id, playerName, room, playerCharacter);
    room.players.set(socket.id, player);
    room.lastActive = Date.now();

        socket.join(room.code);

    // Persist to db so coins survive restarts and reconnects
    try {
      if (!db.getPlayer(socket.id)) {
        db.createPlayer({
          id: socket.id,
          name: playerName,
          character: playerCharacter,
          coins: player.coins,
        });
      } else {
        const existing = db.getPlayer(socket.id);
        player.coins = existing.coins;
      }
      db.createSession({ token: player.sessionToken, playerId: socket.id });
    } catch (e) {
      console.error('[db] autoMatch persist failed:', e.message);
    }

    // If logged in, the account is authoritative for coins + character
    const cu = currentUser();
    if (cu) {
      player.coins = cu.coins;
      player.character = cu.character || playerCharacter;
      db.updateProfile(socket.id, playerName, player.character);
      syncUserCharacter(player.character);
    }

    socket.emit('roomJoined', {
      roomCode: room.code,
      you: { id: socket.id, name: playerName, color: player.color, character: player.character, coins: player.coins },
      state: room.state,
      players: Array.from(room.players.values()).map(publicPlayer),
      hostId: room.hostId,
      maxPlayers: CONFIG.MAX_PLAYERS_PER_ROOM,
      autoMatched: true,
      sessionToken: player.sessionToken,
      bets: betsToObject(room),
      betHistory: room.betHistory.slice(-20),
      config: {
        entryFeeGroup: CONFIG.ENTRY_FEE_GROUP,
        entryFeeSolo: CONFIG.ENTRY_FEE_SOLO,
        rewardM1: CONFIG.REWARD_MILESTONE_1,
        rewardM2: CONFIG.REWARD_MILESTONE_2,
        rewardM3: CONFIG.REWARD_MILESTONE_3,
        rewardMoonGroup: CONFIG.REWARD_MOON_GROUP,
        rewardMoonSolo: CONFIG.REWARD_MOON_SOLO,
        minBet: CONFIG.MIN_BET,
        maxBet: CONFIG.MAX_BET,
      },
    });

    broadcastLobbyState();

    io.to(room.code).emit('chatMessage', {
      id: 'system', name: 'System',
      text: `${playerName} joined the room`, system: true,
    });
  });

  // ---------- REQUEST LOBBY STATE ----------
  socket.on('requestLobbyState', () => {
    sendLobbyStateTo(socket);
  });

  // ---------- SOLO SESSION (server-side tracker for free-entry logic) ----------
  socket.on('soloStart', ({ name, character } = {}) => {
    // Solo is client-side, but we track a pseudo-player for free-entry
    // The client is responsible for its own coin persistence in solo.
    // Server simply acks and returns the solo config.
    socket.emit('soloConfig', {
      entryFeeSolo: CONFIG.ENTRY_FEE_SOLO,
      rewardM1: CONFIG.REWARD_MILESTONE_1,
      rewardM2: CONFIG.REWARD_MILESTONE_2,
      rewardM3: CONFIG.REWARD_MILESTONE_3,
      rewardMoonSolo: CONFIG.REWARD_MOON_SOLO,
      startingCoins: CONFIG.STARTING_COINS,
    });
  });
  // ---------- READY TOGGLE ----------
  socket.on('setReady', ({ ready } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    // Refuse READY if player can't afford entry (unless free entry available)
    const isSolo = room.isSolo;
    const fee = isSolo ? CONFIG.ENTRY_FEE_SOLO : CONFIG.ENTRY_FEE_GROUP;
    if (ready && p.coins < fee && !isFreeEntryAvailable(p)) {
      socket.emit('readyBlocked', {
        message: `You need at least ${fee} 🪙 to race. Come back tomorrow for a free entry.`,
      });
      return;
    }

    p.ready = !!ready;
    room.lastActive = Date.now();
    broadcastLobbyState();

    const all = Array.from(room.players.values());
    if (all.length >= 2 && all.every(pl => pl.ready)) {
      startRace(room);
    }
  });

  // ---------- FORCE START (host only) ----------
  socket.on('forceStart', () => {
    const room = currentRoom();
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.players.size < 2) return;
    startRace(room);
  });


  // ---------- START SOLO IN ROOM ----------
  // Player taps "Play Solo" from the lobby. Charges their ACCOUNT
  // (not the socket row), starts a race for them alone.
  socket.on('startSoloInRoom', () => {
    try {
      if (!loggedInUserId) {
        socket.emit('soloInRoomError', { message: 'Sign up to play solo with coins' });
        return;
      }
      const room = currentRoom();
      if (!room) {
        socket.emit('soloInRoomError', { message: 'Not in a room' });
        return;
      }
      if (room.state === 'playing') {
        socket.emit('soloInRoomError', { message: 'Race already in progress' });
        return;
      }
      const p = room.players.get(socket.id);
      if (!p) {
        socket.emit('soloInRoomError', { message: 'Player not found' });
        return;
      }

      // Pre-flight: check the ACCOUNT has enough coins for the entry fee
      const fee = CONFIG.ENTRY_FEE_SOLO;
      const user = db.getUserById(loggedInUserId);
      if (!user) {
        socket.emit('soloInRoomError', { message: 'Account not found' });
        return;
      }
      if (user.coins < fee) {
        socket.emit('soloInRoomError', {
          message: `You need ${fee} 🪙 to play solo. You have ${user.coins}.`,
        });
        return;
      }

      // Mark the room so startRace knows to charge the ACCOUNT instead
      // of the socket-based player row, and to skip the "ready" check.
      room.isSoloInRoom = true;

      // Give the player a full grip and reset for a fresh run
      p.ready = true;
      p.coins = user.coins;   // sync in-memory coins to account for the fee check below

      // Hand off to startRace — it charges the fee and broadcasts raceStarting
      startRace(room);

      console.log(`[solo-in-room ${room.code}] ${user.username} started solo (fee ${fee}🪙)`);
    } catch (e) {
      console.error('[solo-in-room] failed:', e.message);
      socket.emit('soloInRoomError', { message: 'Could not start solo race' });
    }
  });

  function startRace(room) {
    if (room.state === 'playing') return;
    room.state = 'playing';
    room.lastActive = Date.now();
    room.payoutResolved = false;
    room.entryCharged = false;

    // [JUMP-MODE] Apply the vote result to the room before anything else.
    // If nobody voted, this leaves room.gameMode unchanged (default 'climb'),
    // preserving identical behavior for Climb-only rooms.
    if (!room.isSoloInRoom) {
      const winning = winningGameMode(room);
      if (winning) room.gameMode = winning;
      // Reset votes for the next round — fresh vote after the race ends.
      room.gameModeVotes.clear();
    } else {
      // Solo-in-room: use the player's chosen mode for this race only.
      // The room's own gameMode stays whatever the room decided.
      if (room.soloModeChoice) {
        // We temporarily set gameMode so raceStarting tells the client
        // which game to render; we restore afterwards in checkRaceEnd().
        room._soloRidePrevMode = room.gameMode;
        room.gameMode = room.soloModeChoice;
      }
    }

    const isSolo = room.isSolo;
    const fee = isSolo ? CONFIG.ENTRY_FEE_SOLO : CONFIG.ENTRY_FEE_GROUP;

    for (const p of room.players.values()) {
      // Charge entry fee — deduct from coins. If insufficient, try free entry.
      // For solo-in-room races, the fee comes from the ACCOUNT, not the
      // socket row. For regular multiplayer, it stays on the socket row.

      if (room.isSoloInRoom && p.id === socket.id && loggedInUserId) {
        // ---- Solo-in-room path: charge the account ----
        const user = db.getUserById(loggedInUserId);
        if (!user || user.coins < fee) {
          socket.emit('readyBlocked', {
            message: `Not enough coins. Need ${fee} 🪙.`,
          });
          room.state = 'lobby';
          room.entryCharged = false;
          room.isSoloInRoom = false;
          broadcastLobbyState();
          return;
        }
        const newBalance = db.addUserCoins(loggedInUserId, -fee, 'solo_entry_fee', {
          roomCode: room.code,
        });
        p.coins = newBalance;
        socket.emit('coinsEarned', {
          amount: -fee,
          totalBalance: newBalance,
          reason: 'solo_entry',
        });
      } else if (p.coins >= fee) {
        // ---- Normal multiplayer path: charge the socket row ----
        chargeEntryFee(p, isSolo, room.code);
        try { db.addCoins(p.id, -fee, 'entry_fee', { roomCode: room.code, mode: isSolo ? 'solo' : 'group' }); } catch (e) { console.error('[db] entry fee write failed:', e.message); }
      } else if (isFreeEntryAvailable(p)) {
        grantDailyFreeEntry(p);
        logCoin({
          type: 'free_entry_used', playerId: p.id, playerName: p.name,
          balance: p.coins, roomCode: room.code, mode: isSolo ? 'solo' : 'group',
        });
        try { db.addCoins(p.id, 0, 'free_entry_used', { roomCode: room.code }); } catch (e) { console.error('[db] free entry write failed:', e.message); }
      } else {
        // Player is stuck — cannot race. Kick back to lobby state.
        p.ready = false;
        socket.emit('readyBlocked', {
          message: `Not enough coins. Need ${fee} 🪙. Come back tomorrow for a free entry.`,
        });
        room.state = 'lobby';
        room.entryCharged = false;
        broadcastLobbyState();
        return;
      }

      // Reset race state
      p.worldY = -100;
      p.ropeIndex = p.ropeIndex ?? 2;
      p.alive = true;
      p.altitude = 0;
      p.finished = false;
      p.ready = false;
      resetMilestoneState(p);
    }

    room.entryCharged = true;

    io.to(room.code).emit('raceStarting', {
      players: Array.from(room.players.values()).map(publicPlayer),
      startTime: Date.now(),
      entryFee: fee,
      soloInRoom: !!room.isSoloInRoom,
      // [JUMP-MODE]
      gameMode: room.gameMode,
    });

    console.log(`[room ${room.code}] RACE STARTED with ${room.players.size} players · fee ${fee}🪙`);
  }

  // ---------- PLAYER UPDATE (with milestone tracking) ----------
  socket.on('playerUpdate', ({ worldY, ropeIndex, alive, altitude, finished, character } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    // Waiting players don't participate in the race loop
    if (p.waiting) return;

    // --- ANTI-CHEAT: rate-limit updates per socket ---
    const nowMs = Date.now();
    if (!socket._lastUpdateAt) socket._lastUpdateAt = 0;
    if (nowMs - socket._lastUpdateAt < 40) return;   // max 25 updates/sec
    socket._lastUpdateAt = nowMs;

    // --- ANTI-CHEAT: reject impossible altitude jumps ---
    // Theoretical max climb rate = climbSpeed(72) × sprint(1.6) × altitude(1.35) × speedPowerup(1.7) × metersPerPixel(4) ≈ 1057 m/s.
    // Cap at 1500 m/s to leave headroom for lag spikes and future tuning.
    const MAX_METERS_PER_SECOND = 1500;
    const newAlt = typeof altitude === 'number' ? altitude : p.altitude;
    if (!p._lastAltAt) { p._lastAltAt = nowMs; p._lastAlt = p.altitude || 0; }
    const dtSec = Math.max(0.001, (nowMs - p._lastAltAt) / 1000);
    const gained = newAlt - p._lastAlt;
    const maxGain = MAX_METERS_PER_SECOND * dtSec + 10;   // +10m slack
    if (gained > maxGain) {
      console.warn(`[anti-cheat] ${p.name} tried to gain ${gained.toFixed(1)}m in ${dtSec.toFixed(2)}s (max ${maxGain.toFixed(1)})`);
      return;   // drop this update entirely
    }
    p._lastAlt = newAlt;
    p._lastAltAt = nowMs;

    p.worldY = typeof worldY === 'number' ? worldY : p.worldY;
    p.ropeIndex = typeof ropeIndex === 'number' ? ropeIndex : p.ropeIndex;
    p.alive = typeof alive === 'boolean' ? alive : p.alive;
    p.altitude = newAlt;   // use the validated value
    p.finished = typeof finished === 'boolean' ? finished : p.finished;
    if (character) p.character = sanitizeCharacter(character);
    // Milestone reward check — every altitude update
    if (room.state === 'playing' && p.alive && !p.finished) {
      const alt = Number(p.altitude) || 0;
      const granted = computeMilestoneRewards(room, p, alt);
      if (granted > 0) {
        // computeMilestoneRewards already added to p.coins.

        if (room.isSoloInRoom && loggedInUserId && p.id === socket.id) {
          // ---- Solo-in-room path: milestone goes to the ACCOUNT ----
          try {
            const newBal = db.addUserCoins(loggedInUserId, granted, 'milestone', {
              roomCode: room.code,
              altitude: Math.round(alt),
              mode: 'solo-in-room',
            });
            if (typeof newBal === 'number') p.coins = newBal;
          } catch (e) { console.error('[db] solo-in-room milestone write failed:', e.message); }
        } else {
          // ---- Normal multiplayer path: socket row + user row ----
          try {
            if (db.getPlayer(p.id)) {
              db.addCoins(p.id, granted, 'milestone', { roomCode: room.code, altitude: Math.round(alt) });
            }
          } catch (e) { console.error('[db] milestone write failed:', e.message); }
          if (loggedInUserId) {
            try { db.addUserCoins(loggedInUserId, granted, 'milestone', { roomCode: room.code, altitude: Math.round(alt) }); } catch (e) {}
          }
        }

        const sid = socket.id;
        io.to(sid).emit('coinsEarned', {
          amount: granted,
          totalBalance: p.coins,
          reason: 'milestone',
          altitude: Math.round(alt),
        });
        // Broadcast lobby state so roster balances refresh
        broadcastLobbyState();
      }
    }

    room.lastActive = Date.now();

    socket.to(room.code).emit('playerUpdated', {
      id: socket.id,
      worldY: p.worldY,
      ropeIndex: p.ropeIndex,
      alive: p.alive,
      altitude: p.altitude,
      finished: p.finished,
    });
  });

  // ---------- PLAYER DIED ----------
  socket.on('playerDied', () => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (p.waiting) return;   // waiting players can't die
    p.alive = false;

    // Milestone rewards already granted are kept. No penalty.
    io.to(room.code).emit('playerDied', { id: socket.id, name: p.name });

    // If all players are dead or finished, end the race
    checkRaceEnd(room);
  });

  // ---------- PLAYER WON ----------
  socket.on('playerWon', () => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (p.waiting) return;   // waiting players can't win
    if (p.finished) return;   // already processed

    // --- ANTI-CHEAT: verify player actually reached the moon ---
    const isJump = room.gameMode === 'jump';
    const moonM = isJump ? 18000 : 48000;
    if (p.altitude < moonM - 500) {
      console.warn(`[anti-cheat] ${p.name} claimed moon at ${p.altitude}m (need ${moonM}m)`);
      return;
    }

    p.finished = true;
    p.alive = true;

    // Grant moon reward (flat for solo, +40 stack for group)
    const reward = grantMoonReward(room, p);

    if (room.isSoloInRoom && loggedInUserId && p.id === socket.id) {
      // ---- Solo-in-room path: moon reward goes to the ACCOUNT ----
      try {
        const newBal = db.addUserCoins(loggedInUserId, reward, 'moon', {
          roomCode: room.code,
          mode: 'solo-in-room',
        });
        if (typeof newBal === 'number') p.coins = newBal;
      } catch (e) { console.error('[db] solo-in-room moon write failed:', e.message); }
    } else {
      // ---- Normal multiplayer path ----
      try { db.addCoins(p.id, reward, 'moon', { roomCode: room.code }); } catch (e) { console.error('[db] moon write failed:', e.message); }
      if (loggedInUserId) {
        try { db.addUserCoins(loggedInUserId, reward, 'moon', { roomCode: room.code }); } catch (e) {}
      }
    }

    io.to(socket.id).emit('coinsEarned', {
      amount: reward,
      totalBalance: p.coins,
      reason: 'moon',
    });

    io.to(room.code).emit('playerWon', {
      id: socket.id,
      name: p.name,
      altitude: p.altitude,
    });

    // Resolve payouts for the room (once, from the first finisher)
    resolvePayouts(room, socket.id);

    // Notify room of updated state
    broadcastLobbyState();

    // If all players are dead or finished, end the race
    checkRaceEnd(room);
  });

  // ---------- RACE ENDED (explicit signal from client) ----------
  socket.on('raceEnded', ({ winnerId } = {}) => {
    const room = currentRoom();
    if (!room) return;
    if (!winnerId) return;
    const winner = room.players.get(winnerId);
    if (!winner) return;
    resolvePayouts(room, winnerId);
  });

  function checkRaceEnd(room) {
    const players = Array.from(room.players.values());
    if (players.length === 0) return;
    const allDone = players.every(p => !p.alive || p.finished);
    if (!allDone) return;
    // Give a short grace period, then finalize
    setTimeout(() => {
      const r = rooms.get(room.code);
      if (!r) return;
      if (r.state !== 'playing') return;
      r.state = 'lobby';
      r.entryCharged = false;

      // Reconcile: for every logged-in user still in this room, sync their
      // account balance to match their socket-based player balance.
      for (const p of r.players.values()) {
        if (p.id === socket.id && loggedInUserId) {
          try {
            const user = db.getUserById(loggedInUserId);
            if (user) {
              db.setUserCoins(loggedInUserId, p.coins, 'race_reconcile', { roomCode: r.code });
            }
          } catch (e) { console.error('[db] user reconcile failed:', e.message); }
        }
      }

      // Clear the solo-in-room flag so the next race in this room is normal
      r.isSoloInRoom = false;
      // [JUMP-MODE] Restore the room's real game mode if a solo-in-room
      // race temporarily overrode it. KEEP soloModeChoice so the player's
      // next "Play Again" replays the SAME mode — they can change it
      // explicitly via the solo-choice modal at any time.
      if (r._soloRidePrevMode) {
        r.gameMode = r._soloRidePrevMode;
        r._soloRidePrevMode = null;
      }
      // (soloModeChoice intentionally NOT cleared — see comment above.)
      // [JUMP-MODE] Broadcast the final mode so the lobby UI reflects reality.
      broadcastGameModeUpdate(r);

      // Any players who joined mid-race were marked as waiting. The race
      // is now over, so un-mark them and let them participate normally.
      for (const p of r.players.values()) {
        if (p.waiting) {
          p.waiting = false;
          p.alive = true;
          p.finished = false;
          p.altitude = 0;
          p.worldY = -100;
          p.ready = false;
          // Tell each waiting player they can now participate
          io.to(p.id).emit('waitingEnded');
        }
      }

      // Ready everyone up with their current coins visible
      for (const p of r.players.values()) {
        p.ready = false;
      }
      io.to(r.code).emit('raceEnded', {
        players: Array.from(r.players.values()).map(publicPlayer),
      });
      broadcastLobbyState();
    }, 1200);
  }

  // ---------- RETURN TO LOBBY ----------
  socket.on('returnToLobby', () => {
    const room = currentRoom();
    if (!room) return;
    for (const p of room.players.values()) p.ready = false;
    room.state = 'lobby';
    room.entryCharged = false;
    room.lastActive = Date.now();
    // [JUMP-MODE] Clear votes so the next race starts from a clean slate.
    room.gameModeVotes.clear();
    broadcastGameModeUpdate(room);
    broadcastLobbyState();
    io.to(room.code).emit('chatMessage', {
      id: 'system', name: 'System',
      text: 'Returned to lobby — ready up for another race!',
      system: true,
    });
  });

  // =================================================================
  // BETTING
  // =================================================================
  socket.on('placeBet', ({ bets } = {}) => {
    const room = currentRoom();
    if (!room) return;
    if (room.state === 'playing') {
      socket.emit('betError', { message: 'Race already started — bets are locked.' });
      return;
    }
    const bettor = room.players.get(socket.id);
    if (!bettor) return;

    if (!Array.isArray(bets) || bets.length === 0) {
      socket.emit('betError', { message: 'No bets received.' });
      return;
    }

    const cleanBets = [];
    let totalStake = 0;
    for (const b of bets) {
      const targetId = String(b.targetId || '');
      const amount = Math.floor(Number(b.amount) || 0);
      if (!targetId || amount <= 0) continue;
      if (amount < CONFIG.MIN_BET) {
        socket.emit('betError', { message: `Minimum bet is ${CONFIG.MIN_BET} coins.` });
        return;
      }
      if (amount > CONFIG.MAX_BET) {
        socket.emit('betError', { message: `Maximum bet is ${CONFIG.MAX_BET} coins.` });
        return;
      }
      const target = room.players.get(targetId);
      if (!target) continue;
      totalStake += amount;
      cleanBets.push({ targetId, amount });
    }

    if (cleanBets.length === 0) {
      socket.emit('betError', { message: 'No valid bets.' });
      return;
    }
    if (totalStake > bettor.coins) {
      socket.emit('betError', { message: `You only have ${bettor.coins} coins.` });
      return;
    }

    // Deduct the total stake from the bettor's coins immediately.
    // Store the stake on the bettor so we can refund on clear / payout correctly.
    bettor.coins -= totalStake;
    logCoin({
      type: 'bet_placed',
      playerId: bettor.id, playerName: bettor.name,
      amount: -totalStake, balance: bettor.coins,
      roomCode: room.code,
    });
    try { db.addCoins(bettor.id, -totalStake, 'bet_placed', { roomCode: room.code }); } catch (e) { console.error('[db] bet write failed:', e.message); }

    room.bets.set(socket.id, cleanBets);
    room.lastActive = Date.now();
    broadcastBettingState(room);

    const betDescriptions = cleanBets.map(b => {
      const target = room.players.get(b.targetId);
      const targetName = b.targetId === socket.id ? 'themselves' : (target ? target.name : 'someone');
      return `${b.amount} on ${targetName}`;
    }).join(', ');
    io.to(room.code).emit('chatMessage', {
      id: 'system', name: 'System',
      text: `${bettor.name} bet ${betDescriptions}`,
      system: true,
    });
  });

  socket.on('clearBets', () => {
    const room = currentRoom();
    if (!room) return;
    if (room.state === 'playing') return;
    const list = room.bets.get(socket.id);
    if (list && list.length > 0) {
      const bettor = room.players.get(socket.id);
      if (bettor) {
        let totalRefund = 0;
        for (const b of list) totalRefund += b.amount;
        bettor.coins += totalRefund;
        logCoin({
          type: 'bet_refund',
          playerId: bettor.id, playerName: bettor.name,
          amount: totalRefund, balance: bettor.coins,
          roomCode: room.code,
        });
        try { db.addCoins(bettor.id, totalRefund, 'bet_refund', { roomCode: room.code }); } catch (e) { console.error('[db] bet refund write failed:', e.message); }
      }
      room.bets.delete(socket.id);
      broadcastBettingState(room);
    }
  });

  socket.on('getBettingState', () => {
    const room = currentRoom();
    if (!room) return;
    socket.emit('bettingState', buildBettingState(room));
  });

  function buildBettingState(room) {
    const betsObj = {};
    let totalPot = 0;
    for (const [bettorId, list] of room.bets) {
      betsObj[bettorId] = list.map(b => ({ targetId: b.targetId, amount: b.amount }));
      for (const b of list) totalPot += b.amount;
    }
    const stakedByTarget = {};
    for (const list of room.bets.values()) {
      for (const b of list) {
        stakedByTarget[b.targetId] = (stakedByTarget[b.targetId] || 0) + b.amount;
      }
    }
    const odds = {};
    for (const p of room.players.values()) {
      const stake = stakedByTarget[p.id] || 0;
      const total = totalPot || 1;
      const share = stake / total;
      const multiplier = Math.max(1.1, Math.min(3.0, 2.5 - share * 1.5 + Math.random() * 0.05));
      odds[p.id] = Math.round(multiplier * 100) / 100;
    }
    return {
      bets: betsObj,
      totalPot: totalPot,
      odds: odds,
      history: room.betHistory.slice(-20),
    };
  }

  function broadcastBettingState(room) {
    io.to(room.code).emit('bettingState', buildBettingState(room));
    broadcastLobbyState();
  }

  function resolvePayouts(room, winnerId) {
    if (room.payoutResolved) return;
    room.payoutResolved = true;

    const winner = room.players.get(winnerId);
    if (!winner) return;

    const historyEntries = [];
    const chatLines = [];

    // Compute the total pot regardless of who bet on whom
    let pot = 0;
    for (const list of room.bets.values()) {
      for (const b of list) pot += b.amount;
    }

    // If no bets, there's nothing to pay out — but still announce the race win
    if (pot <= 0) {
      io.to(room.code).emit('payoutsResolved', {
        winnerId,
        winnerName: winner.name,
        entries: [],
      });
      broadcastBettingState(room);
      return;
    }

    // Find everyone who bet on the winner, and how much they staked on the winner
    const winnerBackers = [];   // { bettorId, stakeOnWinner }
    for (const [bettorId, list] of room.bets) {
      let stakeOnWinner = 0;
      for (const b of list) {
        if (b.targetId === winnerId) stakeOnWinner += b.amount;
      }
      if (stakeOnWinner > 0) {
        winnerBackers.push({ bettorId, stakeOnWinner });
      }
    }

    const totalWinningStake = winnerBackers.reduce((s, w) => s + w.stakeOnWinner, 0);

    // Case 1: nobody bet on the winner — winner gets the whole pot as a bonus
    if (totalWinningStake === 0) {
      winner.coins += pot;
      try { db.addCoins(winner.id, pot, 'payout_unclaimed', { roomCode: room.code }); } catch (e) {}
      historyEntries.push({
        playerId: winner.id, playerName: winner.name,
        amount: pot, type: 'payout_unclaimed', time: Date.now(),
      });
      chatLines.push(`🪙 No one bet on ${winner.name}. They collect the full pot of ${pot} 🪙.`);
      for (const e of historyEntries) room.betHistory.push(e);
      if (room.betHistory.length > 100) room.betHistory = room.betHistory.slice(-100);
      room.bets.clear();
      io.to(room.code).emit('payoutsResolved', { winnerId, winnerName: winner.name, entries: historyEntries });
      for (const line of chatLines) {
        io.to(room.code).emit('chatMessage', { id: 'system', name: 'System', text: line, system: true });
      }
      broadcastBettingState(room);
      return;
    }

    // Case 2: someone bet on the winner. Apply the +10% winner bonus (only if
    // the winner bet on themselves — otherwise the pot is purely pari-mutuel).

    const winnerBetOnSelf = winnerBackers.some(w => w.bettorId === winnerId);
    const winnerBonus = winnerBetOnSelf ? Math.floor(pot * 0.10) : 0;
    const remainingPot = pot - winnerBonus;

    // Distribute the remaining pot proportionally by each backer's stake on the winner
    let distributed = 0;
    const payouts = [];
    for (const wb of winnerBackers) {
      const bettor = room.players.get(wb.bettorId);
      if (!bettor) continue;
      const share = Math.floor((wb.stakeOnWinner / totalWinningStake) * remainingPot);
      payouts.push({ bettor, share, stake: wb.stakeOnWinner });
      distributed += share;
    }

    // Any rounding remainder goes to the game winner
    const remainder = remainingPot - distributed;

    for (const p of payouts) {
      let amount = p.share;
      if (p.bettor.id === winnerId) amount += winnerBonus + remainder;
      p.bettor.coins += amount;
      try { db.addCoins(p.bettor.id, amount, 'payout_pari_mutuel', { roomCode: room.code, winnerId }); } catch (e) {}
      historyEntries.push({
        playerId: p.bettor.id, playerName: p.bettor.name,
        amount, type: 'payout_pari_mutuel', time: Date.now(),
      });
      const tag = p.bettor.id === winnerId ? ' (winner + bonus)' : '';
      chatLines.push(`🪙 ${p.bettor.name} won ${amount} 🪙 from the pot${tag}.`);
    }

    for (const e of historyEntries) room.betHistory.push(e);
    if (room.betHistory.length > 100) room.betHistory = room.betHistory.slice(-100);
    room.bets.clear();

    io.to(room.code).emit('payoutsResolved', {
      winnerId,
      winnerName: winner.name,
      entries: historyEntries,
    });

    // Chat summary
    const winnersList = winnerBackers
      .map(w => {
        const bettor = room.players.get(w.bettorId);
        return bettor ? bettor.name : '?';
      })
      .join(', ');
    io.to(room.code).emit('chatMessage', {
      id: 'system', name: 'System',
      text: `🎉 ${winner.name} reached the moon! Pot of ${pot} 🪙 paid out to: ${winnersList}`,
      system: true,
    });
    for (const line of chatLines) {
      io.to(room.code).emit('chatMessage', { id: 'system', name: 'System', text: line, system: true });
    }

    broadcastBettingState(room);
  }

  // =================================================================
  // PLAYER-TO-PLAYER COIN TRANSFERS
  // =================================================================
  socket.on('transferCoins', ({ toName, amount } = {}) => {
    const room = currentRoom();
    if (!room) { socket.emit('transferResult', { ok: false, error: 'Not in a room' }); return; }
    const fromPlayer = room.players.get(socket.id);
    if (!fromPlayer) { socket.emit('transferResult', { ok: false, error: 'Player not found' }); return; }

    // Normalise the lookup: trim, collapse spaces, lowercase
    const targetName = String(toName || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!targetName) { socket.emit('transferResult', { ok: false, error: 'Enter a recipient name' }); return; }

    let toPlayer = null;
    for (const p of room.players.values()) {
      if (p.id === fromPlayer.id) continue;
      const stored = String(p.name || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (stored === targetName) { toPlayer = p; break; }
    }
    if (!toPlayer) {
      // Give the sender a helpful hint with the actual roster
      const roster = Array.from(room.players.values())
        .filter(p => p.id !== fromPlayer.id)
        .map(p => p.name).join(', ') || '(nobody else)';
      socket.emit('transferResult', {
        ok: false,
        error: `No player named "${toName}". In this room: ${roster}`,
      });
      return;
    }

    const amt = Math.floor(Number(amount) || 0);
    const result = transferCoins(room, fromPlayer, toPlayer, amt);
    if (!result.ok) { socket.emit('transferResult', result); return; }

    socket.emit('transferResult', {
      ok: true,
      newBalance: result.fromBalance,
      message: `Sent ${amt} 🪙 to ${toPlayer.name}`,
    });

    io.to(toPlayer.id).emit('coinsReceived', {
      fromName: fromPlayer.name,
      amount: amt,
      newBalance: result.toBalance,
    });

    io.to(room.code).emit('chatMessage', {
      id: 'system', name: 'System',
      text: `🪙 ${fromPlayer.name} transferred ${amt} 🪙 to ${toPlayer.name}`,
      system: true,
    });

    broadcastLobbyState();
  });

  // =================================================================
  // CHAT
  // =================================================================
  socket.on('chatMessage', ({ text } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;

    const raw = String(text || '').slice(0, CONFIG.MESSAGE_MAX_LENGTH).trim();
    if (!raw) return;

    const check = checkMessage(raw);
    if (check.flagged) {
      p.warnings = (p.warnings || 0) + 1;
      logFlagged({
        roomCode: room.code, playerId: socket.id, playerName: p.name,
        text: raw, matchedTerm: check.term, warnings: p.warnings,
      });
      socket.emit('chatBlocked', {
        message: 'Message blocked — flagged content. This has been logged.',
        warnings: p.warnings,
      });
      if (p.warnings >= 3) {
        socket.emit('kicked', { reason: 'Repeated flagged messages' });
        setTimeout(() => socket.disconnect(true), 500);
      }
      return;
    }

    room.lastActive = Date.now();
    io.to(room.code).emit('chatMessage', {
      id: socket.id, name: p.name, text: raw, time: Date.now(),
    });
  });

  socket.on('chatVoice', ({ audio, mimeType, duration } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (typeof audio !== 'string' || audio.length === 0) return;
    if (audio.length > CONFIG.VOICE_B64_MAX_LENGTH) return;
    const dur = Math.max(0, Math.min(CONFIG.VOICE_DURATION_MAX_MS, Number(duration) || 0));
    const mime = typeof mimeType === 'string' && mimeType.length < 60 ? mimeType : 'audio/webm';
    room.lastActive = Date.now();
        io.to(room.code).emit('chatVoice', {
      id: socket.id,
      name: p.name,
      voice: true,
      voiceId: 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      audio: audio,
      mimeType: mime,
      duration: dur,
      time: Date.now(),
    });
  });

  socket.on('reportMessage', ({ messageId, targetName, text } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    logFlagged({
      roomCode: room.code, reporterId: socket.id, reporterName: p.name,
      reportedId: messageId, reportedName: targetName,
      text: String(text || '').slice(0, CONFIG.MESSAGE_MAX_LENGTH),
      type: 'user-report',
    });
    socket.emit('chatMessage', {
      id: 'system', name: 'System',
      text: 'Report submitted. Thank you.', system: true,
    });
  });

  // =================================================================
  // LEAVE / DISCONNECT
  // =================================================================
  socket.on('leaveRoom', () => {
    leaveCurrentRoom(true);
    socket.emit('leftRoom');
  });

  socket.on('disconnect', () => {
    console.log('[disconnect]', socket.id);
    leaveCurrentRoom(false);
  });

  function leaveCurrentRoom(explicit) {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) { currentRoomCode = null; return; }

    const p = room.players.get(socket.id);
    room.players.delete(socket.id);
    socket.leave(currentRoomCode);

    if (p && room.bets.has(socket.id)) {
      room.bets.delete(socket.id);
    }

    if (p) {
      if (!explicit && p.sessionToken) {
        room.recent.set(p.sessionToken, {
          player: { ...p },
          leftAt: Date.now(),
        });
        io.to(room.code).emit('chatMessage', {
          id: 'system', name: 'System',
          text: `${p.name} disconnected — can rejoin within 60s`,
          system: true,
        });
      } else {
        io.to(room.code).emit('chatMessage', {
          id: 'system', name: 'System',
          text: `${p.name} left the room`, system: true,
        });
      }
    }

    if (room.hostId === socket.id && room.players.size > 0) {
      const next = room.players.values().next().value;
      room.hostId = next.id;
      io.to(room.code).emit('chatMessage', {
        id: 'system', name: 'System',
        text: `${next.name} is now the host`, system: true,
      });
    }

    if (room.players.size === 0) {
      if (room.recent.size === 0) {
        rooms.delete(room.code);
        console.log(`[room ${room.code}] deleted (empty)`);
      } else {
        console.log(`[room ${room.code}] kept alive (rejoin pending)`);
      }
    } else {
      broadcastLobbyState();
    }

    currentRoomCode = null;
  }
});

// =================================================================
// PAYSTACK — real-money coin purchases
// =================================================================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';

// Coin tiers — change prices here to update the shop
const COIN_TIERS = {
  200:  { coins: 200,  priceNgn: 500,  label: '200 EarthCoins'  },
  500:  { coins: 500,  priceNgn: 1000, label: '500 EarthCoins'  },
  1000: { coins: 1000, priceNgn: 1800, label: '1,000 EarthCoins' },
};

// Initialize a Paystack transaction for a signed-in user.
// Body: { tier: 200|500|1000, token: <auth session token> }
app.post('/paystack/initialize', express.json(), async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) {
      return res.status(500).json({ error: 'Paystack not configured' });
    }
    const { tier, token } = req.body || {};
    const t = COIN_TIERS[tier];
    if (!t) return res.status(400).json({ error: 'Invalid tier' });

    // Verify the user's session token
    const session = db.getSessionByToken(token);
    if (!session || !session.user) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    const user = session.user;

    // Generate a unique reference for this transaction
    const reference = 'EF-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8).toUpperCase();

    // Record a pending transaction in the DB
    db.insertPaystackTx({
      reference,
      userId: user.id,
      tier: Number(tier),
      coins: t.coins,
      amountNgn: t.priceNgn * 100,   // kobo
    });

    // Call Paystack's initialize endpoint
    const resp = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: user.email,
        amount: t.priceNgn * 100,     // kobo
        reference,
        currency: 'NGN',
        callback_url: `${req.protocol}://${req.get('host')}/?reference=${reference}`,
        metadata: {
          custom_fields: [
            {
              display_name: 'Game',
              variable_name: 'game',
              value: 'Earthfall',
            },
            {
              display_name: 'Package',
              variable_name: 'package',
              value: t.label,
            },
          ],
        },
      }),
    });

    const data = await resp.json();
    if (!data.status) {
      console.error('[paystack] init failed:', data.message);
      return res.status(500).json({ error: 'Payment could not be initialized' });
    }

    res.json({
      ok: true,
      authorization_url: data.data.authorization_url,
      access_code: data.data.access_code,
      reference,
    });
  } catch (e) {
    console.error('[paystack] initialize error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify a transaction after the player returns from checkout.
// GET /paystack/verify/:reference?token=<auth_session_token>
app.get('/paystack/verify/:reference', async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) {
      return res.status(500).json({ error: 'Paystack not configured' });
    }
    const { reference } = req.params;
    const { token } = req.query;

    const session = db.getSessionByToken(token);
    if (!session || !session.user) {
      return res.status(401).json({ error: 'Not logged in' });
    }
    const userId = session.user.id;

    const row = db.getPaystackTx(reference);
    if (!row) return res.status(404).json({ error: 'Unknown reference' });
    if (row.user_id !== userId) return res.status(403).json({ error: 'Not yours' });

    // Idempotency: if already credited, return success without re-crediting
    if (row.status === 'used') {
      const u = db.getUserById(userId);
      return res.json({ ok: true, already: true, coins: row.coins, newBalance: u ? u.coins : 0 });
    }

    // Ask Paystack what really happened
    const resp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { 'Authorization': `Bearer ${PAYSTACK_SECRET}` },
    });
    const data = await resp.json();

    if (!data.status || !data.data || data.data.status !== 'success') {
      db.markPaystackFailed(reference);
      return res.status(400).json({ error: 'Payment not successful' });
    }

    // Sanity check: amount must meet or exceed what we asked for
    if (Number(data.data.amount) < Number(row.amount_ngn)) {
      console.error('[paystack] amount mismatch:', data.data.amount, '<', row.amount_ngn);
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    // Credit the user's account
    const newBalance = db.addUserCoins(userId, row.coins, 'paystack_purchase', {
      reference,
      tier: row.tier,
      paid_ngn: row.amount_ngn / 100,
    });
    db.markPaystackUsed(reference);

    console.log(`[paystack] credited ${row.coins} coins to ${session.user.username} (ref ${reference})`);
    res.json({ ok: true, coins: row.coins, newBalance });
  } catch (e) {
    console.error('[paystack] verify error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Webhook from Paystack — fallback in case the player closes the tab
// before returning from checkout.
app.post('/paystack/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const crypto = require('crypto');
    const hash = crypto.createHmac('sha512', PAYSTACK_SECRET)
      .update(req.body)
      .digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
      console.warn('[paystack] webhook signature mismatch');
      return res.sendStatus(401);
    }

    const event = JSON.parse(req.body.toString());
    if (event.event !== 'charge.success') return res.sendStatus(200);

    const ref = event.data.reference;
    const row = db.getPaystackTx(ref);
    if (!row) return res.sendStatus(200);
    if (row.status === 'used') return res.sendStatus(200);

    // Only credit if amount matches
    if (Number(event.data.amount) >= Number(row.amount_ngn)) {
      db.addUserCoins(row.user_id, row.coins, 'paystack_purchase', {
        reference: ref,
        tier: row.tier,
        source: 'webhook',
      });
      db.markPaystackUsed(ref);
      console.log(`[paystack] webhook credited ${row.coins} coins (ref ${ref})`);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('[paystack] webhook error:', e.message);
    res.sendStatus(500);
  }
});

// =================================================================
// HEALTH + START
// =================================================================
server.listen(PORT, () => {
  console.log(`🚀 Earthfall multiplayer server running on port ${PORT}`);
  try { console.log(`   💾 Database: ${db.DB_PATH}`); } catch (e) {}
  console.log(`   Max ${CONFIG.MAX_PLAYERS_PER_ROOM} per room · ${CONFIG.MAX_ROOMS} rooms max`);
  console.log(`   Rejoin window: ${CONFIG.REJOIN_WINDOW_MS / 1000}s`);
  console.log(`   Voice: enabled (max ${Math.round(CONFIG.VOICE_B64_MAX_LENGTH / 1024)} KB / ${CONFIG.VOICE_DURATION_MAX_MS / 1000}s)`);
  console.log(`   Economy: start ${CONFIG.STARTING_COINS}🪙 · group fee ${CONFIG.ENTRY_FEE_GROUP}🪙 · solo fee ${CONFIG.ENTRY_FEE_SOLO}🪙`);
  console.log(`   Rewards: M1 +${CONFIG.REWARD_MILESTONE_1} · M2 +${CONFIG.REWARD_MILESTONE_2} · M3 +${CONFIG.REWARD_MILESTONE_3} · Moon group +${CONFIG.REWARD_MOON_GROUP} · Moon solo +${CONFIG.REWARD_MOON_SOLO}`);
});

app.get('/health', (req, res) => {
  let dbStats = { players: 0, sessions: 0, totalCoins: 0 };
  let userStats = { users: 0, tokens: 0, totalCoins: 0 };
  try { dbStats = db.getStats(); } catch (e) {}
  try { userStats = db.getUserStats(); } catch (e) {}
  // Inventory stats — count of power-ups in circulation
  let invStats = { totalItems: 0, byType: {} };
  try {
    const rows = db.db.prepare('SELECT powerup_id, SUM(quantity) AS total FROM user_inventory GROUP BY powerup_id').all();
    for (const r of rows) {
      invStats.byType[r.powerup_id] = r.total;
      invStats.totalItems += r.total;
    }
  } catch (e) {}
  res.json({
    ok: true,
    rooms: rooms.size,
    players: Array.from(rooms.values()).reduce((s, r) => s + r.players.size, 0),
    rejoinPending: Array.from(rooms.values()).reduce((s, r) => s + r.recent.size, 0),
    activeBets: Array.from(rooms.values()).reduce((s, r) => s + r.bets.size, 0),
    db: dbStats,
    users: userStats,
    inventory: invStats,
    uptime: process.uptime(),
  });
});

process.on('uncaughtException', err => console.error('⚠️  Uncaught:', err));
process.on('unhandledRejection', err => console.error('⚠️  Unhandled:', err));