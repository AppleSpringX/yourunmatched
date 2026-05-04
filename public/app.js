// Unmatched Club — Telegram Mini App (vanilla JS, hash router, no build)

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
// Force light theme on TG header/background — overrides user's TG dark mode for our app.
try {
  tg?.setBackgroundColor?.('#fef9f0');
  tg?.setHeaderColor?.('#fef9f0');
} catch {}

const status = document.getElementById('topbar-status');
const screen = document.getElementById('screen');

const state = {
  me: null,
  heroes: null,
};

// Top-3 medals — used everywhere a player name appears.
function medalEmoji(rank) {
  if (rank === 1) return '🏆';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return '';
}
function medalSpan(rank) {
  const m = medalEmoji(rank);
  return m ? `<span class="medal rank-${rank}">${m}</span>` : '';
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'request_failed');
  }
  return res.json();
}

async function authenticate() {
  if (!tg?.initData) {
    status.textContent = 'Открой через Telegram';
    return false;
  }
  status.textContent = 'Вход…';
  const r = await api('/auth/telegram', {
    method: 'POST',
    body: JSON.stringify({ initData: tg.initData }),
  });
  state.me = r.user;
  updateTopbar();
  return true;
}

function updateTopbar() {
  if (!state.me) return;
  const m = medalEmoji(state.me.rank);
  status.innerHTML = `${m ? m + ' ' : ''}${escape(state.me.display_name)}`;
}

const routes = {
  '/players': renderPlayers,
  '/rooms': renderRooms,
  '/tournaments': renderTournaments,
  '/profile': renderProfile,
  '/player': renderPlayerDetail,
};

function navigate() {
  const hash = location.hash.slice(1) || '/players';
  const [path] = hash.split('?');
  const segs = path.split('/').filter(Boolean);
  const route = '/' + (segs[0] || 'players');

  document.querySelectorAll('#tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === segs[0]);
  });

  const handler = routes[route] || renderNotFound;
  screen.innerHTML = '<div class="empty">Загрузка…</div>';
  Promise.resolve(handler(segs.slice(1))).catch((e) => {
    screen.innerHTML = `<div class="empty">Ошибка: ${escape(e.message)}</div>`;
  });
}

window.addEventListener('hashchange', navigate);

const TAB_LABELS = [
  { key: 'overall', label: 'Все' },
  { key: '1v1', label: '1 на 1' },
  { key: '2v2', label: '2 на 2' },
  { key: 'ffa', label: 'FFA' },
];

async function renderPlayers() {
  const sort = new URLSearchParams(location.hash.split('?')[1] || '').get('sort') || 'overall';

  const { players } = await api(`/players?sort=${sort}`);

  screen.innerHTML = `
    <div class="tabs">${TAB_LABELS.map((t) => `
      <button class="${t.key === sort ? 'active' : ''}" data-sort="${t.key}">${t.label}</button>
    `).join('')}</div>
    <div class="card" id="player-list"></div>
  `;

  screen.querySelectorAll('.tabs button').forEach((btn) => {
    btn.onclick = () => {
      location.hash = `#/players?sort=${btn.dataset.sort}`;
    };
  });

  const list = screen.querySelector('#player-list');
  if (!players.length) {
    list.innerHTML = '<div class="empty">Пока никто не сыграл ни одной партии.</div>';
    return;
  }
  list.innerHTML = players.map((p) => {
    const heroLabel = p.hero_name || p.signature_custom || '—';
    const avatar = playerAvatarStyle(p);
    const meta = `${escape(heroLabel)} · ${formatGamesCount(p.games_played)}`;
    return `
      <a href="#/player/${p.tg_id}" class="player-row" style="text-decoration:none;color:inherit;">
        <div class="avatar" style="${avatar}"></div>
        <div>
          <div class="player-name">${medalSpan(p.rank)}${escape(p.display_name)}</div>
          <div class="player-meta">${meta}</div>
        </div>
        <div class="points ${p.points ? '' : 'dim'}">${p.points}</div>
      </a>
    `;
  }).join('');
}

async function renderRooms() {
  screen.innerHTML = `
    <div class="empty">Комнаты появятся в следующем обновлении.</div>
    <div class="row" style="justify-content:center;">
      <button disabled>Создать комнату</button>
    </div>
  `;
}

async function renderTournaments() {
  screen.innerHTML = `<div class="empty">Турниры подъедут после комнат.</div>`;
}

