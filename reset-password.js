// Admin tool: node reset-password.js <username> <newPassword>
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { validatePassword } = require('./password');

async function main() {
  const [username, pw] = process.argv.slice(2);
  if (!username || !pw) {
    console.error('Usage: node reset-password.js <username> <newPassword (min 6 chars, max 72 bytes)>');
    process.exit(1);
  }
  const pwError = validatePassword(pw);
  if (pwError) { console.error(pwError); process.exit(1); }
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) { console.error('No such user.'); process.exit(1); }
  const hash = await bcrypt.hash(pw, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log(`Password reset for ${username}. They've been signed out everywhere.`);
}

main().catch(e => { console.error(e); process.exit(1); });
