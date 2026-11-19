const $ = id => document.getElementById(id);
let me = null;
let registerMode = false;
let oldestId = null;
const expanded = new Set();   // meal ids whose full comment list is shown

// ---------- helpers ----------
async function api(url, opts = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON or empty body; keep {} */ }
  if (res.status === 401 && me) { me = null; showAuth(); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function hue(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function avatar(name, small) {
  const a = document.createElement('span');
  a.className = 'avatar' + (small ? ' sm' : '');
  a.textContent = name[0].toUpperCase();
  a.style.background = `hsl(${hue(name)} 55% 50%)`;
  return a;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------- auth ----------
function showAuth() { stopAutoRefresh(); $('auth').hidden = false; $('app').hidden = true; $('whoami').hidden = true; }
function setMode(reg) {
  registerMode = reg;
  $('authTitle').textContent = reg ? 'Join the family' : 'Welcome back';
  $('authSub').textContent = reg ? 'Create your account to start sharing meals.' : 'Sign in to see what the family is eating.';
  $('authSubmit').textContent = reg ? 'Create account' : 'Sign in';
  $('authSwitchText').textContent = reg ? 'Already have an account?' : 'New here?';
  $('authSwitch').textContent = reg ? 'Sign in' : 'Create an account';
  $('authForm').password.autocomplete = reg ? 'new-password' : 'current-password';
  $('authError').textContent = '';
}
$('authSwitch').onclick = () => setMode(!registerMode);

$('authForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target; $('authError').textContent = '';
  try {
    me = await api(registerMode ? '/api/register' : '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: f.username.value.trim(), password: f.password.value }),
    });
    f.reset(); await enterApp();
  } catch (err) { $('authError').textContent = err.message; }
};

$('logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  me = null; showAuth();
};

async function enterApp() {
  $('auth').hidden = true; $('app').hidden = false; $('whoami').hidden = false;
  $('who').textContent = me.username;
  $('whoAvatar').replaceWith(Object.assign(avatar(me.username, true), { id: 'whoAvatar' }));
  await refresh();
  startAutoRefresh();
}

async function refresh() { await Promise.all([loadTotals(), loadFeed(true)]); }

// ---------- auto-refresh (poll while visible, and on returning to the tab) ----------
const POLL_MS = 60000;
let pollTimer = null;
let polling = false;     // in-flight guard
let shownDay = null;     // last /api/today day rendered

function startAutoRefresh() {
  stopAutoRefresh();
  pollTimer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
}
function stopAutoRefresh() { clearInterval(pollTimer); pollTimer = null; shownDay = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && pollTimer) poll(); });

// true while the user is typing a comment, so we never rebuild the feed under them
function composing() {
  const a = document.activeElement;
  if (a?.dataset?.draft) return true;
  return [...$('feed').querySelectorAll('input[data-draft]')].some(i => i.value);
}

async function poll() {
  if (polling || !me) return;
  polling = true;
  try {
    const prevDay = shownDay;
    await loadTotals();
    if (prevDay && shownDay !== prevDay && !composing()) { await loadFeed(true); return; }
    await prependNewMeals();
  } catch { /* transient network error; retry next poll */ } finally { polling = false; }
}

// Add meals newer than the top card without rebuilding the feed (keeps drafts, focus, scroll).
async function prependNewMeals() {
  const feed = $('feed');
  const topId = Number(feed.firstElementChild?.dataset.id) || 0;
  const { meals, hasMore } = await api('/api/feed?limit=10');
  const fresh = meals.filter(m => m.id > topId);
  if (!fresh.length || !me) return;
  if (topId && fresh.length === meals.length) {   // gap we can't fill from one page
    if (!composing()) await loadFeed(true);
    return;
  }
  // keep whatever the user is looking at in place as cards are inserted above it
  const anchor = [...feed.children].find(c => c.getBoundingClientRect().bottom > 0);
  const before = anchor?.getBoundingClientRect().top;
  const frag = document.createDocumentFragment();
  for (const m of fresh) frag.append(mealEl(m));
  feed.prepend(frag);
  if (anchor) { const d = anchor.getBoundingClientRect().top - before; if (d) window.scrollBy(0, d); }
  if (!topId) { oldestId = meals[meals.length - 1].id; $('more').hidden = !hasMore; }
  $('empty').hidden = feed.children.length > 0;
}

// ---------- today's totals ----------
async function loadTotals() {
  const t = await api('/api/today');
  $('today').textContent = t.day; shownDay = t.day;
  const scale = Math.max(2000, ...t.users.map(u => u.calories));
  const ul = $('totals'); ul.replaceChildren();
  let sum = 0;
  for (const u of t.users) {
    sum += u.calories;
    const li = el('li');
    const name = el('div', 'name', u.username);
    if (u.username === me.username) name.append(el('small', '', '(you)'));
    const kcal = el('div', 'kcal', String(u.calories)); kcal.append(el('small', '', ' kcal'));
    const bar = el('div', 'bar'); const fill = el('span');
    fill.style.width = (u.calories / scale * 100) + '%';
    fill.style.background = `hsl(${hue(u.username)} 55% 50%)`;
    bar.append(fill);
    const nameWrap = el('div'); nameWrap.append(name);
    li.append(avatar(u.username), nameWrap, kcal, bar);
    ul.append(li);
  }
  $('familyTotal').textContent = sum;
}

// ---------- feed ----------
function commentEl(c) {
  const row = el('div', 'comment');
  row.append(avatar(c.username, true));
  const bubble = el('div', 'bubble');
  bubble.append(el('b', '', c.username), document.createTextNode(c.body), el('span', 't', timeAgo(c.created_at)));
  row.append(bubble);
  if (c.mine) {
    const x = el('button', 'x', '✕'); x.title = 'Delete comment'; x.setAttribute('aria-label', 'Delete comment');
    x.onclick = async () => {
      if (!confirm('Delete this comment?')) return;
      try { await api(`/api/comments/${c.id}`, { method: 'DELETE' }); await loadFeed(true); }
      catch (e) { toast(e.message); }
    };
    row.append(x);
  }
  return row;
}

