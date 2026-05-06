// Unmatched Club — Telegram Mini App (vanilla JS, hash router, no build)

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

// Bot username for deep links (must match what's set in BotFather).
const BOT_USERNAME = 'yourunmatchedbot';
// Force light parchment theme on TG header/background.
// Color must match --bg in app.css to avoid seam between TG chrome and our content.
try {
  tg?.setBackgroundColor?.('#e9e0c8');
  tg?.setHeaderColor?.('#e9e0c8');
} catch {}

const status = document.getElementById('topbar-status');
const screen = document.getElementById('screen');

const state = {
  me: null,
  heroes: null,
  pollTimer: null,
  draftSearch: '',
};

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// Auto-refresh helper: skips fetches when the tab is hidden (battery/data),
// stops itself once the user navigates to a different route.
function startPolling(fn, intervalMs) {
  stopPolling();
  const expectedHash = location.hash;
  state.pollTimer = setInterval(() => {
    if (document.hidden) return; // don't poll in background
    if (location.hash !== expectedHash) { stopPolling(); return; }
    fn();
  }, intervalMs);
}

// Toast — non-blocking notification at the bottom of the screen.
// Includes haptic feedback so success/error are felt as well as seen on mobile.
function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
  try {
    if (type === 'error') tg?.HapticFeedback?.notificationOccurred?.('error');
    else if (type === 'success') tg?.HapticFeedback?.notificationOccurred?.('success');
  } catch {}
}

// Replace the spinner text with an actual visual.
function showSpinner() {
  screen.innerHTML = '<div class="spinner"></div>';
}

// Heroes are stable: cache in localStorage to skip a refetch on cold starts.
// Background-refresh keeps it current across releases.
const HEROES_CACHE_KEY = 'unmatched-heroes-v1';
async function ensureHeroes() {
  if (state.heroes) return state.heroes;
  // 1) Try local cache for instant render
  try {
    const cached = JSON.parse(localStorage.getItem(HEROES_CACHE_KEY) || 'null');
    if (Array.isArray(cached) && cached.length > 0) {
      state.heroes = cached;
      // refresh in background (don't await)
      api('/heroes').then(({ heroes }) => {
        state.heroes = heroes;
        try { localStorage.setItem(HEROES_CACHE_KEY, JSON.stringify(heroes)); } catch {}
      }).catch(() => {});
      return state.heroes;
    }
  } catch {}
  // 2) No cache — fetch
  const { heroes } = await api('/heroes');
  state.heroes = heroes;
  try { localStorage.setItem(HEROES_CACHE_KEY, JSON.stringify(heroes)); } catch {}
  return state.heroes;
}

function heroById(id) {
  return state.heroes?.find((h) => h.id === id);
}

// — top-3 medal helpers —

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

// — fetch wrapper —

async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const init = {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  };
  // Fastify rejects empty body when content-type is application/json. Send {} for body-less mutations.
  if (method !== 'GET' && method !== 'HEAD' && !init.body) {
    init.body = '{}';
  }
  const res = await fetch('/api' + path, init);
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
  const adminBadge = state.me.isAdmin ? '<span style="color:var(--gold);font-weight:700;"> 👑</span>' : '';
  status.innerHTML = `${m ? m + ' ' : ''}${escape(state.me.display_name)}${adminBadge}`;
}

// — router —

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

  // Unknown route → redirect to top players (fixes 'page not found' splash on entry
  // when TG passes a stale or junk hash).
  if (!routes[route]) {
    location.replace('#/players');
    return;
  }

  document.querySelectorAll('#tabbar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === segs[0]);
  });

  // Reset render-dedup signature so this fresh navigation always renders.
  state._lastSig = null;
  // Trigger fade-in via class — polling-driven re-renders don't add this class
  // and therefore don't flash the animation every tick.
  screen.classList.add('entering');
  setTimeout(() => screen.classList.remove('entering'), 220);

  const handler = routes[route];
  showSpinner();
  Promise.resolve(handler(segs.slice(1))).catch((e) => {
    screen.innerHTML = `<div class="empty">Ошибка: ${escape(e.message)}</div>`;
  });
}

// Skip a re-render when the polling response is byte-identical to the last one.
// Each polled screen calls this BEFORE building HTML; if it returns true, render is skipped.
function shouldSkipRender(key, signature) {
  if (state._lastSig && state._lastSig.key === key && state._lastSig.sig === signature) return true;
  state._lastSig = { key, sig: signature };
  return false;
}

window.addEventListener('hashchange', () => {
  stopPolling();
  navigate();
});

// — players list / detail —

const PLAYER_TABS = [
  { key: 'overall', label: 'Все' },
  { key: '1v1', label: '1 на 1' },
  { key: '2v2', label: '2 на 2' },
  { key: 'ffa', label: 'FFA' },
];

async function renderPlayers() {
  const sort = new URLSearchParams(location.hash.split('?')[1] || '').get('sort') || 'overall';
  const { players } = await api(`/players?sort=${sort}`);

  screen.innerHTML = `
    <div class="tabs">${PLAYER_TABS.map((t) => `
      <button class="${t.key === sort ? 'active' : ''}" data-sort="${t.key}">${t.label}</button>
    `).join('')}</div>
    <div class="card" id="player-list"></div>
  `;
  screen.querySelectorAll('.tabs button').forEach((btn) => {
    btn.onclick = () => { location.hash = `#/players?sort=${btn.dataset.sort}`; };
  });

  const list = screen.querySelector('#player-list');
  if (!players.length) {
    list.innerHTML = '<div class="empty">Пока никто не сыграл ни одной партии.</div>';
    return;
  }
  list.innerHTML = players.map((p) => {
    const heroLabel = p.hero_name || p.signature_custom || '—';
    return `
      <a href="#/player/${p.tg_id}" class="player-row" style="text-decoration:none;color:inherit;">
        ${playerAvatar(p)}
        <div>
          <div class="player-name">${medalSpan(p.rank)}${escape(p.display_name)}</div>
          <div class="player-meta">${escape(heroLabel)} · ${formatGamesCount(p.games_played)}</div>
        </div>
        <div class="points ${p.points ? '' : 'dim'}">${p.points}</div>
      </a>
    `;
  }).join('');
}

