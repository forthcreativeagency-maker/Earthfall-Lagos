// =================================================================
// EARTHFALL — SQLite persistence layer
// Uses better-sqlite3 (synchronous, single-file, perfect for this scale)
// =================================================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Where the DB file lives.
// On Fly.io we'll mount a volume at /data — this picks that up automatically.
// Locally it sits next to server.js.
const DB_DIR = process.env.DB_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
const DB_PATH = path.join(DB_DIR, 'earthfall.db');

// Make sure the folder exists (Fly volume should already exist, but be safe)
try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // safer writes, better concurrency
db.pragma('foreign_keys = ON');

// -----------------------------------------------------------------
// SCHEMA
// -----------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    coins         INTEGER NOT NULL DEFAULT 1000,
    character     TEXT NOT NULL DEFAULT 'normal_m',
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token         TEXT PRIMARY KEY,
    player_id     TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS inventory (
    player_id     TEXT NOT NULL,
    powerup_id    TEXT NOT NULL,
    quantity      INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (player_id, powerup_id),
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS coin_transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     TEXT NOT NULL,
    amount        INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason        TEXT NOT NULL,
    meta          TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);
  CREATE INDEX IF NOT EXISTS idx_tx_player ON coin_transactions(player_id, created_at DESC);
`);
// =================================================================
// ACCOUNTS (new — does not replace the legacy players table)
// =================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    coins          INTEGER NOT NULL DEFAULT 1000,
    character      TEXT NOT NULL DEFAULT 'normal_m',
    created_at     INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token          TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_transactions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        TEXT NOT NULL,
    amount         INTEGER NOT NULL,
    balance_after  INTEGER NOT NULL,
    reason         TEXT NOT NULL,
    meta           TEXT,
    created_at     INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_auth_user ON auth_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_usertx_user ON user_transactions(user_id, created_at DESC);
`);

// =================================================================
// POWER-UPS INVENTORY (additive — new table for user-owned items)
// =================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS user_inventory (
    user_id     TEXT NOT NULL,
    powerup_id  TEXT NOT NULL,
    quantity    INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, powerup_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_userinv_user ON user_inventory(user_id);
`);

// =================================================================
// PAYSTACK TRANSACTIONS (additive — tracks real-money coin purchases)
// =================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS paystack_transactions (
    reference    TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    tier         INTEGER NOT NULL,
    coins        INTEGER NOT NULL,
    amount_ngn   INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   INTEGER NOT NULL,
    verified_at  INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_paystack_user ON paystack_transactions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_paystack_status ON paystack_transactions(status);
`);

// -----------------------------------------------------------------
// PLAYERS
// -----------------------------------------------------------------
const stmt = {
  insertPlayer: db.prepare(`
    INSERT INTO players (id, name, coins, character, created_at, last_seen_at)
    VALUES (@id, @name, @coins, @character, @now, @now)
  `),
  getPlayer: db.prepare(`SELECT * FROM players WHERE id = ?`),
  touchPlayer: db.prepare(`UPDATE players SET last_seen_at = ? WHERE id = ?`),
  updateCoins: db.prepare(`UPDATE players SET coins = ? WHERE id = ?`),
  updateName: db.prepare(`UPDATE players SET name = ?, character = ? WHERE id = ?`),
  // Atomic coin adjustment — safer than read-modify-write
  addCoins: db.prepare(`UPDATE players SET coins = coins + ? WHERE id = ?`),

  insertSession: db.prepare(`
    INSERT INTO sessions (token, player_id, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `),
  getSession: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
  touchSession: db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),

  getInventory: db.prepare(`SELECT powerup_id, quantity FROM inventory WHERE player_id = ?`),
  getInventoryItem: db.prepare(`SELECT quantity FROM inventory WHERE player_id = ? AND powerup_id = ?`),
  upsertInventory: db.prepare(`
    INSERT INTO inventory (player_id, powerup_id, quantity, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(player_id, powerup_id)
    DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at
  `),
  setInventory: db.prepare(`
    INSERT INTO inventory (player_id, powerup_id, quantity, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(player_id, powerup_id)
    DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at
  `),

  insertTx: db.prepare(`
    INSERT INTO coin_transactions (player_id, amount, balance_after, reason, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  recentTx: db.prepare(`
    SELECT * FROM coin_transactions
    WHERE player_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),
};

