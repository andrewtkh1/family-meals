// Shared password rules. bcrypt only uses the first 72 UTF-8 bytes of a
// password, so anything longer would be silently truncated — reject it instead.
const MIN_PASSWORD_CHARS = 6;
const MAX_PASSWORD_BYTES = 72;

function validatePassword(pw) {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < MIN_PASSWORD_CHARS) return `Password must be at least ${MIN_PASSWORD_CHARS} characters.`;
  if (Buffer.byteLength(pw, 'utf8') > MAX_PASSWORD_BYTES)
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes (fewer characters if using emoji or accented letters).`;
  return null;
}

module.exports = { validatePassword, MIN_PASSWORD_CHARS, MAX_PASSWORD_BYTES };