async function renderPlayerDetail([tgId]) {
  if (!tgId) return renderNotFound();
  const { user, totals, heroStats, recent, isOwner, h2h } = await api(`/players/${tgId}`);
  const heroLabel = user.hero_name || user.signature_custom || 'герой не выбран';
  const breakdownHidden = totals?.hidden;

  let h2hCard = '';
  if (h2h) {
    let verdict;
    if (h2h.my_wins > h2h.their_wins) verdict = `Ведёшь`;
    else if (h2h.their_wins > h2h.my_wins) verdict = `Ведёт ${escape(user.display_name)}`;
    else verdict = h2h.games === h2h.my_wins + h2h.their_wins ? 'Ничья' : 'Поровну';
    h2hCard = `
      <h3 class="section-title">Между вами</h3>
      <div class="card" style="text-align:center;padding:20px 16px;">
        <div style="font-size:28px;font-weight:800;letter-spacing:-0.02em;color:var(--accent);">
          ${h2h.my_wins} <span class="muted" style="font-weight:400;">:</span> ${h2h.their_wins}
        </div>
        <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-top:6px;">
          ${verdict} · ${formatGamesCount(h2h.games)}
        </div>
        ${h2h.last_meeting ? `<div class="muted" style="font-size:12px;margin-top:8px;">Последняя встреча: ${formatDate(h2h.last_meeting)}</div>` : ''}
      </div>`;
  }

  const breakdownCard = breakdownHidden
    ? `<div class="card" style="padding:14px 16px;text-align:center;">
        <div style="font-size:22px;font-weight:800;color:var(--accent);">${totals.pts_overall || 0}</div>
        <div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin-top:4px;">очков всего</div>
        <div class="muted" style="font-size:12px;margin-top:8px;">Раскладка по режимам скрыта</div>
       </div>`
    : `<div class="card stats-strip">
         <div class="cell"><div class="v">${totals.pts_overall || 0}</div><div class="l">Всего</div></div>
         <div class="cell"><div class="v">${totals.pts_1v1 || 0}</div><div class="l">1v1</div></div>
         <div class="cell"><div class="v">${totals.pts_2v2 || 0}</div><div class="l">2v2</div></div>
         <div class="cell"><div class="v">${totals.pts_ffa || 0}</div><div class="l">FFA</div></div>
       </div>
       <div class="card" style="padding:14px 16px;">
         <div class="muted" style="font-size:13px;">
           Сыграно: <b style="color:var(--text)">${totals.games_played || 0}</b> · Побед: <b style="color:var(--text)">${totals.wins || 0}</b>
         </div>
       </div>`;

  const heroesSection = heroStats === null
    ? `<h3 class="section-title">Колоды</h3><div class="card empty" style="padding:18px;">Скрыто пользователем</div>`
    : (heroStats.length ? `
        <h3 class="section-title">Колоды</h3>
        <div class="card">
          ${heroStats.map((h) => `
            <div class="player-row">
              ${heroAvatar(h.hero_name, undefined, h.hero_slug)}
              <div>
                <div class="player-name">${escape(h.hero_name)}</div>
                <div class="player-meta">${formatGamesCount(h.games)} · ${Math.round((h.wins / h.games) * 100)}% побед</div>
              </div>
              <div class="points ${h.points ? '' : 'dim'}">${h.points}</div>
            </div>
          `).join('')}
        </div>
      ` : '');

  const recentSection = recent === null
    ? `<h3 class="section-title">Недавние партии</h3><div class="card empty" style="padding:18px;">Скрыто пользователем</div>`
    : (recent.length ? `
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
      ` : '');

  const adminPanel = state.me?.isAdmin ? `
    <h3 class="section-title">Админ-панель</h3>
    <div class="card">
      ${!isOwner ? `
        <button id="admin-edit-name" class="secondary" style="width:100%;margin-bottom:6px;">✎ Сменить имя</button>
        <button id="admin-edit-hero" class="secondary" style="width:100%;margin-bottom:6px;">⚔ Сменить героя</button>
      ` : ''}
      <button id="admin-adjust-points" class="secondary" style="width:100%;margin-bottom:6px;">💯 Изменить очки</button>
      <button id="admin-show-adjustments" class="secondary" style="width:100%;margin-bottom:6px;">📜 История корректировок</button>
      ${!isOwner ? `
        <button id="admin-toggle-privacy" class="secondary" style="width:100%;margin-bottom:6px;">🔓 Сбросить приватность (всё publlic)</button>
        <button id="admin-delete-user" class="secondary" style="width:100%;color:var(--accent);">💀 Удалить пользователя</button>
      ` : ''}
    </div>` : '';

  screen.innerHTML = `
    <div class="card profile-hero">
      ${playerAvatar(user)}
      <div>
        <div class="name">${medalSpan(user.rank)}${escape(user.display_name)}${isOwner ? ' <span class="muted" style="font-size:11px;font-weight:400;">(ты)</span>' : ''}</div>
        <div class="sub">${escape(heroLabel)}</div>
      </div>
    </div>
    ${breakdownCard}
    ${h2hCard}
    ${heroesSection}
    ${recentSection}
    ${adminPanel}
  `;

  // Admin actions
  if (state.me?.isAdmin && !isOwner) {
    screen.querySelector('#admin-edit-name').onclick = async () => {
      const v = prompt(`Новое имя для «${user.display_name}»:`, user.display_name);
      if (!v || !v.trim()) return;
      try {
        await api(`/admin/user/${tgId}`, { method: 'PUT', body: JSON.stringify({ display_name: v.trim() }) });
        renderPlayerDetail([tgId]);
      } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
    };
    screen.querySelector('#admin-edit-hero').onclick = async () => {
      if (!state.heroes) state.heroes = (await api('/heroes')).heroes;
      const choice = prompt('Введи slug героя (например geralt) или 0 чтобы очистить:', '');
      if (choice === null) return;
      const slug = choice.trim();
      if (!slug || slug === '0') {
        await api(`/admin/user/${tgId}`, { method: 'PUT', body: JSON.stringify({ signature_custom: '' }) });
      } else {
        const hero = state.heroes.find((h) => h.slug === slug);
        if (!hero) return toast('Slug не найден', 'error');
        await api(`/admin/user/${tgId}`, { method: 'PUT', body: JSON.stringify({ signature_hero_id: hero.id }) });
      }
      renderPlayerDetail([tgId]);
    };
  }

  // Points-adjustment actions (доступны и для своего профиля)
  if (state.me?.isAdmin) {
    screen.querySelector('#admin-adjust-points').onclick = async () => {
      const cat = prompt(
        `Категория для «${user.display_name}»:\n` +
        `  overall — общий зачёт (только Overall)\n` +
        `  1v1 — 1v1 (плюсуется в Overall)\n` +
        `  2v2 — 2v2 (плюсуется в Overall)\n` +
        `  ffa — FFA 3/4 (плюсуется в Overall)\n` +
        `Введи: overall, 1v1, 2v2 или ffa`,
        'overall',
      );
      if (!cat) return;
      const category = cat.trim();
      if (!['overall', '1v1', '2v2', 'ffa'].includes(category)) {
        return toast('Неверная категория', 'error');
      }
      const deltaStr = prompt(`Сколько очков добавить (можно с минусом, например -5)?`, '');
      if (deltaStr === null) return;
      const delta = Number(deltaStr);
      if (!Number.isInteger(delta) || delta === 0) {
        return toast('Нужно целое ненулевое число', 'error');
      }
      const reason = prompt('Причина (необязательно):', '') || '';
      try {
        await api(`/admin/user/${tgId}/adjust`, {
          method: 'POST',
          body: JSON.stringify({ delta, category, reason: reason.trim() || null }),
        });
        toast(`${delta > 0 ? '+' : ''}${delta} очков (${category})`, 'success');
        renderPlayerDetail([tgId]);
      } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
    };
    screen.querySelector('#admin-show-adjustments').onclick = async () => {
      try {
        const { adjustments } = await api(`/admin/user/${tgId}/adjustments`);
        if (!adjustments.length) return toast('Корректировок нет', 'info');
        const list = adjustments.map((a) => {
          const d = new Date(a.created_at).toLocaleString();
          const sign = a.delta > 0 ? '+' : '';
          const reason = a.reason ? ` — ${a.reason}` : '';
          const by = a.by_name ? ` by ${a.by_name}` : '';
          return `#${a.id} [${d}] ${sign}${a.delta} (${a.category})${reason}${by}`;
        }).join('\n');
        const undoStr = prompt(
          `Корректировки для «${user.display_name}»:\n\n${list}\n\n` +
          `Чтобы откатить — введи ID. Чтобы выйти — Cancel.`,
          '',
        );
        if (!undoStr) return;
        const undoId = Number(undoStr.trim());
        if (!Number.isInteger(undoId)) return toast('Неверный ID', 'error');
        if (!confirm(`Откатить корректировку #${undoId}?`)) return;
        await api(`/admin/adjustment/${undoId}/delete`, { method: 'POST' });
        toast('Откачено', 'success');
        renderPlayerDetail([tgId]);
      } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
    };
  }

  // Owner-restricted admin actions (нельзя над собой)
  if (state.me?.isAdmin && !isOwner) {
    screen.querySelector('#admin-toggle-privacy').onclick = async () => {
      try {
        await api(`/admin/user/${tgId}`, {
          method: 'PUT',
          body: JSON.stringify({ privacy: { show_breakdown: true, show_heroes: true, show_recent: true } }),
        });
        renderPlayerDetail([tgId]);
      } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
    };
    screen.querySelector('#admin-delete-user').onclick = async () => {
      if (!confirm(`Точно удалить «${user.display_name}»? Если у него есть завершённые игры или турниры как у создателя — операция упадёт; сначала разруливай те.`)) return;
      try {
        const r = await api(`/admin/user/${tgId}/delete`, { method: 'POST' });
        toast('Удалено · открытых комнат снесено: ' + r.deleted_open_rooms, 'success');
        location.hash = '#/players';
      } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
    };
  }
}