// -----------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------

const STARTING_COINS = 1000;

/**
 * Get a player by id, or null.
 */
function getPlayer(id) {
  return stmt.getPlayer.get(id) || null;
}

/**
 * Create a brand-new player with starting coins and a name.
 */
function createPlayer({ id, name, character = 'normal_m', coins = STARTING_COINS }) {
  const now = Date.now();
  stmt.insertPlayer.run({ id, name, coins, character, now });
  return getPlayer(id);
}

/**
 * Create a session token linked to a player.
 */
function createSession({ token, playerId }) {
  const now = Date.now();
  stmt.insertSession.run(token, playerId, now, now);
}

/**
 * Look up a player by session token.
 * Returns { player, session } or null.
 */
function getPlayerBySession(token) {
  if (!token) return null;
  const session = stmt.getSession.get(token);
  if (!session) return null;
  const player = getPlayer(session.player_id);
  if (!player) return null;
  return { player, session };
}

/**
 * Update last_seen timestamps. Cheap, called on reconnect.
 */
function touchSession(token, playerId) {
  const now = Date.now();
  stmt.touchSession.run(now, token);
  stmt.touchPlayer.run(now, playerId);
}

/**
 * Set the player's coin balance outright. Logs a transaction.
 */
function setCoins(playerId, newBalance, reason = 'manual', meta = null) {
  const before = getPlayer(playerId);
  if (!before) return null;
  const delta = newBalance - before.coins;
  stmt.updateCoins.run(newBalance, playerId);
  stmt.insertTx.run(playerId, delta, newBalance, reason, meta ? JSON.stringify(meta) : null, Date.now());
  return newBalance;
}

/**
 * Add (or subtract, with negative amount) coins atomically.
 * Logs a transaction. Returns new balance.
 */
function addCoins(playerId, amount, reason = 'adjust', meta = null) {
  if (!Number.isFinite(amount) || amount === 0) return null;
  const before = getPlayer(playerId);
  if (!before) return null;
  stmt.addCoins.run(amount, playerId);
  const after = getPlayer(playerId);
  stmt.insertTx.run(playerId, amount, after.coins, reason, meta ? JSON.stringify(meta) : null, Date.now());
  return after.coins;
}

/**
 * Update name/character. Safe to call any time.
 */
function updateProfile(playerId, name, character) {
  stmt.updateName.run(name, character, playerId);
}

/**
 * Get full inventory as a map { powerupId: quantity }.
 */
function getInventory(playerId) {
  const rows = stmt.getInventory.all(playerId);
  const out = {};
  for (const r of rows) out[r.powerup_id] = r.quantity;
  return out;
}

/**
 * Get quantity of one power-up (0 if none).
 */
function getInventoryItem(playerId, powerupId) {
  const row = stmt.getInventoryItem.get(playerId, powerupId);
  return row ? row.quantity : 0;
}

/**
 * Add to inventory (delta can be negative to consume).
 * Refuses to go below 0.
 */
function addInventory(playerId, powerupId, delta) {
  const current = getInventoryItem(playerId, powerupId);
  const next = Math.max(0, current + delta);
  stmt.setInventory.run(playerId, powerupId, next, Date.now());
  return next;
}

/**
 * Set inventory to an exact quantity (used internally).
 */
function setInventory(playerId, powerupId, quantity) {
  const q = Math.max(0, quantity | 0);
  stmt.setInventory.run(playerId, powerupId, q, Date.now());
  return q;
}

/**
 * Recent transaction history for a player.
 */
function getRecentTransactions(playerId, limit = 20) {
  return stmt.recentTx.all(playerId, limit);
}

/**
 * Stats for /health endpoint.
 */
function getStats() {
  const players = db.prepare('SELECT COUNT(*) AS n FROM players').get().n;
  const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  const totalCoins = db.prepare('SELECT COALESCE(SUM(coins), 0) AS n FROM players').get().n;
  return { players, sessions, totalCoins };
}
// =================================================================
// USER ACCOUNT HELPERS
// =================================================================
const bcrypt = require('bcryptjs');

const USER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

