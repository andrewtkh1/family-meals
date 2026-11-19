const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const sharp = require('sharp');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, PHOTO_DIR } = require('./db');
const { validatePassword } = require('./password');

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.APP_TIMEZONE || 'UTC';
const MAX_USERS = 10;
const MAX_CALORIES = 10000;
const SESSION_MS = 90 * 24 * 3600 * 1000;
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';

// Validate timezone early
try { new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }); }
catch { console.error(`Invalid APP_TIMEZONE: ${TIMEZONE}`); process.exit(1); }

const dayString = (ms = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);

const app = express();
app.disable('x-powered-by');
// Only trust X-Forwarded-For when explicitly configured (e.g. TRUST_PROXY=loopback behind a local
// reverse proxy / tunnel). Unset = off, so clients cannot spoof their IP to dodge the login throttle.
function parseTrustProxy(v) {
  if (v === undefined || v.trim() === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  return v.split(',').map(x => x.trim()).filter(Boolean);
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// Basic CSRF defence: reject cross-origin state-changing requests
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' }); }
    catch { return res.status(403).json({ error: 'Bad origin' }); }
  }
  next();
});

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// ---- helpers ----
const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare('SELECT u.id, u.username, s.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
};

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(token, userId, Date.now());
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIE, maxAge: SESSION_MS });
}

function auth(req, res, next) {
  const token = req.cookies.sid;
  const row = token && q.sessionUser.get(token);
  if (!row || Date.now() - row.created_at > SESSION_MS) return res.status(401).json({ error: 'Not signed in' });
  req.user = { id: row.id, username: row.username };
  next();
}

// Simple in-memory throttle for login/register attempts per IP, plus per-username lockout for login
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const MAX_IP_ATTEMPTS = 20;
const MAX_USER_FAILURES = 10;
const attempts = new Map();     // ip -> [timestamps]
const userFailures = new Map(); // lowercased username -> [timestamps of failed logins]
const recent = (map, key, now) => (map.get(key) || []).filter(t => now - t < THROTTLE_WINDOW_MS);
const TOO_MANY = { error: 'Too many attempts. Try again in a few minutes.' };
function throttle(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = recent(attempts, key, now);
  if (rec.length >= MAX_IP_ATTEMPTS) return res.status(429).json(TOO_MANY);
  rec.push(now);
  attempts.set(key, rec);
  next();
}
// Prune stale throttle entries so the maps don't grow without bound
setInterval(() => {
  const now = Date.now();
  for (const map of [attempts, userFailures]) {
    for (const [key, ts] of map) {
      const live = ts.filter(t => now - t < THROTTLE_WINDOW_MS);
      if (live.length) map.set(key, live); else map.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const BCRYPT_COST = 10;
// Compared against for unknown usernames so login timing doesn't reveal which usernames exist.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

// ---- auth routes ----
app.post('/api/register', throttle, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username))
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores.' });
  const pwError = validatePassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  let userId;
  try {
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    db.exec('BEGIN IMMEDIATE');
    if (q.userCount.get().n >= MAX_USERS) { db.exec('ROLLBACK'); return res.status(403).json({ error: `Sorry, all ${MAX_USERS} family spots are taken.` }); }
    if (q.userByName.get(username)) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'That username is taken.' }); }
    userId = Number(q.insertUser.run(username, hash, Date.now()).lastInsertRowid);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* no transaction open; nothing to roll back */ }
    console.error(e);
    return res.status(500).json({ error: 'Could not create account.' });
  }
  startSession(res, userId);
  res.json({ id: userId, username });
});

app.post('/api/login', throttle, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const userKey = typeof username === 'string' ? username.toLowerCase() : null;
    const now = Date.now();
    const fails = userKey ? recent(userFailures, userKey, now) : [];
    if (fails.length >= MAX_USER_FAILURES) return res.status(429).json(TOO_MANY);
    const user = typeof username === 'string' ? q.userByName.get(username) : null;
    const pw = typeof password === 'string' ? password : '';
    // Always run bcrypt (dummy hash for unknown users) to equalise response time.
    const match = await bcrypt.compare(pw, user ? user.password_hash : DUMMY_HASH);
    if (!user || !match || typeof password !== 'string') {
      if (userKey) { fails.push(now); userFailures.set(userKey, fails); }
      return res.status(401).json({ error: 'Wrong username or password.' });
    }
    if (userKey) userFailures.delete(userKey);
    startSession(res, user.id);
    res.json({ id: user.id, username: user.username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});

app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) q.delSession.run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ ...req.user, timezone: TIMEZONE }));

// ---- data routes ----
app.get('/api/today', auth, (req, res) => {
  const day = dayString();
  const rows = db.prepare(`
    SELECT u.id, u.username, COALESCE(SUM(m.calories), 0) AS calories, COUNT(m.id) AS meals
    FROM users u LEFT JOIN meals m ON m.user_id = u.id AND m.day = ?
    GROUP BY u.id ORDER BY calories DESC, u.username COLLATE NOCASE`).all(day);
  res.json({ day, users: rows });
});