function mealEl(m) {
  const d = el('article', 'meal'); d.dataset.id = m.id;

  const head = el('div', 'meal-head');
  const info = el('div', 'info');
  info.append(el('strong', '', m.username), el('span', '', timeAgo(m.created_at)));
  head.append(avatar(m.username), info, el('span', 'kcal-badge', m.calories + ' kcal'));
  d.append(head);

  if (m.photo) {
    const img = el('img', 'photo'); img.src = m.photo; img.loading = 'lazy'; img.alt = `Meal by ${m.username}`;
    d.append(img);
  }

  const body = el('div', 'meal-body');
  const act = el('div', 'actions');
  const like = el('button', 'pill' + (m.liked ? ' on' : ''), `${m.liked ? '❤️' : '🤍'} ${m.like_count}`);
  like.setAttribute('aria-pressed', m.liked);
  like.onclick = async () => {
    like.disabled = true;
    try { await api(`/api/meals/${m.id}/like`, { method: 'POST' }); await loadFeed(true, m.id); }
    catch (e) { toast(e.message); like.disabled = false; }
  };
  const cbtn = el('button', 'pill', `💬 ${m.comments.length}`);
  cbtn.onclick = () => d.querySelector('.cform input').focus();
  act.append(like, cbtn);
  if (m.mine) {
    const del = el('button', 'del', 'Delete');
    del.onclick = async () => {
      if (!confirm('Delete this meal? This cannot be undone.')) return;
      try { await api(`/api/meals/${m.id}`, { method: 'DELETE' }); await refresh(); toast('Meal deleted'); }
      catch (e) { toast(e.message); }
    };
    act.append(del);
  }
  body.append(act);
  if (m.likers.length) body.append(el('div', 'likers', 'Liked by ' + m.likers.join(', ')));

  const cs = el('div', 'comments');
  const shown = expanded.has(m.id) ? m.comments : m.comments.slice(-2);
  if (m.comments.length > shown.length) {
    const va = el('button', 'viewall', `View all ${m.comments.length} comments`);
    va.onclick = () => { expanded.add(m.id); loadFeed(true); };
    cs.append(va);
  }
  for (const c of shown) cs.append(commentEl(c));

  const form = el('form', 'cform');
  const input = el('input'); input.placeholder = 'Add a comment…'; input.maxLength = 300; input.setAttribute('aria-label', 'Add a comment');
  input.dataset.draft = m.id;
  const send = el('button', 'primary', 'Send'); send.type = 'submit';
  form.append(input, send);
  form.onsubmit = async e => {
    e.preventDefault();
    const text = input.value.trim(); if (!text) return;
    send.disabled = true;
    try {
      await api(`/api/meals/${m.id}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text }),
      });
      input.value = ''; expanded.add(m.id); await loadFeed(true);
    } catch (err) { toast(err.message); send.disabled = false; }
  };
  cs.append(form);
  body.append(cs);
  d.append(body);
  return d;
}

// reset=true reloads from the newest meals; otherwise appends the next page
async function loadFeed(reset, popId) {
  const feed = $('feed');
  let url;
  if (reset) url = `/api/feed?limit=${Math.min(Math.max(feed.children.length, 10), 30)}`;
  else url = '/api/feed?limit=10' + (oldestId ? `&before=${oldestId}` : '');
  // keep unsent comment drafts and focus across a rebuild
  const drafts = {};
  feed.querySelectorAll('input[data-draft]').forEach(i => { if (i.value) drafts[i.dataset.draft] = i.value; });
  const focusedId = document.activeElement?.dataset?.draft;
  const { meals, hasMore } = await api(url);
  if (reset) feed.replaceChildren();
  for (const m of meals) feed.append(mealEl(m));
  for (const [id, v] of Object.entries(drafts)) {
    const i = feed.querySelector(`input[data-draft="${id}"]`); if (i) i.value = v;
  }
  if (focusedId) feed.querySelector(`input[data-draft="${focusedId}"]`)?.focus();
  if (popId) feed.querySelector(`.meal[data-id="${popId}"] .pill`)?.classList.add('pop');
  if (meals.length) oldestId = meals[meals.length - 1].id;
  $('more').hidden = !hasMore;
  $('empty').hidden = feed.children.length > 0;
}
$('more').onclick = () => loadFeed(false).catch(e => toast(e.message));

// ---------- add meal ----------
$('photoInput').onchange = e => {
  const file = e.target.files[0];
  const img = $('photoPreview');
  if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
  if (!file) { img.hidden = true; $('photoHint').hidden = false; return; }
  img.src = URL.createObjectURL(file); img.hidden = false; $('photoHint').hidden = true;
};

$('mealForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target; $('mealError').textContent = '';
  const fd = new FormData();
  fd.append('calories', f.calories.value);
  if (f.photo.files[0]) fd.append('photo', f.photo.files[0]);
  $('mealSubmit').disabled = true; $('mealSubmit').textContent = 'Posting…';
  try {
    await api('/api/meals', { method: 'POST', body: fd });
    f.reset(); $('photoPreview').hidden = true; $('photoHint').hidden = false;
    await refresh(); toast('Meal posted 🎉');
  } catch (err) { $('mealError').textContent = err.message; }
  finally { $('mealSubmit').disabled = false; $('mealSubmit').textContent = 'Post'; }
};

(async () => {
  try { me = await api('/api/me'); await enterApp(); }
  catch { showAuth(); }
})();
