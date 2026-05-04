// Unmatched Club — Telegram Mini App
// Vanilla JS, hash router, no build step.

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const status = document.getElementById('topbar-status');
const screen = document.getElementById('screen');

const state = {
  me: null,
  heroes: null,
};

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
  status.textContent = state.me.display_name;
  return true;
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
    screen.innerHTML = `<div class="empty">Ошибка: ${e.message}</div>`;
  });
}

window.addEventListener('hashchange', navigate);

async function renderPlayers() {
  const tabs = [
    { key: 'overall', label: 'Overall' },
    { key: '1v1', label: '1v1' },
    { key: '2v2', label: '2v2' },
    { key: 'ffa', label: 'FFA' },
  ];
  const sort = new URLSearchParams(location.hash.split('?')[1] || '').get('sort') || 'overall';

  const { players } = await api(`/players?sort=${sort}`);

  screen.innerHTML = `
    <div class="tabs">${tabs.map((t) => `
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
    list.innerHTML = '<div class="empty">Пока никто не сыграл ни одной игры.</div>';
    return;
  }
  list.innerHTML = players.map((p) => {
    const heroLabel = p.hero_name || p.signature_custom || '—';
    const avatar = p.avatar_file_id
      ? `url(/api/avatar/${p.tg_id})`
      : p.hero_slug ? `url(/heroes/${p.hero_slug}.webp)` : '';
    return `
      <a href="#/player/${p.tg_id}" class="player-row" style="text-decoration:none;color:inherit;">
        <div class="avatar" style="background-image:${avatar}"></div>
        <div>
          <div class="player-name">${escape(p.display_name)}</div>
          <div class="player-meta">${escape(heroLabel)} · игр: ${p.games_played}</div>
        </div>
        <div class="points">${p.points}</div>
      </a>
    `;
  }).join('');
}

async function renderRooms() {
  screen.innerHTML = `
    <div class="empty">Комнаты появятся в следующем шаге.</div>
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

  const sets = [...new Set(state.heroes.map((h) => h.set_name))];
  const heroOptions = sets.map((s) => `
    <optgroup label="${escape(s)}">
      ${state.heroes.filter((h) => h.set_name === s).map((h) =>
        `<option value="${h.id}" ${me.signature_hero_id === h.id ? 'selected' : ''}>${escape(h.name)}</option>`
      ).join('')}
    </optgroup>
  `).join('');

  screen.innerHTML = `
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

      <div class="row" style="margin-top:14px;">
        <button id="f-save">Сохранить</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:14px;">
        Аватарку можно сменить, отправив фото боту в личку.
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
      await api('/me', { method: 'PUT', body: JSON.stringify(body) });
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (err) {
      alert('Не сохранилось: ' + err.message);
    }
    e.target.disabled = false;
  };
}

async function renderPlayerDetail([tgId]) {
  if (!tgId) return renderNotFound();
  const { user, totals, heroStats, recent } = await api(`/players/${tgId}`);
  const heroLabel = user.hero_name || user.signature_custom || '—';
  screen.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="avatar" style="width:56px;height:56px;background-image:${
          user.avatar_file_id ? `url(/api/avatar/${user.tg_id})`
          : user.hero_slug ? `url(/heroes/${user.hero_slug}.webp)` : ''
        }"></div>
        <div>
          <div style="font-weight:600;font-size:17px;">${escape(user.display_name)}</div>
          <div class="muted">${escape(heroLabel)}</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <div><b>${totals.pts_overall || 0}</b> <span class="muted">всего</span></div>
        <div><b>${totals.pts_1v1 || 0}</b> <span class="muted">1v1</span></div>
        <div><b>${totals.pts_2v2 || 0}</b> <span class="muted">2v2</span></div>
        <div><b>${totals.pts_ffa || 0}</b> <span class="muted">FFA</span></div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px;">
        Сыграно: ${totals.games_played || 0} · Побед: ${totals.wins || 0}
      </div>
    </div>
    ${heroStats.length ? `
      <h3 style="margin:16px 0 8px;font-size:14px;color:var(--text-muted);text-transform:uppercase;">Колоды</h3>
      <div class="card">
        ${heroStats.map((h) => `
          <div class="player-row">
            <div class="avatar" style="background-image:${h.hero_slug ? `url(/heroes/${h.hero_slug}.webp)` : ''}"></div>
            <div>
              <div class="player-name">${escape(h.hero_name)}</div>
              <div class="player-meta">${h.games} игр · ${Math.round((h.wins / h.games) * 100)}% винрейт</div>
            </div>
            <div class="points">${h.points}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
    ${recent.length ? `
      <h3 style="margin:16px 0 8px;font-size:14px;color:var(--text-muted);text-transform:uppercase;">Недавние игры</h3>
      <div class="card">
        ${recent.map((r) => `
          <div class="player-row">
            <div></div>
            <div>
              <div class="player-name">${r.type.toUpperCase()} · ${escape(r.hero_name || '—')}</div>
              <div class="player-meta">${new Date(r.finished_at).toLocaleDateString()}${r.notes ? ' · ' + escape(r.notes) : ''}</div>
            </div>
            <div class="points">${r.is_winner ? '🏆 ' : ''}${r.points_awarded}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function renderNotFound() {
  screen.innerHTML = `<div class="empty">Страница не найдена.</div>`;
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

(async () => {
  const ok = await authenticate();
  if (!ok) {
    screen.innerHTML = `<div class="empty">Открой через бота: команда /start, кнопка «Open app».</div>`;
    return;
  }
  if (!location.hash) location.hash = '#/players';
  navigate();
})();