// — profile —

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

  const priv = me.privacy || { show_breakdown: true, show_heroes: true, show_recent: true };
  screen.innerHTML = `
    <div class="card profile-hero">
      ${playerAvatar(me)}
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

    <h3 class="section-title">Приватность · что видят другие</h3>
    <div class="card">
      <label class="priv-row">
        <input type="checkbox" id="p-breakdown" ${priv.show_breakdown ? 'checked' : ''} />
        <span>Очки по режимам (1v1 / 2v2 / FFA)</span>
      </label>
      <label class="priv-row">
        <input type="checkbox" id="p-heroes" ${priv.show_heroes ? 'checked' : ''} />
        <span>Статистика колод и винрейты</span>
      </label>
      <label class="priv-row">
        <input type="checkbox" id="p-recent" ${priv.show_recent ? 'checked' : ''} />
        <span>Список недавних партий</span>
      </label>
      <p class="muted" style="font-size:12px;margin-top:10px;line-height:1.5;">
        Имя, общий рейтинг и место в топе видны всегда.
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
      renderProfile();
    } catch (err) {
      toast('Не сохранилось: ' + err.message, 'error');
    }
    e.target.disabled = false;
  };

  // Admin "danger zone" — only visible to admin user. Server-side enforces auth.
  if (state.me?.isAdmin) {
    const danger = document.createElement('div');
    danger.innerHTML = `
      <h3 class="section-title">Админка 👑</h3>
      <div class="card">
        <button id="admin-wipe-stats" class="secondary" style="width:100%;margin-bottom:6px;color:var(--accent);">🧹 Сбросить всю статистику (комнаты + турниры + очки)</button>
        <button id="admin-wipe-all" class="secondary" style="width:100%;color:var(--accent);">💀 Полный сброс (включая всех юзеров)</button>
        <p class="muted" style="font-size:12px;margin-top:10px;line-height:1.5;">
          Soft-сброс оставит юзеров с их сигнатурами/аватарками, обнулит только игровую историю. Hard-сброс грохнет вообще всё.
        </p>
      </div>
    `;
    screen.appendChild(danger);
    screen.querySelector('#admin-wipe-stats').onclick = async () => {
      if (!confirm('Сбросить всю статистику? Юзеры останутся, но очки/комнаты/турниры обнулятся.')) return;
      try {
        const r = await api('/admin/wipe-stats', { method: 'POST' });
        toast('Сброшено: ' + Object.values(r.deleted).reduce((a,b)=>a+b,0) + ' записей', 'success');
        renderProfile();
      } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
    };
    screen.querySelector('#admin-wipe-all').onclick = async () => {
      if (!confirm('Точно ПОЛНОСТЬЮ обнулить, включая юзеров? Тебе самому придётся /start снова после этого.')) return;
      if (!confirm('Серьёзно? Подтверди ещё раз.')) return;
      try {
        const r = await api('/admin/wipe-all', { method: 'POST' });
        const total = Object.values(r.deleted).reduce((a, b) => a + b, 0);
        toast(`Готово · удалено ${total} записей. Перезайди через /start`, 'success');
      } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
    };
  }

  // Privacy toggles auto-save on change (no save button — feels lighter)
  const wireToggle = (id, key) => {
    const el = screen.querySelector(id);
    if (!el) return;
    el.addEventListener('change', async (e) => {
      try {
        await api('/me', {
          method: 'PUT',
          body: JSON.stringify({ privacy: { [key]: e.target.checked } }),
        });
        tg?.HapticFeedback?.selectionChanged?.();
      } catch (err) {
        toast('Не сохранилось: ' + err.message, 'error');
        e.target.checked = !e.target.checked;
      }
    });
  };
  wireToggle('#p-breakdown', 'show_breakdown');
  wireToggle('#p-heroes', 'show_heroes');
  wireToggle('#p-recent', 'show_recent');
}

// — rooms —

async function renderRooms([id, action]) {
  if (!id) return renderRoomsList();
  if (action === 'finalize') return renderFinalize(id);
  return renderRoomDetail(id);
}

async function renderRoomsList() {
  const { rooms } = await api('/rooms');
  if (shouldSkipRender('rooms-list', JSON.stringify(rooms))) return;
  screen.innerHTML = `
    <div class="row" style="margin-bottom:12px;">
      <button id="new-room" style="width:100%;">+ Создать комнату</button>
    </div>
    <div class="card" id="room-list"></div>
  `;
  screen.querySelector('#new-room').onclick = openCreateRoom;
  const list = screen.querySelector('#room-list');
  if (!rooms.length) {
    list.innerHTML = '<div class="empty">Нет открытых комнат. Создай первую — друзья подтянутся.</div>';
    return;
  }
  list.innerHTML = rooms.map((r) => {
    const full = r.players_count >= r.target_count;
    const tBadge = r.tournament_name
      ? `<span class="tournament-badge">${escape(r.tournament_name)}</span>` : '';
    const draftBadge = r.is_draft
      ? `<span class="tournament-badge" style="background:var(--accent-soft);color:var(--accent);">драфт</span>` : '';
    const sub = r.tournament_name ? 'матч турнира' : 'собирает партию';
    return `
      <a href="#/rooms/${r.id}" class="room-row">
        <div class="room-type-badge">${roomTypeLabel(r.type)}</div>
        <div>
          <div class="room-creator">${escape(r.creator_name)}${tBadge}${draftBadge}</div>
          <div class="room-meta">${sub}</div>
        </div>
        <div class="room-count ${full ? 'full' : ''}">${r.players_count}/${r.target_count}</div>
      </a>
    `;
  }).join('');

  startPolling(renderRoomsList, 5000);
}

async function openCreateRoom() {
  await ensureHeroes();
  const allHeroIds = state.heroes.map((h) => h.id);

  const types = [
    { key: '1v1', name: '1 на 1', desc: '2 игрока · соло' },
    { key: '2v2', name: '2 на 2', desc: '4 игрока · команды' },
    { key: 'ffa3', name: 'FFA-3', desc: '3 игрока · все против всех' },
    { key: 'ffa4', name: 'FFA-4', desc: '4 игрока · все против всех' },
  ];
  const playerCount = { '1v1': 2, '2v2': 4, ffa3: 3, ffa4: 4 };
  let selected = '1v1';
  // Pick mode: 'manual' (free pick) | 'random' (host raffles from pool) | 'draft' (ban-pick)
  let pickMode = 'manual';
  // Empty by default — let the host curate what's playable
  let pool = new Set();
  let view = 'main';

  const modal = openModal({ title: 'Создать комнату', body: '' });

  const renderMain = () => {
    const N = playerCount[selected];
    const needsPool = pickMode === 'random' || pickMode === 'draft';
    const minPool = pickMode === 'draft' ? 2 * N : N;
    const poolOk = !needsPool || pool.size >= minPool;
    const modes = [
      { key: 'manual', label: 'Свободный выбор', desc: 'каждый сам берёт героя' },
      { key: 'random', label: 'Случайная раздача', desc: 'хост раздаёт героев из пула' },
      { key: 'draft', label: 'Драфт', desc: 'бан-пик по очереди из пула' },
    ];
    modal.body.innerHTML = `
      <label style="margin-top:0;">Режим</label>
      <div class="type-grid">
        ${types.map((t) => `
          <div class="type-tile ${t.key === selected ? 'selected' : ''}" data-type="${t.key}">
            <div>${t.name}</div>
            <div class="desc">${t.desc}</div>
          </div>
        `).join('')}
      </div>

      <label style="margin-top:14px;">Выбор героев</label>
      <div class="radio-group">
        ${modes.map((m) => `
          <div class="radio-row ${pickMode === m.key ? 'selected' : ''}" data-mode="${m.key}">
            <div>
              <b>${m.label}</b>
              <div style="font-size:12px;font-weight:400;color:var(--muted);margin-top:2px;">${m.desc}</div>
            </div>
          </div>
        `).join('')}
      </div>

      ${needsPool ? `
        <div style="margin-top:10px;">
          <button id="pool-edit" class="secondary" style="width:100%;font-size:13px;">
            Пул: ${pool.size} героев · мин ${minPool} ${poolOk ? '✓' : '⚠'}
          </button>
        </div>
      ` : ''}
      <div class="row" style="margin-top:18px;">
        <button id="create-confirm" style="width:100%;" ${needsPool && !poolOk ? 'disabled' : ''}>
          Создать
        </button>
      </div>
    `;
    modal.body.querySelectorAll('.type-tile').forEach((el) => {
      el.onclick = () => { selected = el.dataset.type; renderMain(); };
    });
    modal.body.querySelectorAll('.radio-row[data-mode]').forEach((el) => {
      el.onclick = () => { pickMode = el.dataset.mode; renderMain(); };
    });
    const poolBtn = modal.body.querySelector('#pool-edit');
    if (poolBtn) poolBtn.onclick = () => { view = 'pool'; renderPool(); };

    modal.body.querySelector('#create-confirm').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const body = { type: selected };
        if (pickMode === 'draft') {
          body.is_draft = true;
          body.hero_pool = [...pool];
        } else if (pickMode === 'random') {
          body.hero_pool = [...pool];
        }
        const r = await api('/rooms', { method: 'POST', body: JSON.stringify(body) });
        modal.close();
        location.hash = `#/rooms/${r.id}`;
      } catch (err) {
        toast('Не получилось: ' + err.message, 'error');
        e.target.disabled = false;
      }
    };
  };

  // Sets currently expanded in the accordion
  const openSets = new Set();

  const renderPool = () => {
    const grouped = {};
    for (const h of state.heroes) {
      if (!grouped[h.set_name]) grouped[h.set_name] = [];
      grouped[h.set_name].push(h);
    }
    const sets = Object.entries(grouped);
    modal.body.innerHTML = `
      <div class="row" style="margin-bottom:10px;gap:8px;">
        <button id="pool-back" class="secondary" style="flex:1;">← Назад</button>
        <button id="pool-all" class="secondary" style="flex:1;font-size:12px;">Все</button>
        <button id="pool-none" class="secondary" style="flex:1;font-size:12px;">Очистить</button>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:6px;">
        Выбрано: <b style="color:var(--text);">${pool.size}</b> из ${state.heroes.length}
      </div>
      <div id="pool-list">
        ${sets.map(([set, heroes]) => {
          const isOpen = openSets.has(set);
          const selectedCount = heroes.filter((h) => pool.has(h.id)).length;
          const allSelected = selectedCount === heroes.length;
          const noneSelected = selectedCount === 0;
          const bulkIcon = allSelected ? '☒' : (noneSelected ? '☐' : '◧');
          return `
            <div class="pool-set">
              <div class="pool-set-header" data-set="${escape(set)}">
                <span class="chev">${isOpen ? '▼' : '▶'}</span>
                <span class="name">${escape(set)}</span>
                <span class="count">${selectedCount}/${heroes.length}</span>
                <button class="pool-set-bulk" data-set-bulk="${escape(set)}" title="Взять/снять весь набор">${bulkIcon}</button>
              </div>
              ${isOpen ? `
                <div class="pool-set-body">
                  ${heroes.map((h) => `
                    <label class="pool-hero-row">
                      <input type="checkbox" data-hero-id="${h.id}" ${pool.has(h.id) ? 'checked' : ''} />
                      ${heroAvatar(h.name, undefined, h.slug)}
                      <span class="hero-name">${escape(h.name)}</span>
                    </label>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
      <div class="row" style="margin-top:16px;position:sticky;bottom:0;padding:8px 0;background:linear-gradient(to top, var(--card) 70%, transparent);">
        <button id="pool-done" style="width:100%;">Готово · ${pool.size} в пуле</button>
      </div>
    `;

    modal.body.querySelector('#pool-back').onclick = () => { view = 'main'; renderMain(); };
    modal.body.querySelector('#pool-done').onclick = () => { view = 'main'; renderMain(); };
    modal.body.querySelector('#pool-all').onclick = () => { pool = new Set(allHeroIds); renderPool(); };
    modal.body.querySelector('#pool-none').onclick = () => { pool = new Set(); renderPool(); };

    modal.body.querySelectorAll('.pool-set-header').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.pool-set-bulk')) return; // bulk button has its own handler
        const set = el.dataset.set;
        if (openSets.has(set)) openSets.delete(set);
        else openSets.add(set);
        renderPool();
      });
    });

    modal.body.querySelectorAll('.pool-set-bulk').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const set = el.dataset.setBulk;
        const heroes = state.heroes.filter((h) => h.set_name === set);
        const allSelected = heroes.every((h) => pool.has(h.id));
        if (allSelected) heroes.forEach((h) => pool.delete(h.id));
        else heroes.forEach((h) => pool.add(h.id));
        renderPool();
      });
    });

    modal.body.querySelectorAll('input[data-hero-id]').forEach((el) => {
      el.addEventListener('change', (e) => {
        const id = Number(el.dataset.heroId);
        if (e.target.checked) pool.add(id);
        else pool.delete(id);
        renderPool();
      });
    });
  };

  renderMain();
}

async function renderRoomDetail(id) {
  stopPolling();
  const { room } = await api(`/rooms/${id}`);
  if (shouldSkipRender(`room-${id}`, JSON.stringify(room))) {
    // Data unchanged — restart polling so we keep checking, but don't touch DOM.
    if (room.status === 'open') startPolling(() => renderRoomDetail(id), 4000);
    return;
  }
  const me = state.me;
  const myPlayer = room.players.find((p) => p.tg_id === me.tg_id);
  // Admin gets all manager-only buttons regardless of who created the room.
  const isCreator = room.creator_tg_id === me.tg_id || me.isAdmin;
  const full = room.players.length >= room.target_count;
  const allPicked = room.players.every((p) => p.hero_id || p.hero_custom);

  // Active draft → dedicated draft UI
  if (room.is_draft && room.draft?.started && !room.draft?.complete && room.status === 'open') {
    return renderDraftRoom(room);
  }

  if (room.status === 'finished') {
    screen.innerHTML = `
      <div class="card">
        <div class="muted" style="font-size:13px;margin-bottom:8px;">${roomTypeLabel(room.type)} · комната #${room.id} · завершена</div>
        ${room.notes ? `<div style="font-style:italic;margin-bottom:10px;">«${escape(room.notes)}»</div>` : ''}
      </div>
      <div class="card">
        ${[...room.players].sort((a, b) => b.points_awarded - a.points_awarded).map((p) => `
          <div class="player-row">
            ${playerAvatar(p)}
            <div>
              <div class="player-name">${p.is_winner ? '🏆 ' : ''}${medalSpan(p.rank)}${escape(p.display_name)}</div>
              <div class="player-meta">${escape(p.hero_name || p.hero_custom || '?')}</div>
            </div>
            <div class="points">+${p.points_awarded}</div>
          </div>
        `).join('')}
      </div>
      <div class="actions">
        ${isCreator ? '<button id="reset-results" class="secondary">Сбросить результаты</button>' : ''}
        <a href="#/rooms" class="btn secondary" style="text-align:center;text-decoration:none;display:block;">К списку комнат</a>
      </div>
    `;
    const resetBtn = screen.querySelector('#reset-results');
    if (resetBtn) resetBtn.onclick = async () => {
      if (!confirm('Откатить результаты? Очки будут сняты у всех игроков, комната вернётся в лобби.')) return;
      try {
        await api(`/rooms/${id}/reset-results`, { method: 'POST' });
        renderRoomDetail(id);
      } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
    };
    return;
  }

  const renderPlayer = (p) => {
    const hero = p.hero_name || p.hero_custom || '<span style="color:var(--muted)">— герой не выбран —</span>';
    return `
      <div class="player-row">
        ${playerAvatar(p)}
        <div>
          <div class="player-name">${medalSpan(p.rank)}${escape(p.display_name)}${p.tg_id === room.creator_tg_id ? ' <span class="muted" style="font-weight:500;font-size:12px;">· хост</span>' : ''}</div>
          <div class="player-meta">${hero}</div>
        </div>
        <div></div>
      </div>
    `;
  };

  let participants;
  if (room.type === '2v2') {
    const teamA = room.players.filter((p) => p.team === 0);
    const teamB = room.players.filter((p) => p.team === 1);
    participants = `
      <div class="team-label">Команда A
        ${myPlayer && myPlayer.team !== 0 ? `<button class="swap" data-team="0">→ перейти</button>` : ''}
      </div>
      <div class="card">${teamA.length ? teamA.map(renderPlayer).join('') : '<div class="empty" style="padding:14px;">Пусто</div>'}</div>
      <div class="team-label">Команда B
        ${myPlayer && myPlayer.team !== 1 ? `<button class="swap" data-team="1">→ перейти</button>` : ''}
      </div>
      <div class="card">${teamB.length ? teamB.map(renderPlayer).join('') : '<div class="empty" style="padding:14px;">Пусто</div>'}</div>
    `;
  } else {
    participants = `<div class="card">${room.players.map(renderPlayer).join('')}</div>`;
  }

  const isTournamentMatch = !!room.tournament_id;
  const inDraft = !!(room.is_draft && room.draft?.started);
  const draftDone = !!room.draft?.complete;
  // In draft mode, heroes are assigned via ban-pick — never via manual picker.
  const showHeroPick = !room.is_draft;

  let actionsHtml = '<div class="actions">';
  if (myPlayer) {
    if (showHeroPick) {
      actionsHtml += `<button id="pick-hero" class="secondary">${(myPlayer.hero_name || myPlayer.hero_custom) ? 'Сменить героя' : 'Выбрать героя'}</button>`;
    }
    if (!isTournamentMatch && !full) {
      actionsHtml += `<button id="share-room" class="secondary">📤 Поделиться комнатой</button>`;
    }
    if (room.type === '2v2' && isCreator && !inDraft && !isTournamentMatch) {
      actionsHtml += `<button id="randomize-teams" class="secondary">🎲 Рандом команд</button>`;
    }
    if (isCreator && !room.is_draft && room.has_pool && room.players.length > 0) {
      actionsHtml += `<button id="randomize-heroes" class="secondary">🎰 Раздать героев из пула</button>`;
    }
    if (room.is_draft && !room.draft?.started && isCreator && full) {
      actionsHtml += `<button id="start-draft">Начать драфт</button>`;
    }
    if (isCreator) {
      actionsHtml += `<button id="finalize" ${full && allPicked ? '' : 'disabled'}>Записать результаты</button>`;
    }
    if (!isTournamentMatch && !inDraft) {
      actionsHtml += `<button id="leave" class="secondary">${isCreator ? 'Удалить комнату' : 'Покинуть комнату'}</button>`;
    }
  } else if (full) {
    actionsHtml += `<button disabled>Комната заполнена</button>`;
  } else if (isTournamentMatch) {
    actionsHtml += `<button disabled>Турнирный матч (только для участников)</button>`;
  } else if (inDraft) {
    actionsHtml += `<button disabled>Драфт уже начался</button>`;
  } else {
    actionsHtml += `<button id="join">Войти в комнату</button>`;
  }
  // Admin force-delete works in any state, even if admin isn't a player.
  if (me.isAdmin) {
    actionsHtml += `<button id="admin-force-delete-room" class="secondary" style="color:var(--accent);">💀 Снести комнату (admin)</button>`;
  }
  actionsHtml += '</div>';

  let stateText;
  if (room.is_draft && !room.draft?.started) {
    stateText = !full
      ? `Драфт-режим · пул ${room.hero_pool_size || 0} героев · ждём (${room.players.length}/${room.target_count})`
      : `Все собрались — хост запускает драфт`;
  } else if (room.is_draft && draftDone) {
    stateText = 'Драфт завершён · хост может записать результат';
  } else if (room.has_pool && !room.is_draft) {
    stateText = !full
      ? `Случайная раздача · пул ${room.hero_pool_size} героев · ждём (${room.players.length}/${room.target_count})`
      : (allPicked ? 'Все на месте, можно записывать результат' : 'Все собрались — хост может раздать героев');
  } else if (!full) {
    stateText = `Ждём игроков (${room.players.length}/${room.target_count})`;
  } else if (!allPicked) {
    stateText = 'Все на месте, остался выбор героев';
  } else {
    stateText = 'Готово к старту — хост может записать результат';
  }

  const tournamentLink = room.tournament_name
    ? `<a href="#/tournaments/${room.tournament_id}" class="tournament-badge" style="text-decoration:none;display:inline-block;">${escape(room.tournament_name)}</a>`
    : '';
  screen.innerHTML = `
    <div class="card" style="display:flex;align-items:center;gap:12px;padding:14px 16px;">
      <div class="room-type-badge">${roomTypeLabel(room.type)}</div>
      <div style="flex:1;">
        <div style="font-weight:700;">${roomTypeLabel(room.type)} · комната #${room.id} ${tournamentLink}</div>
        <div class="muted" style="font-size:12px;margin-top:2px;">${escape(stateText)}</div>
      </div>
    </div>
    ${participants}
    ${actionsHtml}
  `;

  // Wire interactions
  const pickBtn = screen.querySelector('#pick-hero');
  if (pickBtn) pickBtn.onclick = () => openHeroPicker(id, myPlayer);

  const joinBtn = screen.querySelector('#join');
  if (joinBtn) joinBtn.onclick = async () => {
    joinBtn.disabled = true;
    try { await api(`/rooms/${id}/join`, { method: 'POST' }); renderRoomDetail(id); }
    catch (e) { toast('Не получилось: ' + e.message, 'error'); joinBtn.disabled = false; }
  };

  const leaveBtn = screen.querySelector('#leave');
  if (leaveBtn) leaveBtn.onclick = async () => {
    if (!confirm(isCreator ? 'Удалить комнату?' : 'Покинуть комнату?')) return;
    try {
      const r = await api(`/rooms/${id}/leave`, { method: 'POST' });
      if (r.deleted) location.hash = '#/rooms';
      else renderRoomDetail(id);
    } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
  };

  const finBtn = screen.querySelector('#finalize');
  if (finBtn) finBtn.onclick = () => { location.hash = `#/rooms/${id}/finalize`; };

  const adminDelRoomBtn = screen.querySelector('#admin-force-delete-room');
  if (adminDelRoomBtn) adminDelRoomBtn.onclick = async () => {
    if (!confirm('АДМИН: снести эту комнату полностью? Все игры и результаты комнаты исчезнут.')) return;
    try {
      await api(`/admin/room/${id}/delete`, { method: 'POST' });
      location.hash = '#/rooms';
    } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
  };

  const shareBtn = screen.querySelector('#share-room');
  if (shareBtn) shareBtn.onclick = () => shareRoom(id);

  const randBtn = screen.querySelector('#randomize-teams');
  if (randBtn) randBtn.onclick = async () => {
    randBtn.disabled = true;
    try {
      await api(`/rooms/${id}/randomize-teams`, { method: 'POST' });
      tg?.HapticFeedback?.selectionChanged?.();
      renderRoomDetail(id);
    } catch (e) {
      toast('Не получилось: ' + e.message, 'error');
      randBtn.disabled = false;
    }
  };

  const randHeroesBtn = screen.querySelector('#randomize-heroes');
  if (randHeroesBtn) randHeroesBtn.onclick = async () => {
    if (!confirm('Раздать случайных героев всем игрокам? Текущий выбор у каждого перезапишется.')) return;
    randHeroesBtn.disabled = true;
    try {
      await api(`/rooms/${id}/randomize-heroes`, { method: 'POST' });
      tg?.HapticFeedback?.selectionChanged?.();
      renderRoomDetail(id);
    } catch (e) {
      toast('Не получилось: ' + e.message, 'error');
      randHeroesBtn.disabled = false;
    }
  };

  const startDraftBtn = screen.querySelector('#start-draft');
  if (startDraftBtn) startDraftBtn.onclick = async () => {
    if (!confirm('Стартуем драфт? Состав будет зафиксирован, в 2v2 команды распределятся случайно.')) return;
    startDraftBtn.disabled = true;
    try {
      await api(`/rooms/${id}/start-draft`, { method: 'POST' });
      renderRoomDetail(id);
    } catch (e) {
      toast('Не получилось: ' + e.message, 'error');
      startDraftBtn.disabled = false;
    }
  };

  screen.querySelectorAll('.swap').forEach((btn) => {
    btn.onclick = async (e) => {
      e.preventDefault();
      try {
        await api(`/rooms/${id}/team`, {
          method: 'POST',
          body: JSON.stringify({ team: Number(btn.dataset.team) }),
        });
        renderRoomDetail(id);
      } catch (err) { toast('Не получилось: ' + err.message, 'error'); }
    };
  });

  // Lobby auto-refresh: pick up joins/leaves/hero selections without manual refresh.
  // Skip polling on finished rooms (data is frozen).
  if (room.status === 'open') {
    startPolling(() => renderRoomDetail(id), 4000);
  }
}

async function renderDraftRoom(room) {
  await ensureHeroes();
  const me = state.me;
  const draft = room.draft;
  const isCreator = room.creator_tg_id === me.tg_id;
  const isMyTurn = draft.currentTurn === me.tg_id;
  const currentPlayer = room.players.find((p) => p.tg_id === draft.currentTurn);
  const N = room.target_count;
  const phaseDone = draft.currentAction === 'ban' ? draft.banned.length : draft.picks.length;

  const tournamentLink = room.tournament_name
    ? `<a href="#/tournaments/${room.tournament_id}" class="tournament-badge" style="text-decoration:none;display:inline-block;">${escape(room.tournament_name)}</a>`
    : '';

  const bannerCls = isMyTurn ? 'your-turn' : '';
  let bannerText;
  if (isMyTurn) {
    bannerText = draft.currentAction === 'ban' ? 'Твой бан — выбери героя в пуле' : 'Твой пик — выбери героя для себя';
  } else {
    const phaseLabel = draft.currentAction === 'ban' ? 'банит' : 'выбирает героя';
    bannerText = `${escape(currentPlayer?.display_name || '?')} ${phaseLabel}…`;
  }
  const phaseTitle = draft.currentAction === 'ban' ? 'БАН' : 'ПИК';
  const progressLabel = `${phaseDone + 1} / ${N}`;

  // Sort pool: available first, then picked, then banned
  const allPoolHeroes = draft.pool.map((id) => heroById(id)).filter(Boolean);
  allPoolHeroes.sort((a, b) => {
    const rank = (h) => {
      if (draft.banned.includes(h.id)) return 2;
      if (draft.picks.find((p) => p.hero_id === h.id)) return 1;
      return 0;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });

  const q = state.draftSearch.toLowerCase().trim();
  const poolHeroes = q
    ? allPoolHeroes.filter((h) => h.name.toLowerCase().includes(q) || h.set_name.toLowerCase().includes(q))
    : allPoolHeroes;

  const buildPoolCardsHTML = (heroes) => heroes.map((h) => {
    const isBanned = draft.banned.includes(h.id);
    const pickInfo = draft.picks.find((p) => p.hero_id === h.id);
    const isPicked = !!pickInfo;
    const tappable = isMyTurn && !isBanned && !isPicked;
    const cls = isBanned ? 'banned' : (isPicked ? 'picked' : (tappable ? '' : 'disabled'));
    const pickerName = isPicked ? room.players.find((p) => p.tg_id === pickInfo.tg_id)?.display_name : '';
    return `
      <div class="draft-card ${cls}" data-hero-id="${h.id}">
        ${heroAvatar(h.name, undefined, h.slug)}
        <div style="min-width:0;">
          <div class="card-name">${escape(h.name)}</div>
          <div class="card-meta">
            ${isBanned ? 'Забанен' : isPicked ? '→ ' + escape(pickerName) : escape(h.set_name)}
          </div>
        </div>
      </div>
    `;
  }).join('') || '<div class="empty">Никого не нашёл</div>';

  screen.innerHTML = `
    <div class="card" style="display:flex;align-items:center;gap:12px;padding:14px 16px;">
      <div class="room-type-badge">${roomTypeLabel(room.type)}</div>
      <div style="flex:1;">
        <div style="font-weight:700;">Драфт · комната #${room.id} ${tournamentLink}</div>
        <div class="muted" style="font-size:12px;margin-top:2px;">Идёт бан-пик</div>
      </div>
    </div>

    <div class="draft-banner ${bannerCls}">
      <span style="flex:1;min-width:0;">${bannerText}</span>
      <span class="phase">${phaseTitle}</span>
      <span class="progress">${progressLabel}</span>
    </div>

    <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;margin:12px 0 4px;">
      Очередь
    </div>
    <div class="card" style="padding:8px 12px;">
      ${draft.order.map((tgId, i) => {
        const p = room.players.find((pp) => pp.tg_id === tgId);
        if (!p) return '';
        const isCur = tgId === draft.currentTurn;
        const teamLabel = room.type === '2v2'
          ? ` <span class="muted" style="font-size:11px;font-weight:400;">(${p.team === 0 ? 'A' : 'B'})</span>`
          : '';
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:5px 0;${isCur ? 'font-weight:700;color:var(--accent);' : ''}">
            <span style="width:18px;font-variant-numeric:tabular-nums;text-align:right;">${i + 1}.</span>
            ${playerAvatar(p, 24)}
            <span style="flex:1;">${medalSpan(p.rank)}${escape(p.display_name)}${teamLabel}</span>
            ${isCur ? '<span style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">ход</span>' : ''}
          </div>
        `;
      }).join('')}
    </div>

    <h3 class="section-title">Пул героев · ${draft.pool.length}</h3>
    <input class="draft-search" id="draft-search" placeholder="Поиск героя или набора…" value="${escape(state.draftSearch)}" />
    <div class="draft-pool" id="draft-pool">${buildPoolCardsHTML(poolHeroes)}</div>

    ${isCreator ? `
      <div class="actions" style="margin-top:14px;">
        <button id="cancel-draft" class="secondary">Отменить драфт и вернуться в лобби</button>
      </div>
    ` : ''}

    <p class="muted" style="font-size:11px;text-align:center;margin-top:14px;">
      Обновляется автоматически каждые 3 секунды.
    </p>
  `;

  const cancelBtn = screen.querySelector('#cancel-draft');
  if (cancelBtn) cancelBtn.onclick = async () => {
    if (!confirm('Отменить драфт? Все баны/пики будут сброшены, игроки потеряют выбранных героев.')) return;
    try {
      await api(`/rooms/${room.id}/cancel-draft`, { method: 'POST' });
      renderRoomDetail(room.id);
    } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
  };

  const attachPoolTaps = () => {
    if (!isMyTurn) return;
    screen.querySelectorAll('.draft-card:not(.banned):not(.picked):not(.disabled)').forEach((el) => {
      el.addEventListener('click', async () => {
        const heroId = Number(el.dataset.heroId);
        try {
          await api(`/rooms/${room.id}/draft-action`, {
            method: 'POST',
            body: JSON.stringify({ action: draft.currentAction, hero_id: heroId }),
          });
          tg?.HapticFeedback?.selectionChanged?.();
          renderRoomDetail(room.id);
        } catch (e) {
          toast('Не получилось: ' + e.message, 'error');
        }
      });
    });
  };
  attachPoolTaps();

  // Search filters pool in-place — no full re-render so the input keeps focus.
  const searchInput = screen.querySelector('#draft-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.draftSearch = e.target.value;
      const qq = state.draftSearch.toLowerCase().trim();
      const filtered = qq
        ? allPoolHeroes.filter((h) => h.name.toLowerCase().includes(qq) || h.set_name.toLowerCase().includes(qq))
        : allPoolHeroes;
      const poolEl = screen.querySelector('#draft-pool');
      poolEl.innerHTML = buildPoolCardsHTML(filtered);
      attachPoolTaps();
    });
    // Pause polling while typing so the screen doesn't get rebuilt out from under us.
    searchInput.addEventListener('focus', stopPolling);
    searchInput.addEventListener('blur', () => {
      startPolling(() => renderRoomDetail(room.id), 3000);
    });
  }

  // Live updates during draft.
  startPolling(() => renderRoomDetail(room.id), 3000);
}

async function openHeroPicker(roomId, myPlayer) {
  if (!state.heroes) {
    const { heroes } = await api('/heroes');
    state.heroes = heroes;
  }
  const { stats } = await api('/me/hero-stats');
  let query = '';
  let custom = myPlayer.hero_custom || '';
  const currentId = myPlayer.hero_id || null;

  const modal = openModal({ title: 'Выбор героя', body: '' });

  // Tap on a hero row commits the pick immediately and closes the modal.
  const pickHero = async (heroId) => {
    try {
      await api(`/rooms/${roomId}/select-hero`, {
        method: 'POST',
        body: JSON.stringify({ hero_id: heroId }),
      });
      tg?.HapticFeedback?.selectionChanged?.();
      modal.close();
      renderRoomDetail(roomId);
    } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
  };

  const saveCustom = async () => {
    if (!custom.trim()) { toast('Выбери героя или впиши свою колоду', 'error'); return; }
    try {
      await api(`/rooms/${roomId}/select-hero`, {
        method: 'POST',
        body: JSON.stringify({ hero_custom: custom }),
      });
      modal.close();
      renderRoomDetail(roomId);
    } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
  };

  // Sets currently expanded. Default: only the set of currentId hero, if any —
  // so user lands on their existing pick visible without scrolling. Empty = all collapsed.
  const openSets = new Set();
  if (currentId) {
    const cur = state.heroes.find((h) => h.id === currentId);
    if (cur) openSets.add(cur.set_name);
  }

  const render = () => {
    const q = query.toLowerCase().trim();
    const filtered = state.heroes.filter((h) =>
      !q || h.name.toLowerCase().includes(q) || h.set_name.toLowerCase().includes(q)
    );
    const grouped = {};
    for (const h of filtered) {
      if (!grouped[h.set_name]) grouped[h.set_name] = [];
      grouped[h.set_name].push(h);
    }
    // While searching, force-expand all matching sets so results are visible immediately.
    const isSearching = q.length > 0;

    const list = Object.entries(grouped).map(([set, heroes]) => {
      const isOpen = isSearching || openSets.has(set);
      const setHasCurrent = heroes.some((h) => h.id === currentId);
      const heroRows = isOpen ? heroes.map((h) => {
        const s = stats[h.id];
        const wr = s ? Math.round((s.wins / s.games) * 100) : null;
        const isCurrent = currentId === h.id;
        return `
          <div class="hero-row ${isCurrent ? 'selected' : ''}" data-id="${h.id}">
            ${heroAvatar(h.name, undefined, h.slug)}
            <div>
              <div class="hero-name">${escape(h.name)}${isCurrent ? ' <span class="muted" style="font-weight:400;font-size:11px;">· сейчас</span>' : ''}</div>
              <div class="hero-set">${escape(h.set_name)}</div>
            </div>
            <div class="hero-winrate ${s ? '' : 'dim'}">
              ${s ? `<b>${wr}%</b><br>${formatGamesCount(s.games)}` : 'нет партий'}
            </div>
          </div>
        `;
      }).join('') : '';
      return `
        <div class="picker-set ${setHasCurrent ? 'has-current' : ''}">
          <div class="picker-set-header" data-set="${escape(set)}">
            <span class="chev">${isOpen ? '▼' : '▶'}</span>
            <span class="name">${escape(set)}</span>
            <span class="count">${heroes.length}</span>
          </div>
          ${heroRows}
        </div>
      `;
    }).join('');

    modal.body.innerHTML = `
      <input class="modal-search" id="hero-search" placeholder="Поиск героя или набора…" value="${escape(query)}" />
      <p class="muted" style="font-size:12px;margin:0 0 8px;">Тапни на героя — сохранится автоматически.</p>
      <div id="hero-list">${list || '<div class="empty">Никого не нашёл</div>'}</div>
      <div style="border-top:1px solid var(--separator);padding-top:12px;margin-top:14px;">
        <label style="margin-top:0;">…или своя колода (если героя нет в списке)</label>
        <div class="row" style="gap:8px;">
          <input id="custom-hero" placeholder="Название" value="${escape(custom)}" style="flex:1;" />
          <button id="picker-save-custom">Сохранить</button>
        </div>
      </div>
    `;
    const search = modal.body.querySelector('#hero-search');
    search.addEventListener('input', (e) => {
      query = e.target.value;
      const sel = e.target.selectionStart;
      render();
      const newSearch = modal.body.querySelector('#hero-search');
      newSearch.focus();
      try { newSearch.setSelectionRange(sel, sel); } catch {}
    });
    modal.body.querySelectorAll('.picker-set-header').forEach((el) => {
      el.addEventListener('click', () => {
        const set = el.dataset.set;
        if (openSets.has(set)) openSets.delete(set);
        else openSets.add(set);
        render();
      });
    });
    modal.body.querySelectorAll('.hero-row').forEach((el) => {
      el.addEventListener('click', () => {
        const heroId = Number(el.dataset.id);
        pickHero(heroId);
      });
    });
    modal.body.querySelector('#custom-hero').addEventListener('input', (e) => {
      custom = e.target.value;
    });
    modal.body.querySelector('#picker-save-custom').addEventListener('click', saveCustom);
  };
  render();
}

// — finalize —

async function renderFinalize(id) {
  const { room } = await api(`/rooms/${id}`);
  if (room.creator_tg_id !== state.me.tg_id) {
    screen.innerHTML = `<div class="empty">Только хост может записывать результаты.</div>`;
    return;
  }
  if (room.status === 'finished') {
    screen.innerHTML = `<div class="empty">Эта комната уже завершена.</div>`;
    return;
  }
  if (room.players.length !== room.target_count) {
    screen.innerHTML = `<div class="empty">Нельзя завершить — не все игроки в комнате (${room.players.length}/${room.target_count}).</div>`;
    return;
  }

  if (room.type === '1v1') return renderFinalize1v1(room);
  if (room.type === '2v2') return renderFinalize2v2(room);
  return renderFinalizeFFA(room);
}

function finalizeShell(room, body, getResult) {
  screen.innerHTML = `
    <div class="card">
      <div class="muted" style="font-size:13px;margin-bottom:8px;">${roomTypeLabel(room.type)} · комната #${room.id}</div>
      ${body}
      <label>Заметка (опционально)</label>
      <input id="fin-notes" placeholder="Например: эпик через 50 минут" maxlength="200" />
      <div class="row" style="margin-top:14px;gap:8px;">
        <button id="fin-cancel" class="secondary" style="flex:1;">Отмена</button>
        <button id="fin-submit" style="flex:2;">Записать результаты</button>
      </div>
    </div>
  `;
  screen.querySelector('#fin-cancel').onclick = () => { location.hash = `#/rooms/${room.id}`; };
  screen.querySelector('#fin-submit').onclick = async (e) => {
    let result;
    try { result = getResult(); } catch (err) { toast(err.message, 'error'); return; }
    const notes = screen.querySelector('#fin-notes').value.trim();
    e.target.disabled = true;
    try {
      await api(`/rooms/${room.id}/finalize`, {
        method: 'POST',
        body: JSON.stringify({ players: result, notes: notes || null }),
      });
      tg?.HapticFeedback?.notificationOccurred('success');
      location.hash = `#/rooms/${room.id}`;
    } catch (err) {
      toast('Не получилось: ' + (err.message || 'unknown'), 'error');
      e.target.disabled = false;
    }
  };
}