const userStmts = {
  insertUser: db.prepare(`
    INSERT INTO users (id, username, email, password_hash, coins, character, created_at, last_seen_at)
    VALUES (@id, @username, @email, @password_hash, @coins, @character, @now, @now)
  `),
  getUserById:       db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)'),
  getUserByEmail:    db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)'),
  touchUser:         db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
  updateUserCoins:   db.prepare('UPDATE users SET coins = ? WHERE id = ?'),
  addUserCoins:      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?'),
  updateUserProfile: db.prepare('UPDATE users SET username = ?, email = ?, character = ? WHERE id = ?'),
  updateUserCharacter: db.prepare('UPDATE users SET character = ? WHERE id = ?'),

  insertToken:  db.prepare(`
    INSERT INTO auth_tokens (token, user_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  getToken:     db.prepare('SELECT * FROM auth_tokens WHERE token = ?'),
  touchToken:   db.prepare('UPDATE auth_tokens SET last_seen_at = ? WHERE token = ?'),
  deleteToken:  db.prepare('DELETE FROM auth_tokens WHERE token = ?'),
  purgeExpiredTokens: db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?'),

  insertUserTx: db.prepare(`
    INSERT INTO user_transactions (user_id, amount, balance_after, reason, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  recentUserTx: db.prepare(`
    SELECT * FROM user_transactions
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),
};

function makeUserId() {
  return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function makeAuthToken() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 12) +
    Math.random().toString(36).slice(2, 12) +
    Math.random().toString(36).slice(2, 12)
  );
}

function makeUserSession(userId) {
  const token = makeAuthToken();
  const now = Date.now();
  userStmts.insertToken.run(token, userId, now, now + USER_TOKEN_TTL_MS, now);
  return token;
}

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  try { return bcrypt.compareSync(plain, hash); } catch (e) { return false; }
}

function createUser({ username, email, password, character = 'normal_m', coins = STARTING_COINS }) {
  const id = makeUserId();
  const now = Date.now();
  const password_hash = hashPassword(password);
  userStmts.insertUser.run({
    id, username, email, password_hash, coins, character, now,
  });
  return getUserById(id);
}

function getUserById(id) {
  return userStmts.getUserById.get(id) || null;
}

function getUserByUsername(username) {
  return userStmts.getUserByUsername.get(username) || null;
}

function getUserByEmail(email) {
  return userStmts.getUserByEmail.get(email) || null;
}

function getSessionByToken(token) {
  if (!token) return null;
  const row = userStmts.getToken.get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    userStmts.deleteToken.run(token);
    return null;
  }
  userStmts.touchToken.run(Date.now(), token);
  const user = getUserById(row.user_id);
  if (!user) return null;
  userStmts.touchUser.run(Date.now(), user.id);
  return { user, token };
}

function destroySession(token) {
  if (!token) return;
  try { userStmts.deleteToken.run(token); } catch (e) {}
}

function purgeExpiredAuthTokens() {
  try { userStmts.purgeExpiredTokens.run(Date.now()); } catch (e) {}
}

function setUserCoins(userId, newBalance, reason = 'manual', meta = null) {
  const before = getUserById(userId);
  if (!before) return null;
  const delta = newBalance - before.coins;
  userStmts.updateUserCoins.run(newBalance, userId);
  userStmts.insertUserTx.run(userId, delta, newBalance, reason, meta ? JSON.stringify(meta) : null, Date.now());
  return newBalance;
}

function addUserCoins(userId, amount, reason = 'adjust', meta = null) {
  if (!Number.isFinite(amount) || amount === 0) return null;
  const before = getUserById(userId);
  if (!before) return null;
  userStmts.addUserCoins.run(amount, userId);
  const after = getUserById(userId);
  userStmts.insertUserTx.run(userId, amount, after.coins, reason, meta ? JSON.stringify(meta) : null, Date.now());
  return after.coins;
}

function updateUserCharacter(userId, character) {
  userStmts.updateUserCharacter.run(character, userId);
}

function updateUserProfile(userId, username, email, character) {
  userStmts.updateUserProfile.run(username, email, character, userId);
}

function getRecentUserTransactions(userId, limit = 20) {
  return userStmts.recentUserTx.all(userId, limit);
}

function getUserStats() {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const tokens = db.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get().n;
  const totalCoins = db.prepare('SELECT COALESCE(SUM(coins), 0) AS n FROM users').get().n;
  return { users, tokens, totalCoins };
}
// =================================================================
// POWER-UP INVENTORY HELPERS
// =================================================================
const inventoryStmts = {
  getAll:   db.prepare('SELECT powerup_id, quantity FROM user_inventory WHERE user_id = ?'),
  getOne:   db.prepare('SELECT quantity FROM user_inventory WHERE user_id = ? AND powerup_id = ?'),
  upsert:   db.prepare(`
    INSERT INTO user_inventory (user_id, powerup_id, quantity, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, powerup_id)
    DO UPDATE SET quantity = ?, updated_at = ?
  `),
  remove:   db.prepare('DELETE FROM user_inventory WHERE user_id = ? AND powerup_id = ?'),
};

/**
 * Get the full inventory as a map: { powerup_id: quantity }
 * Only returns entries with quantity > 0.
 */
function getUserInventory(userId) {
  const rows = inventoryStmts.getAll.all(userId);
  const out = {};
  for (const r of rows) {
    if (r.quantity > 0) out[r.powerup_id] = r.quantity;
  }
  return out;
}

/**
 * Get the quantity of a specific power-up (0 if none).
 */
function getUserInventoryItem(userId, powerupId) {
  const row = inventoryStmts.getOne.get(userId, powerupId);
  return row ? row.quantity : 0;
}

/**
 * Set the exact quantity for a power-up.
 * Returns the new quantity.
 */
function setUserInventoryItem(userId, powerupId, quantity) {
  const q = Math.max(0, Math.floor(quantity) | 0);
  const now = Date.now();
  if (q === 0) {
    inventoryStmts.remove.run(userId, powerupId);
  } else {
    inventoryStmts.upsert.run(userId, powerupId, q, now, q, now);
  }
  return q;
}

/**
 * Add (or subtract if negative) from the inventory count.
 * Never goes below 0. Returns the new quantity.
 */
function addUserInventoryItem(userId, powerupId, delta) {
  const current = getUserInventoryItem(userId, powerupId);
  const next = Math.max(0, current + Math.floor(delta));
  return setUserInventoryItem(userId, powerupId, next);
}

// =================================================================
// PAYSTACK HELPERS
// =================================================================
const paystackStmts = {
  insert: db.prepare(`
    INSERT INTO paystack_transactions (reference, user_id, tier, coins, amount_ngn, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `),
  get:    db.prepare('SELECT * FROM paystack_transactions WHERE reference = ?'),
  markUsed: db.prepare(`UPDATE paystack_transactions SET status = 'used', verified_at = ? WHERE reference = ?`),
  markFailed: db.prepare(`UPDATE paystack_transactions SET status = 'failed' WHERE reference = ?`),
};

function insertPaystackTx({ reference, userId, tier, coins, amountNgn }) {
  paystackStmts.insert.run(reference, userId, tier, coins, amountNgn, Date.now());
}

function getPaystackTx(reference) {
  return paystackStmts.get.get(reference) || null;
}

function markPaystackUsed(reference) {
  paystackStmts.markUsed.run(Date.now(), reference);
}

function markPaystackFailed(reference) {
  paystackStmts.markFailed.run(reference);
}

module.exports = {
  db,
  DB_PATH,
  STARTING_COINS,

  // ---- Legacy player API (unchanged) ----
  getPlayer,
  createPlayer,
  createSession,
  getPlayerBySession,
  touchSession,
  setCoins,
  addCoins,
  updateProfile,
  getInventory,
  getInventoryItem,
  addInventory,
  setInventory,
  getRecentTransactions,
  getStats,

  // ---- User account API (new) ----
  USER_TOKEN_TTL_MS,
  createUser,
  getUserById,
  getUserByUsername,
  getUserByEmail,
  makeUserSession,
  getSessionByToken,
  destroySession,
  purgeExpiredAuthTokens,
  hashPassword,
  verifyPassword,
  setUserCoins,
  addUserCoins,
  updateUserCharacter,
  updateUserProfile,
  getRecentUserTransactions,
  getUserStats,

  // ---- Power-up inventory API ----
  getUserInventory,
  getUserInventoryItem,
  setUserInventoryItem,
  addUserInventoryItem,

  // ---- Paystack (real-money coin purchases) ----
  insertPaystackTx,
  getPaystackTx,
  markPaystackUsed,
  markPaystackFailed,
};