async function renderProfile() {
  if (!state.heroes) {
    const { heroes } = await api('/heroes');
    state.heroes = heroes;
  }
  const me = (await api('/me')).user;
  state.me = me;
  updateTopbar();

  const sets = [...new Set(state.heroes.map((h) => h.set_name))];
  const heroOptions = sets.map((s) => `
    <optgroup label="${escape(s)}">
      ${state.heroes.filter((h) => h.set_name === s).map((h) =>
        `<option value="${h.id}" ${me.signature_hero_id === h.id ? 'selected' : ''}>${escape(h.name)}</option>`
      ).join('')}
    </optgroup>
  `).join('');

  screen.innerHTML = `
    <div class="card profile-hero">
      <div class="avatar" style="${playerAvatarStyle(me)}"></div>
      <div>
        <div class="name">${medalSpan(me.rank)}${escape(me.display_name || '')}</div>
        <div class="sub">${escape(me.hero?.name || me.signature_custom || 'герой не выбран')}</div>
      </div>
    </div>

    <div class="card">
      <label>Имя</label>
      <input id="f-name" value="${escape(me.display_name || '')}" maxlength="64" />

      <label>Сигнатурный герой</label>
      <select id="f-hero">
        <option value="">— не выбран —</option>
        ${heroOptions}
      </select>

      <label>…или своя колода (если героя нет в списке)</label>
      <input id="f-custom" value="${escape(me.signature_custom || '')}" maxlength="64" placeholder="Название колоды" />

      <div class="row" style="margin-top:16px;">
        <button id="f-save">Сохранить</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:14px;line-height:1.5;">
        Аватарку можно поменять — отправь любую фотку боту в личку.
      </p>
    </div>
  `;

  screen.querySelector('#f-save').onclick = async (e) => {
    e.target.disabled = true;
    const display_name = screen.querySelector('#f-name').value.trim();
    const heroId = screen.querySelector('#f-hero').value;
    const custom = screen.querySelector('#f-custom').value.trim();
    const body = { display_name };
    if (heroId) body.signature_hero_id = Number(heroId);
    else body.signature_custom = custom;
    try {
      const r = await api('/me', { method: 'PUT', body: JSON.stringify(body) });
      state.me = r.user;
      updateTopbar();
      tg?.HapticFeedback?.notificationOccurred('success');
      // Re-render to show fresh hero label
      renderProfile();
    } catch (err) {
      alert('Не сохранилось: ' + err.message);
    }
    e.target.disabled = false;
  };
}

async function renderPlayerDetail([tgId]) {
  if (!tgId) return renderNotFound();
  const { user, totals, heroStats, recent } = await api(`/players/${tgId}`);
  const heroLabel = user.hero_name || user.signature_custom || 'герой не выбран';
  screen.innerHTML = `
    <div class="card profile-hero">
      <div class="avatar" style="${playerAvatarStyle(user)}"></div>
      <div>
        <div class="name">${medalSpan(user.rank)}${escape(user.display_name)}</div>
        <div class="sub">${escape(heroLabel)}</div>
      </div>
    </div>

    <div class="card stats-strip">
      <div class="cell"><div class="v">${totals.pts_overall || 0}</div><div class="l">Всего</div></div>
      <div class="cell"><div class="v">${totals.pts_1v1 || 0}</div><div class="l">1v1</div></div>
      <div class="cell"><div class="v">${totals.pts_2v2 || 0}</div><div class="l">2v2</div></div>
      <div class="cell"><div class="v">${totals.pts_ffa || 0}</div><div class="l">FFA</div></div>
    </div>

    <div class="card" style="padding:14px 16px;">
      <div class="muted" style="font-size:13px;">
        Сыграно: <b style="color:var(--text)">${totals.games_played || 0}</b> · Побед: <b style="color:var(--text)">${totals.wins || 0}</b>
      </div>
    </div>

    ${heroStats.length ? `
      <h3 class="section-title">Колоды</h3>
      <div class="card">
        ${heroStats.map((h) => `
          <div class="player-row">
            <div class="avatar" style="${heroAvatarStyle(h.hero_slug)}"></div>
            <div>
              <div class="player-name">${escape(h.hero_name)}</div>
              <div class="player-meta">${formatGamesCount(h.games)} · ${Math.round((h.wins / h.games) * 100)}% побед</div>
            </div>
            <div class="points ${h.points ? '' : 'dim'}">${h.points}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${recent.length ? `
      <h3 class="section-title">Недавние партии</h3>
      <div class="card">
        ${recent.map((r) => `
          <div class="history-row">
            <div>
              <span class="game-type ${r.is_winner ? 'winner' : ''}">${gameTypeLabel(r.type)}</span>
              <b>${escape(r.hero_name || '—')}</b>
              <div class="player-meta" style="margin-top:4px;">
                ${formatDate(r.finished_at)}${r.notes ? ' · ' + escape(r.notes) : ''}
              </div>
            </div>
            <div class="points ${r.points_awarded ? '' : 'dim'}">${r.is_winner ? '🏆 ' : ''}${r.points_awarded}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderNotFound() {
  screen.innerHTML = `<div class="empty">Страница не найдена.</div>`;
}

// — helpers —

function playerAvatarStyle(user) {
  if (user.avatar_file_id) return `background-image:url(/api/avatar/${user.tg_id})`;
  if (user.hero_slug) return `background-image:url(/heroes/${user.hero_slug}.webp)`;
  return `background:var(--accent-soft)`;
}

function heroAvatarStyle(slug) {
  if (slug) return `background-image:url(/heroes/${slug}.webp)`;
  return `background:var(--bg-tile);background-image:none;`;
}

function gameTypeLabel(type) {
  if (type === '1v1') return '1v1';
  if (type === '2v2') return '2v2';
  if (type === 'ffa3') return 'FFA-3';
  if (type === 'ffa4') return 'FFA-4';
  return type;
}

function formatGamesCount(n) {
  const num = Number(n) || 0;
  if (num === 0) return 'нет партий';
  const lastTwo = num % 100;
  const last = num % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${num} партий`;
  if (last === 1) return `${num} партия`;
  if (last >= 2 && last <= 4) return `${num} партии`;
  return `${num} партий`;
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

(async () => {
  const ok = await authenticate();
  if (!ok) {
    screen.innerHTML = `<div class="empty">Открой через бота: команда /start, кнопка «Играть».</div>`;
    return;
  }
  if (!location.hash) location.hash = '#/players';
  navigate();
})();