function renderFinalize1v1(room) {
  let winnerId = null;
  const body = `
    <label>Кто победил?</label>
    <div class="radio-group" id="winner-group">
      ${room.players.map((p) => `
        <label class="radio-row" data-id="${p.tg_id}">
          <div>${medalSpan(p.rank)}${escape(p.display_name)} <span class="muted" style="font-weight:400;">— ${escape(p.hero_name || p.hero_custom || '?')}</span></div>
        </label>
      `).join('')}
    </div>
  `;
  finalizeShell(room, body, () => {
    if (!winnerId) throw new Error('Выбери победителя');
    return room.players.map((p) => ({
      tg_id: p.tg_id,
      elimination_order: p.tg_id === winnerId ? null : 1,
    }));
  });
  screen.querySelectorAll('#winner-group .radio-row').forEach((el) => {
    el.onclick = () => {
      winnerId = Number(el.dataset.id);
      screen.querySelectorAll('#winner-group .radio-row')
        .forEach((x) => x.classList.toggle('selected', x === el));
    };
  });
}

function renderFinalize2v2(room) {
  let winningTeam = null;
  let winnerEliminated = null;
  let loserFirst = null;

  const body = `
    <label>Победила команда</label>
    <div class="radio-group" id="winning-team">
      <label class="radio-row" data-team="0"><div>Команда A</div></label>
      <label class="radio-row" data-team="1"><div>Команда B</div></label>
    </div>
    <div id="extra"></div>
  `;
  finalizeShell(room, body, () => {
    if (winningTeam == null) throw new Error('Выбери команду-победителя');
    const losers = room.players.filter((p) => p.team !== winningTeam);
    if (losers.length === 2 && loserFirst == null) {
      throw new Error('Укажи, кто из проигравших был выбит первым');
    }
    return room.players.map((p) => {
      const isWinner = p.team === winningTeam;
      let elimination_order = null;
      if (isWinner) {
        elimination_order = winnerEliminated === p.tg_id ? 1 : null;
      } else {
        elimination_order = loserFirst === p.tg_id ? 1 : 2;
      }
      return { tg_id: p.tg_id, team: p.team, elimination_order };
    });
  });

  const refreshExtra = () => {
    const extra = screen.querySelector('#extra');
    if (winningTeam == null) { extra.innerHTML = ''; return; }
    const winners = room.players.filter((p) => p.team === winningTeam);
    const losers = room.players.filter((p) => p.team !== winningTeam);
    extra.innerHTML = `
      <label>Из команды-победителя кто-то был выбит?</label>
      <div class="radio-group" id="we-group">
        <div class="radio-row ${winnerEliminated == null ? 'selected' : ''}" data-w="alive"><div>Все выжили</div></div>
        ${winners.map((p) => `
          <div class="radio-row ${winnerEliminated === p.tg_id ? 'selected' : ''}" data-w="${p.tg_id}">
            <div>${escape(p.display_name)} был(а) выбит(а)</div>
          </div>
        `).join('')}
      </div>
      <label>Из проигравших кто выбит первым?</label>
      <div class="radio-group" id="lf-group">
        ${losers.map((p) => `
          <div class="radio-row ${loserFirst === p.tg_id ? 'selected' : ''}" data-l="${p.tg_id}">
            <div>${escape(p.display_name)}</div>
          </div>
        `).join('')}
      </div>
    `;
    extra.querySelectorAll('[data-w]').forEach((el) => {
      el.onclick = () => {
        const v = el.dataset.w;
        winnerEliminated = v === 'alive' ? null : Number(v);
        refreshExtra();
      };
    });
    extra.querySelectorAll('[data-l]').forEach((el) => {
      el.onclick = () => { loserFirst = Number(el.dataset.l); refreshExtra(); };
    });
  };

  screen.querySelectorAll('#winning-team .radio-row').forEach((el) => {
    el.onclick = () => {
      winningTeam = Number(el.dataset.team);
      winnerEliminated = null;
      loserFirst = null;
      screen.querySelectorAll('#winning-team .radio-row')
        .forEach((x) => x.classList.toggle('selected', x === el));
      refreshExtra();
    };
  });
}

