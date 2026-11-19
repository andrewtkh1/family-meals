const $ = id => document.getElementById(id);
let me = null;
let registerMode = false;
let oldestId = null;

async function api(url, opts = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...opts });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && me) { me = null; showAuth(); }
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function showAuth() {
  $('auth').hidden = false; $('app').hidden = true; $('whoami').hidden = true;
}
function setMode(reg) {
  registerMode = reg;
  $('authTitle').textContent = reg ? 'Create account' : 'Sign in';
  $('authSubmit').textContent = reg ? 'Create account' : 'Sign in';
  $('authSwitchText').textContent = reg ? 'Already have an account?' : 'New here?';
  $('authSwitch').textContent = reg ? 'Sign in' : 'Create an account';
  $('authForm').password.autocomplete = reg ? 'new-password' : 'current-password';
  $('authError').textContent = '';
}
$('authSwitch').onclick = () => setMode(!registerMode);

$('authForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  $('authError').textContent = '';
  try {
    me = await api(registerMode ? '/api/register' : '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: f.username.value.trim(), password: f.password.value }),
    });
    f.reset();
    await enterApp();
  } catch (err) { $('authError').textContent = err.message; }
};

$('logout').onclick = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  me = null; showAuth();
};

async function enterApp() {
  $('auth').hidden = true; $('app').hidden = false; $('whoami').hidden = false;
  $('who').textContent = me.username;
  await refresh();
}

async function refresh() {
  await Promise.all([loadTotals(), loadFeed(true)]);
}

async function loadTotals() {
  const t = await api('/api/today');
  $('today').textContent = t.day;
  const ul = $('totals'); ul.replaceChildren();
  for (const u of t.users) {
    const li = document.createElement('li');
    if (u.username === me.username) li.className = 'me';
    const n = document.createElement('span'); n.textContent = u.username + (u.username === me.username ? ' (you)' : '');
    const c = document.createElement('span'); c.textContent = u.calories + ' kcal';
    li.append(n, c); ul.append(li);
  }
}

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function mealEl(m) {
  const d = document.createElement('article'); d.className = 'meal'; d.dataset.id = m.id;
  if (m.photo) {
    const img = document.createElement('img'); img.src = m.photo; img.loading = 'lazy'; img.alt = `Meal by ${m.username}`;
    d.append(img);
  }
  const b = document.createElement('div'); b.className = 'body';
  const top = document.createElement('div'); top.className = 'top';
  const who = document.createElement('strong'); who.textContent = m.username;
  const when = document.createElement('span'); when.className = 'muted'; when.textContent = timeAgo(m.created_at);
  top.append(who, when);
  const cal = document.createElement('div'); cal.className = 'cal'; cal.textContent = m.calories + ' kcal';
  const act = document.createElement('div'); act.className = 'actions';
  const like = document.createElement('button'); like.className = 'like' + (m.liked ? ' on' : '');
  like.textContent = `${m.liked ? '❤️' : '🤍'} ${m.like_count}`;
  like.onclick = async () => {
    like.disabled = true;
    try { await api(`/api/meals/${m.id}/like`, { method: 'POST' }); await loadFeed(true); }
    catch (e) { alert(e.message); like.disabled = false; }
  };
  act.append(like);
  if (m.mine) {
    const del = document.createElement('button'); del.className = 'del'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm('Delete this meal? This cannot be undone.')) return;
      try { await api(`/api/meals/${m.id}`, { method: 'DELETE' }); await refresh(); }
      catch (e) { alert(e.message); }
    };
    act.append(del);
  }
  b.append(top, cal, act);
  if (m.likers.length) {
    const l = document.createElement('div'); l.className = 'likers'; l.textContent = 'Liked by ' + m.likers.join(', ');
    b.append(l);
  }
  d.append(b);
  return d;
}

// reset=true reloads from the newest meals; otherwise appends the next page
async function loadFeed(reset) {
  const feed = $('feed');
  let url = '/api/feed?limit=10';
  if (!reset && oldestId) url += `&before=${oldestId}`;
  // On reset, reload at least as many meals as already shown so a like doesn't collapse the list
  if (reset) url = `/api/feed?limit=${Math.min(Math.max(feed.children.length, 10), 30)}`;
  const { meals, hasMore } = await api(url);
  if (reset) feed.replaceChildren();
  for (const m of meals) feed.append(mealEl(m));
  if (meals.length) oldestId = meals[meals.length - 1].id;
  $('more').hidden = !hasMore;
  $('empty').hidden = feed.children.length > 0;
}
$('more').onclick = () => loadFeed(false).catch(e => alert(e.message));

$('mealForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target; $('mealError').textContent = '';
  const fd = new FormData();
  fd.append('calories', f.calories.value);
  if (f.photo.files[0]) fd.append('photo', f.photo.files[0]);
  $('mealSubmit').disabled = true; $('mealSubmit').textContent = 'Posting…';
  try {
    await api('/api/meals', { method: 'POST', body: fd });
    f.reset(); await refresh();
  } catch (err) { $('mealError').textContent = err.message; }
  finally { $('mealSubmit').disabled = false; $('mealSubmit').textContent = 'Post meal'; }
};

(async () => {
  try { me = await api('/api/me'); await enterApp(); }
  catch { showAuth(); }
})();
