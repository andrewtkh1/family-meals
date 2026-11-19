// Admin tool: node reset-password.js <username> <newPassword>
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const [username, pw] = process.argv.slice(2);
if (!username || !pw || pw.length < 6) {
  console.error('Usage: node reset-password.js <username> <newPassword (min 6 chars)>');
  process.exit(1);
}
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) { console.error('No such user.'); process.exit(1); }
db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log(`Password reset for ${username}. They've been signed out everywhere.`);