function renderFinalizeFFA(room) {
  const N = room.target_count;
  const places = {}; // tg_id -> place (1..N)

  const body = `
    <label>Расставь по местам (1 — победитель, ${N} — первый выбитый)</label>
    <div id="ffa-list"></div>
  `;

  finalizeShell(room, body, () => {
    const seen = new Set();
    for (const p of room.players) {
      const place = places[p.tg_id];
      if (!place) throw new Error('Каждому игроку нужно поставить место');
      if (seen.has(place)) throw new Error('Места не должны повторяться');
      seen.add(place);
    }
    return room.players.map((p) => ({
      tg_id: p.tg_id,
      elimination_order: places[p.tg_id] === 1 ? null : N - places[p.tg_id] + 1,
    }));
  });

  const list = screen.querySelector('#ffa-list');
  list.innerHTML = room.players.map((p) => `
    <div class="fin-row">
      ${playerAvatar(p)}
      <div>
        <div class="player-name">${medalSpan(p.rank)}${escape(p.display_name)}</div>
        <div class="player-meta">${escape(p.hero_name || p.hero_custom || '?')}</div>
      </div>
      <select data-id="${p.tg_id}">
        <option value="">— место —</option>
        ${Array.from({ length: N }, (_, i) => i + 1).map((n) =>
          `<option value="${n}">${n}-е${n === 1 ? ' (победа)' : ''}</option>`
        ).join('')}
      </select>
    </div>
  `).join('');
  list.querySelectorAll('select').forEach((sel) => {
    sel.onchange = (e) => {
      const v = Number(e.target.value);
      places[Number(sel.dataset.id)] = v || undefined;
    };
  });
}

