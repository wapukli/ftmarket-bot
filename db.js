/* FTMARKET — SQLite слой (пользователи, проекты, состояния FSM) */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'ftmarket.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT NOT NULL,
    last_name TEXT,
    photo_file_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    price INTEGER NOT NULL,
    fanpay_link TEXT NOT NULL,
    photos TEXT NOT NULL,        -- JSON array of Telegram file_id
    status TEXT NOT NULL DEFAULT 'active',  -- active | draft
    boost INTEGER NOT NULL DEFAULT 0,       -- market+: 0 | 1
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES users(telegram_id)
  );

  CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

  CREATE TABLE IF NOT EXISTS sessions (
    telegram_id INTEGER PRIMARY KEY,
    state TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feed_state (
    telegram_id INTEGER PRIMARY KEY,
    project_id INTEGER,
    reviewed TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Миграция для старых баз
try { db.exec('ALTER TABLE projects ADD COLUMN boost INTEGER NOT NULL DEFAULT 0'); } catch { /* уже есть */ }

/* ---------- Users ---------- */
function upsertUser(from) {
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, photo_file_id, last_seen)
    VALUES (@id, @username, @first, @last, NULL, datetime('now'))
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      last_seen = datetime('now')
  `).run({
    id: from.id,
    username: from.username || null,
    first: from.first_name || 'Пользователь',
    last: from.last_name || null
  });
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(id);
}

function setUserPhoto(id, fileId) {
  db.prepare('UPDATE users SET photo_file_id = ? WHERE telegram_id = ?').run(fileId, id);
}

function userName(id) {
  const u = getUser(id);
  if (!u) return 'Продавец';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || ('@' + u.username) || 'Продавец';
}

/* ---------- FSM sessions ---------- */
function getSession(id) {
  const row = db.prepare('SELECT * FROM sessions WHERE telegram_id = ?').get(id);
  if (!row) return { state: null, data: {} };
  try { return { state: row.state, data: JSON.parse(row.data || '{}') }; }
  catch { return { state: null, data: {} }; }
}

function setSession(id, state, data) {
  db.prepare(`
    INSERT INTO sessions (telegram_id, state, data, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(telegram_id) DO UPDATE SET
      state = excluded.state, data = excluded.data, updated_at = datetime('now')
  `).run(id, state || null, JSON.stringify(data || {}));
}

function clearSession(id) {
  db.prepare('DELETE FROM sessions WHERE telegram_id = ?').run(id);
}

/* ---------- Projects ---------- */
const MAX_PROJECTS = 5;

function activeCount(ownerId) {
  return db.prepare("SELECT COUNT(*) AS c FROM projects WHERE owner_id = ? AND status = 'active'").get(ownerId).c;
}

function createProject(data) {
  const info = db.prepare(`
    INSERT INTO projects (owner_id, title, price, fanpay_link, photos, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `).run(data.ownerId, data.title, data.price, data.fanpayLink, JSON.stringify(data.photos));
  return getProject(info.lastInsertRowid);
}

function getProject(id) {
  const p = db.prepare("SELECT * FROM projects WHERE id = ? AND status = 'active'").get(id);
  if (!p) return null;
  return serialize(p);
}

function getOwnProjects(ownerId) {
  return db.prepare("SELECT * FROM projects WHERE owner_id = ? AND status = 'active' ORDER BY id DESC")
    .all(ownerId).map(serialize);
}

function getFeedProjects(ownerId) {
  // Che balanced feed: newest first. A light market+ priority is applied in bot.js
  // by interleaving one boosted item after every two regular ones.
  return db.prepare("SELECT * FROM projects WHERE owner_id != ? AND status = 'active' ORDER BY id DESC LIMIT 100")
    .all(ownerId).map(serialize);
}

function updateProject(id, fields) {
  const sets = [];
  const vals = [];
  for (const k of Object.keys(fields)) {
    sets.push(`${k} = ?`);
    vals.push(fields[k]);
  }
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getProject(id);
}

function deleteProject(id) {
  db.prepare("UPDATE projects SET status = 'deleted', updated_at = datetime('now') WHERE id = ?").run(id);
}

function serialize(p) {
  let photos = [];
  try { photos = JSON.parse(p.photos || '[]'); } catch { /* ignore */ }
  return {
    id: p.id,
    ownerId: p.owner_id,
    title: p.title,
    price: p.price,
    fanpayLink: p.fanpay_link,
    photos,
    boost: p.boost || 0,
    createdAt: p.created_at,
    sellerName: userName(p.owner_id)
  };
}

/* ---------- Feed state ---------- */
function getFeedState(id) {
  const row = db.prepare('SELECT * FROM feed_state WHERE telegram_id = ?').get(id);
  if (!row) return { projectId: null, reviewed: [] };
  try { return { projectId: row.project_id, reviewed: JSON.parse(row.reviewed || '[]') }; }
  catch { return { projectId: null, reviewed: [] }; }
}

function setFeedState(id, projectId, reviewed) {
  db.prepare(`
    INSERT INTO feed_state (telegram_id, project_id, reviewed, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(telegram_id) DO UPDATE SET
      project_id = excluded.project_id, reviewed = excluded.reviewed, updated_at = datetime('now')
  `).run(id, projectId, JSON.stringify(reviewed || []));
}

/* ---------- Admin helpers ---------- */
function allUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 200').all();
}
function allProjects() {
  return db.prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY id DESC LIMIT 200").all().map(serialize);
}
function stats() {
  return {
    users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    projects: db.prepare("SELECT COUNT(*) AS c FROM projects WHERE status = 'active'").get().c
  };
}

module.exports = {
  db, upsertUser, getUser, setUserPhoto, userName,
  getSession, setSession, clearSession,
  MAX_PROJECTS, activeCount, createProject, getProject, getOwnProjects,
  getFeedProjects, updateProject, deleteProject,
  toggleBoost(id) {
    const row = db.prepare('SELECT boost FROM projects WHERE id = ?').get(id);
    if (!row) return null;
    const next = row.boost ? 0 : 1;
    db.prepare('UPDATE projects SET boost = ?, updated_at = datetime(\'now\') WHERE id = ?').run(next, id);
    return next;
  },
  getFeedState, setFeedState,
  allUsers, allProjects, stats
};