app.get('/api/feed', auth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 30);
  const before = parseInt(req.query.before) || Number.MAX_SAFE_INTEGER;
  const meals = db.prepare(`
    SELECT m.id, m.user_id, u.username, m.calories, m.photo, m.created_at,
      (SELECT COUNT(*) FROM likes l WHERE l.meal_id = m.id) AS like_count
    FROM meals m JOIN users u ON u.id = m.user_id
    WHERE m.id < ? ORDER BY m.id DESC LIMIT ?`).all(before, limit);
  const likersStmt = db.prepare('SELECT u.username, u.id FROM likes l JOIN users u ON u.id = l.user_id WHERE l.meal_id = ? ORDER BY l.rowid');
  const commentsStmt = db.prepare('SELECT c.id, c.user_id, u.username, c.body, c.created_at FROM comments c JOIN users u ON u.id = c.user_id WHERE c.meal_id = ? ORDER BY c.id');
  const out = meals.map(m => {
    const likers = likersStmt.all(m.id);
    const comments = commentsStmt.all(m.id).map(c => ({
      id: c.id, username: c.username, body: c.body, created_at: c.created_at, mine: c.user_id === req.user.id,
    }));
    return {
      comments,
      id: m.id, username: m.username, calories: m.calories, created_at: m.created_at,
      photo: m.photo ? `/photos/${m.photo}` : null,
      mine: m.user_id === req.user.id,
      like_count: m.like_count,
      liked: likers.some(l => l.id === req.user.id),
      likers: likers.map(l => l.username),
    };
  });
  res.json({ meals: out, hasMore: meals.length === limit });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

// Express 4 does not catch rejected promises from async handlers; forward them to next()
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.post('/api/meals', auth, (req, res, next) => {
  upload.single('photo')(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large (max 15 MB).' : 'Upload failed.' });
    next();
  });
}, asyncHandler(async (req, res) => {
  const cal = Number(req.body.calories);
  if (!Number.isInteger(cal) || cal < 0 || cal > MAX_CALORIES)
    return res.status(400).json({ error: `Calories must be a whole number from 0 to ${MAX_CALORIES}.` });
  let filename = null;
  if (req.file) {
    filename = crypto.randomBytes(16).toString('hex') + '.jpg';
    try {
      await sharp(req.file.buffer).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 }).toFile(path.join(PHOTO_DIR, filename));
    } catch {
      fs.unlink(path.join(PHOTO_DIR, filename), () => {});
      return res.status(400).json({ error: 'That file is not a supported image (use JPG, PNG or WebP).' });
    }
  }
  try {
    const now = Date.now();
    const id = Number(db.prepare('INSERT INTO meals (user_id, calories, photo, day, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, cal, filename, dayString(now), now).lastInsertRowid);
    res.json({ id });
  } catch (e) {
    console.error('Failed to save meal:', e);
    if (filename) fs.unlink(path.join(PHOTO_DIR, filename), () => {});
    res.status(500).json({ error: 'Server error' });
  }
}));

app.delete('/api/meals/:id', auth, (req, res) => {
  const meal = db.prepare('SELECT * FROM meals WHERE id = ?').get(parseInt(req.params.id));
  if (!meal) return res.status(404).json({ error: 'Meal not found.' });
  if (meal.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own meals.' });
  db.prepare('DELETE FROM meals WHERE id = ?').run(meal.id);
  if (meal.photo) fs.unlink(path.join(PHOTO_DIR, meal.photo), () => {});
  res.json({ ok: true });
});

app.post('/api/meals/:id/like', auth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.prepare('SELECT 1 FROM meals WHERE id = ?').get(id)) return res.status(404).json({ error: 'Meal not found.' });
  const del = db.prepare('DELETE FROM likes WHERE meal_id = ? AND user_id = ?').run(id, req.user.id);
  if (del.changes === 0) db.prepare('INSERT INTO likes (meal_id, user_id) VALUES (?, ?)').run(id, req.user.id);
  res.json({ liked: del.changes === 0 });
});

const MAX_COMMENT = 300;
app.post('/api/meals/:id/comments', auth, (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.prepare('SELECT 1 FROM meals WHERE id = ?').get(id)) return res.status(404).json({ error: 'Meal not found.' });
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (body.length > MAX_COMMENT) return res.status(400).json({ error: `Comment is too long (max ${MAX_COMMENT} characters).` });
  const now = Date.now();
  const cid = Number(db.prepare('INSERT INTO comments (meal_id, user_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(id, req.user.id, body, now).lastInsertRowid);
  res.json({ id: cid });
});

app.delete('/api/comments/:id', auth, (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(parseInt(req.params.id));
  if (!c) return res.status(404).json({ error: 'Comment not found.' });
  if (c.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own comments.' });
  db.prepare('DELETE FROM comments WHERE id = ?').run(c.id);
  res.json({ ok: true });
});

// Photos only for signed-in users
app.use('/photos', auth, express.static(PHOTO_DIR, { maxAge: '7d', immutable: true, setHeaders: res => res.set('Cache-Control', 'private, max-age=604800, immutable'), index: false, dotfiles: 'deny' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Final error handler: anything thrown or passed to next(err) ends up here
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) err.status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return next(err);
  const message = status >= 500 ? 'Server error'
    : (err.expose || err instanceof multer.MulterError) && err.message ? err.message : 'Bad request';
  res.status(status).json({ error: message });
});

app.listen(PORT, () => console.log(`Family meals app on http://localhost:${PORT} (timezone: ${TIMEZONE})`));