// — tournaments —

async function renderTournaments([id]) {
  if (!id) return renderTournamentsList();
  return renderTournamentDetail(id);
}

async function renderTournamentsList() {
  const { tournaments } = await api('/tournaments');
  screen.innerHTML = `
    <div class="row" style="margin-bottom:12px;">
      <button id="new-tournament" style="width:100%;">+ Создать турнир</button>
    </div>
    <div class="card" id="t-list"></div>
  `;
  screen.querySelector('#new-tournament').onclick = openCreateTournament;

  const list = screen.querySelector('#t-list');
  if (!tournaments.length) {
    list.innerHTML = '<div class="empty">Турниров пока нет. Создай первый — собери народ.</div>';
    return;
  }
  list.innerHTML = tournaments.map((t) => {
    const done = t.matches_done >= t.matches_total && t.matches_total > 0;
    return `
      <a href="#/tournaments/${t.id}" class="tournament-row">
        <div>
          <div class="tournament-name">${escape(t.name)}</div>
          <div class="tournament-meta">
            ${t.status === 'finished' ? 'Завершён · ' : ''}
            ${t.players_count} игрок(а) · 1v1 round-robin
          </div>
        </div>
        <div class="tournament-progress ${done ? 'done' : ''}">${t.matches_done}/${t.matches_total}</div>
      </a>
    `;
  }).join('');
}

async function openCreateTournament() {
  const { players: allPlayers } = await api('/players');
  let name = '';
  const selected = new Set([state.me.tg_id]); // creator pre-selected

  const modal = openModal({ title: 'Создать турнир', body: '' });

  const refresh = () => {
    modal.body.innerHTML = `
      <label>Название</label>
      <input id="t-name" placeholder="Например: Майский кубок" maxlength="80" value="${escape(name)}" />

      <label>Формат</label>
      <div class="muted" style="font-size:13px;margin-bottom:8px;">
        1v1 · круговая (каждый с каждым)
      </div>

      <label>Участники (${selected.size}, минимум 3)</label>
      <div id="t-players" style="max-height:40vh;overflow-y:auto;border:1px solid var(--separator);border-radius:var(--radius-sm);padding:4px 8px;">
        ${allPlayers.map((p) => `
          <div class="player-pick-row ${selected.has(p.tg_id) ? 'selected' : ''}" data-id="${p.tg_id}">
            <input type="checkbox" ${selected.has(p.tg_id) ? 'checked' : ''} ${p.tg_id === state.me.tg_id ? 'disabled' : ''} />
            ${playerAvatar(p, 28)}
            <div>
              <div class="player-name" style="font-size:14px;">${medalSpan(p.rank)}${escape(p.display_name)}${p.tg_id === state.me.tg_id ? ' <span class="muted" style="font-size:11px;font-weight:400;">(ты)</span>' : ''}</div>
            </div>
          </div>
        `).join('')}
      </div>

      <div class="row" style="margin-top:14px;gap:8px;">
        <button id="t-cancel" class="secondary" style="flex:1;">Отмена</button>
        <button id="t-create" style="flex:2;">Создать (${selected.size * (selected.size - 1) / 2} матчей)</button>
      </div>
    `;
    modal.body.querySelector('#t-name').oninput = (e) => { name = e.target.value; };
    modal.body.querySelectorAll('.player-pick-row').forEach((el) => {
      const tgId = Number(el.dataset.id);
      if (tgId === state.me.tg_id) return; // creator can't deselect self
      el.onclick = () => {
        if (selected.has(tgId)) selected.delete(tgId);
        else selected.add(tgId);
        refresh();
      };
    });
    modal.body.querySelector('#t-cancel').onclick = () => modal.close();
    modal.body.querySelector('#t-create').onclick = async (e) => {
      if (!name.trim()) { toast('Впиши название турнира', 'error'); return; }
      if (selected.size < 3) { toast('Нужно минимум 3 участника', 'error'); return; }
      e.target.disabled = true;
      try {
        const r = await api('/tournaments', {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            format: 'round_robin',
            game_type: '1v1',
            players: [...selected],
          }),
        });
        modal.close();
        location.hash = `#/tournaments/${r.id}`;
      } catch (err) {
        toast('Не получилось: ' + err.message, 'error');
        e.target.disabled = false;
      }
    };
  };
  refresh();
}

async function renderTournamentDetail(id) {
  const data = await api(`/tournaments/${id}`);
  if (shouldSkipRender(`tournament-${id}`, JSON.stringify(data))) {
    if (data.tournament.status !== 'finished') startPolling(() => renderTournamentDetail(id), 5000);
    return;
  }
  const { tournament, standings, matches } = data;
  const isCreator = tournament.creator_tg_id === state.me.tg_id;
  const isFinished = tournament.status === 'finished';
  const allDone = matches.every((m) => m.status === 'finished');

  screen.innerHTML = `
    <div class="card" style="padding:16px;">
      <div style="font-weight:800;font-size:18px;letter-spacing:-0.01em;">${escape(tournament.name)}</div>
      <div class="muted" style="font-size:12px;margin-top:4px;">
        1v1 round-robin · хост: ${escape(tournament.creator_name)}${isFinished ? ' · завершён' : ''}
      </div>
    </div>

    <h3 class="section-title">Турнирная таблица</h3>
    <div class="card">
      ${standings.map((s, i) => `
        <div class="standing-row">
          <div class="standing-pos ${i < 3 ? 'gold' : ''}">${medalEmoji(i + 1) || (i + 1)}</div>
          ${playerAvatar(s, 32)}
          <div>
            <div class="player-name" style="font-size:14px;">${medalSpan(s.rank)}${escape(s.display_name)}</div>
            <div class="player-meta">${s.games_played || 0} матч(ей) · ${s.wins || 0} побед</div>
          </div>
          <div class="points ${s.points ? '' : 'dim'}">${s.points || 0}</div>
        </div>
      `).join('')}
    </div>

    <h3 class="section-title">Матчи</h3>
    <div class="card">
      ${matches.map((m) => {
        const finished = m.status === 'finished';
        const p1 = `<span class="${finished && m.p1_won ? 'winner' : ''}">${escape(m.p1_name)}</span>`;
        const p2 = `<span class="${finished && m.p2_won ? 'winner' : ''}">${escape(m.p2_name)}</span>`;
        return `
          <a href="#/rooms/${m.id}" class="match-row">
            <div>
              <div class="match-pairing">${p1}<span class="vs">vs</span>${p2}</div>
              <div class="match-status ${finished ? 'done' : 'open'}">${finished ? 'Завершён' : 'Не сыгран'}</div>
            </div>
            <div style="color:var(--muted);font-size:18px;">›</div>
          </a>
        `;
      }).join('')}
    </div>

    ${isCreator ? `
      <div class="actions">
        ${!isFinished && allDone ? '<button id="t-finish">Закрыть турнир</button>' : ''}
        <button id="t-delete" class="secondary" style="color:var(--accent);">Удалить турнир</button>
      </div>
    ` : ''}
  `;

  const finBtn = screen.querySelector('#t-finish');
  if (finBtn) finBtn.onclick = async () => {
    if (!confirm('Закрыть турнир? После закрытия таблица фиксируется.')) return;
    try {
      await api(`/tournaments/${id}/finish`, { method: 'POST' });
      renderTournamentDetail(id);
    } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
  };

  const delBtn = screen.querySelector('#t-delete');
  if (delBtn) delBtn.onclick = async () => {
    const msg = isFinished
      ? 'Удалить турнир окончательно? Сыгранные матчи останутся в истории игроков, но привязка к турниру пропадёт.'
      : 'Удалить турнир? Несыгранные матчи будут стёрты, сыгранные останутся в истории.';
    if (!confirm(msg)) return;
    try {
      await api(`/tournaments/${id}/delete`, { method: 'POST' });
      tg?.HapticFeedback?.notificationOccurred?.('success');
      location.hash = '#/tournaments';
    } catch (e) { toast('Не получилось: ' + e.message, 'error'); }
  };

  // Tournaments evolve as matches finalize — keep standings fresh.
  if (!isFinished) {
    startPolling(() => renderTournamentDetail(id), 5000);
  }
}

// — modal helper —

function openModal({ title, body }) {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title"></div>
        <button class="modal-close">×</button>
      </div>
      <div class="modal-body"></div>
    </div>
  `;
  document.body.appendChild(root);
  root.querySelector('.modal-title').textContent = title;
  const bodyEl = root.querySelector('.modal-body');
  if (typeof body === 'function') bodyEl.innerHTML = body();
  else bodyEl.innerHTML = body || '';
  const close = () => root.remove();
  root.querySelector('.modal-close').onclick = close;
  root.onclick = (e) => { if (e.target === root) close(); };
  return { close, body: bodyEl };
}

function renderNotFound() {
  screen.innerHTML = `<div class="empty">Страница не найдена.</div>`;
}

// — small helpers —

// Deterministic hash → hue, so each hero/player gets a stable colored letter avatar.
function colorFromString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Avatar rendering: returns full <div class="avatar"> HTML.
// Priority: explicit src → background image. Otherwise → letter on hashed-color background via CSS ::before.
function avatarTag({ src, letter, hue, size }) {
  const styleParts = [];
  if (size) styleParts.push(`--size:${size}px`);
  if (src) styleParts.push(`background-image:url(${src})`);
  if (!src && hue !== undefined) styleParts.push(`--hue:${hue}`);
  const style = styleParts.length ? ` style="${styleParts.join(';')}"` : '';
  const dl = (!src && letter) ? ` data-letter="${escape(letter)}"` : '';
  return `<div class="avatar"${dl}${style}></div>`;
}

function playerAvatar(user, size) {
  if (user?.avatar_file_id) return avatarTag({ src: `/api/avatar/${user.tg_id}`, size });
  const name = user?.display_name || '?';
  return avatarTag({ letter: name.slice(0, 1).toUpperCase(), hue: colorFromString(name), size });
}

function heroAvatar(name, size, slug) {
  // We always render the letter via ::before. When a portrait exists at /heroes/<slug>.webp,
  // an <img> overlays it. If the file 404s, onerror removes the img and the letter remains.
  // This way missing portraits gracefully fall back to the hashed-color letter avatar.
  const letter = (name || '?').slice(0, 1).toUpperCase();
  const hue = colorFromString(name || '?');
  const styleParts = [`--hue:${hue}`];
  if (size) styleParts.push(`--size:${size}px`);
  const style = ` style="${styleParts.join(';')}"`;
  const img = slug
    ? `<img class="avatar-img" src="/heroes/${slug}.webp" alt="" loading="lazy" onerror="this.remove()" />`
    : '';
  return `<div class="avatar" data-letter="${escape(letter)}"${style}>${img}</div>`;
}

function gameTypeLabel(type) {
  return ({ '1v1': '1v1', '2v2': '2v2', ffa3: 'FFA-3', ffa4: 'FFA-4' })[type] || type;
}
const roomTypeLabel = gameTypeLabel;

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
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function shareRoom(roomId) {
  // t.me/<bot>?startapp=<param> opens the bot's Menu Button WebApp with start_param.
  // (t.me/<bot>/<name>?startapp=... requires /newapp in BotFather; we don't use that.)
  const url = `https://t.me/${BOT_USERNAME}?startapp=room_${roomId}`;
  // Try Telegram's native share, fall back to clipboard, fall back to prompt
  if (tg?.openTelegramLink) {
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent('Заходи в комнату Unmatched')}`;
    tg.openTelegramLink(shareUrl);
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Ссылка скопирована', 'success');
  } catch {
    prompt('Скопируй ссылку:', url);
  }
}

(async () => {
  const ok = await authenticate();
  if (!ok) {
    screen.innerHTML = `<div class="empty">Открой через бота: команда /start, кнопка «Играть».</div>`;
    return;
  }

  // Honor deep-link start_param: ?startapp=room_123 → open that room directly
  const startParam = tg?.initDataUnsafe?.start_param;
  if (startParam && /^room_\d+$/.test(startParam)) {
    location.hash = `#/rooms/${startParam.slice(5)}`;
  } else if (!location.hash) {
    location.hash = '#/players';
  }
  navigate();
})();
