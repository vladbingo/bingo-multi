'use strict';
/* ═══════════════ BINGO ROYAL — client multijoueur + admin ═══════════════ */

const $ = (id) => document.getElementById(id);
const state = {
  ws: null, connected: false,
  code: null, myId: null, imHost: false, imSpectator: false, imAdmin: false,
  pseudo: '', myCards: [], drawn: new Set(),
  config: null, players: [],
  levels: [], levelLabels: {}, wonLevels: {}, prizes: {},
  history: [],
  muted: localStorage.getItem('bingo_muted') === '1',
  reconnectTries: 0, lastCode: null, lastPseudo: null,
  finalTimerInt: null,
};

/* Lignes d'une carte (miroir du serveur) pour détecter les paliers côté client */
const LINES_LOCAL = (() => {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([[r, 0], [r, 1], [r, 2], [r, 3], [r, 4]]);
  for (let c = 0; c < 5; c++) lines.push([[0, c], [1, c], [2, c], [3, c], [4, c]]);
  lines.push([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  lines.push([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]);
  return lines;
})();
function linesDone(card) {
  let n = 0;
  for (const cells of LINES_LOCAL) {
    if (cells.every(([r, c]) => card[r][c] === 0 || state.drawn.has(card[r][c]))) n++;
  }
  return n;
}
function cardFull(card) {
  return card.every((row) => row.every((v) => v === 0 || state.drawn.has(v)));
}
/** Plus haut palier non encore remporté que cette carte complète (ou null). */
function bestLevelFor(card) {
  if (!card) return null;
  const n = linesDone(card), full = cardFull(card);
  for (const lv of ['pleine', 'ligne4', 'ligne3', 'ligne2', 'ligne1']) {
    if (state.wonLevels[lv]) continue;
    if (lv === 'pleine') { if (full) return lv; }
    else if (n >= Number(lv.slice(5))) return lv;
  }
  return null;
}

/* ---------------- Audio (WebAudio, sans fichiers) ---------------- */
let audioCtx = null;
function beep(freq, dur, type = 'sine', vol = 0.18, when = 0) {
  if (state.muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime + when;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + dur);
  } catch { /* audio indisponible */ }
}
const sndBall = () => { beep(660, 0.12, 'triangle'); beep(880, 0.1, 'triangle', 0.12, 0.08); };
const sndWin = () => { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => beep(f, 0.22, 'triangle', 0.2, i * 0.14)); };
const sndClick = () => beep(440, 0.06, 'sine', 0.08);
const sndCount = () => beep(520, 0.12, 'square', 0.1);
function updateMuteBtns() {
  $('btn-mute').textContent = state.muted ? '🔇' : '🔊';
  $('btn-mute2').textContent = state.muted ? '🔇' : '🔊';
}
function toggleMute() {
  state.muted = !state.muted;
  localStorage.setItem('bingo_muted', state.muted ? '1' : '0');
  updateMuteBtns();
}

/* ---------------- Utilitaires UI ---------------- */
function toast(msg, ok = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (ok ? ' ok' : '');
  t.textContent = msg;
  $('toast-wrap').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, 3200);
}
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}
function letterFor(n) { return n <= 15 ? 'B' : n <= 30 ? 'I' : n <= 45 ? 'N' : n <= 60 ? 'G' : 'O'; }
function letterClass(n) { return letterFor(n).toLowerCase(); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- WebSocket ---------------- */
function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host;
}
function connect() {
  state.ws = new WebSocket(wsURL());
  state.ws.onopen = () => {
    state.connected = true; state.reconnectTries = 0;
    if (state.lastCode && state.lastPseudo && !state.code) {
      send({ type: 'join', code: state.lastCode, pseudo: state.lastPseudo, cards: 2 });
    }
  };
  state.ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch { /* ignore */ } };
  state.ws.onclose = () => {
    state.connected = false;
    if (state.code) {
      state.reconnectTries++;
      if (state.reconnectTries <= 5) {
        toast('Connexion perdue… reconnexion…');
        setTimeout(connect, 1500 * state.reconnectTries);
      } else {
        toast('Connexion perdue. Rejoins la partie avec le code.');
        resetToHome();
      }
    }
  };
}
function send(msg) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg));
}

/* ---------------- Réception ---------------- */
function onMsg(m) {
  switch (m.type) {
    case 'joined':
      state.code = m.code; state.lastCode = m.code; state.lastPseudo = state.pseudo;
      state.drawn = new Set();
      show('scr-lobby');
      break;
    case 'room': onRoom(m); break;
    case 'ball': onBall(m); break;
    case 'countdown': onCountdown(m.value); break;
    case 'gameStart': onGameStart(); break;
    case 'levelWin': onLevelWin(m.win); break;
    case 'gameOver': onGameOver(m); break;
    case 'finalCall': onFinalCall(m.seconds); break;
    case 'paused': $('paused-banner').classList.remove('hidden'); toast('⏸️ Partie en pause'); break;
    case 'resumed': $('paused-banner').classList.add('hidden'); toast('▶️ C’est reparti !', true); break;
    case 'hostChanged': toast(`👑 ${m.pseudo} est le nouvel hôte`, true); break;
    case 'playerLeft': break;
    case 'notice': toast(m.message, true); break;
    case 'error': toast('⚠️ ' + m.message); break;
    case 'kicked': toast('🚫 ' + m.message); resetToHome(); break;
    case 'left': resetToHome(); break;
  }
}

function onRoom(m) {
  state.myId = m.myId; state.imHost = m.imHost; state.imSpectator = m.imSpectator;
  state.imAdmin = !!m.imAdmin;
  state.myCards = m.myCards || [];
  state.config = m.config || {};
  state.levels = m.levels || []; state.levelLabels = m.levelLabels || {};
  state.wonLevels = m.wonLevels || {}; state.prizes = (m.config && m.config.prizes) || {};
  state.players = m.players || []; state.history = m.history || [];
  const gname = state.config.gameName || 'Bingo Royal';
  $('lobby-gamename').textContent = gname;
  $('game-gamename').textContent = '♛ ' + gname;
  $('lobby-code').textContent = m.code;
  $('game-code').textContent = m.code;
  $('lobby-count').textContent = m.players.length;
  $('game-count').textContent = m.players.length;
  $('game-drawn').textContent = m.drawnCount;
  renderPlayers();
  renderAdmin();
  renderPrizes('lobby-prizes');
  renderPrizes('prize-track');
  state.drawn = new Set(m.lastBalls);
  if (m.state === 'playing' || m.state === 'paused') {
    show('scr-game');
    syncBoard(); syncCards();
  }
  const canHost = state.imHost || state.imAdmin;
  $('spectator-banner').classList.toggle('hidden', !state.imSpectator);
  $('host-controls').classList.toggle('hidden', !canHost);
  $('btn-forceend').classList.toggle('hidden', !state.imAdmin);
  $('paused-banner').classList.toggle('hidden', m.state !== 'paused');
  $('btn-start').classList.toggle('hidden', !canHost);
  $('lobby-wait').classList.toggle('hidden', canHost);
}

function renderPlayers() {
  const el = $('player-list');
  el.innerHTML = '';
  state.players.forEach((p) => {
    const d = document.createElement('div');
    d.className = 'player-chip' + (p.spectator ? ' spect' : '');
    d.innerHTML = `<span class="dot"></span><span>${escapeHtml(p.pseudo)}${p.isAdmin ? ' 🔑' : ''}${p.isHost ? ' 👑' : ''}${p.spectator ? ' 👀' : ''}</span><span class="lock" style="font-size:.72rem">${p.cards} carte(s)</span>`;
    el.appendChild(d);
  });
}

/* ---------------- Panneau admin ---------------- */
function renderAdmin() {
  const admin = state.imAdmin;
  $('admin-login-row').classList.toggle('hidden', admin);
  $('admin-controls').classList.toggle('hidden', !admin);
  if (!admin) return;
  const c = state.config;
  $('cfg-gamename').value = c.gameName || '';
  $('cfg-maxcards').value = c.maxCards || 25;
  $('cfg-speed').value = c.speed || 'normal';
  $('cfg-auto').checked = !!c.auto;
  // Cagnottes
  const pz = $('cfg-prizes');
  if (!pz.children.length) {
    state.levels.forEach((lv) => {
      const d = document.createElement('div');
      d.innerHTML = `<label class="field-label" for="pz-${lv}">${escapeHtml(state.levelLabels[lv])}</label>
        <input id="pz-${lv}" class="input" maxlength="20" data-level="${lv}">`;
      pz.appendChild(d);
    });
  }
  state.levels.forEach((lv) => {
    const inp = $('pz-' + lv);
    if (inp && document.activeElement !== inp) inp.value = (c.prizes && c.prizes[lv]) || '';
  });
  // Joueurs + kick
  const apl = $('admin-player-list');
  apl.innerHTML = '';
  state.players.forEach((p) => {
    if (p.id === state.myId) return;
    const d = document.createElement('div');
    d.className = 'player-chip' + (p.spectator ? ' spect' : '');
    d.innerHTML = `<span class="dot"></span><span>${escapeHtml(p.pseudo)}${p.spectator ? ' 👀' : ''}</span>`;
    const k = document.createElement('button');
    k.className = 'kick'; k.textContent = 'Exclure';
    k.addEventListener('click', () => {
      if (confirm(`Exclure ${p.pseudo} de la partie ?`)) send({ type: 'kick', targetId: p.id });
    });
    d.appendChild(k);
    apl.appendChild(d);
  });
  if (!apl.children.length) apl.innerHTML = '<p class="hint small">Aucun autre joueur pour le moment.</p>';
  // Historique
  const h = $('admin-history');
  h.innerHTML = state.history.length ? '' : '<p class="hint small">Aucune manche jouée pour le moment.</p>';
  state.history.forEach((entry) => {
    const d = document.createElement('div');
    d.className = 'history-item';
    const dt = new Date(entry.at);
    d.innerHTML = `<div class="hdate">🕐 ${dt.toLocaleString('fr-FR')} · ${entry.ballsDrawn} boules</div>` +
      entry.results.map((r) => `<div class="hrow"><span>${r.pseudo ? '🏆' : '▫️'} ${escapeHtml(r.label)} <span class="lock">(${escapeHtml(r.prize || '')})</span></span><b>${r.pseudo ? escapeHtml(r.pseudo) : '—'}</b></div>`).join('');
    h.appendChild(d);
  });
}
function pushAdminConfig() {
  const prizes = {};
  state.levels.forEach((lv) => {
    const inp = $('pz-' + lv);
    prizes[lv] = inp ? inp.value.trim().slice(0, 20) : '';
  });
  send({ type: 'adminConfig', config: {
    gameName: $('cfg-gamename').value.trim().slice(0, 30),
    maxCards: Number($('cfg-maxcards').value),
    speed: $('cfg-speed').value,
    auto: $('cfg-auto').checked,
    prizes,
  }});
  toast('💾 Configuration envoyée.', true);
}

/* ---------------- Cagnottes ---------------- */
function renderPrizes(elId) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = '';
  state.levels.forEach((lv) => {
    const w = state.wonLevels[lv];
    const d = document.createElement('div');
    d.className = 'prize-row' + (w ? ' won' : '');
    d.innerHTML = `<span class="lvl">${w ? '🏆' : '▫️'} ${escapeHtml(state.levelLabels[lv])}</span>
      <span class="pz">${escapeHtml(state.prizes[lv] || '')}</span>
      ${w ? `<span class="win">${escapeHtml(w.pseudo)}</span>` : ''}`;
    el.appendChild(d);
  });
}

/* ---------------- Boules ---------------- */
function onBall(m) {
  state.drawn.add(m.number);
  sndBall();
  const ball = $('current-ball');
  ball.className = 'ball big pop ' + letterClass(m.number);
  ball.querySelector('.ball-letter').textContent = m.letter;
  ball.querySelector('.ball-number').textContent = m.number;
  $('game-drawn').textContent = m.drawIndex;
  const h = $('history');
  const chip = document.createElement('div');
  chip.className = 'ball small ' + letterClass(m.number);
  chip.innerHTML = `<span class="ball-letter">${m.letter}</span><span class="ball-number">${m.number}</span>`;
  h.prepend(chip);
  while (h.children.length > 8) h.lastChild.remove();
  syncBoard(); markCards(m.number);
  clearFinalBanner();
}
function syncBoard() {
  document.querySelectorAll('.bcell').forEach((c) => {
    c.classList.toggle('hit', state.drawn.has(Number(c.dataset.n)));
  });
}
function markCards(number) {
  document.querySelectorAll('.bingo-card').forEach((cardEl, ci) => {
    const card = state.myCards[ci];
    if (!card) return;
    card.forEach((row, r) => row.forEach((v, c) => {
      if (v === number) {
        const cell = cardEl.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
        if (cell && !cell.classList.contains('marked')) {
          cell.classList.add('marked', 'pop');
          setTimeout(() => cell.classList.remove('pop'), 400);
        }
      }
    }));
  });
  refreshClaimButtons();
}
function refreshClaimButtons() {
  document.querySelectorAll('.bingo-card').forEach((cardEl, ci) => {
    const card = state.myCards[ci];
    const btn = cardEl.querySelector('.claim-btn');
    if (!card || !btn) return;
    const lv = bestLevelFor(card);
    if (lv) {
      btn.classList.add('ready');
      btn.dataset.level = lv;
      btn.textContent = `🎉 BINGO — ${String(state.levelLabels[lv]).toUpperCase()} !`;
    } else {
      btn.classList.remove('ready');
      btn.dataset.level = '';
      btn.textContent = '🎉 BINGO !';
    }
  });
}
function syncCards() {
  document.querySelectorAll('.bingo-card').forEach((cardEl, ci) => {
    const card = state.myCards[ci];
    if (!card) return;
    card.forEach((row, r) => row.forEach((v, c) => {
      const cell = cardEl.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
      if (cell) cell.classList.toggle('marked', v === 0 || state.drawn.has(v));
    }));
  });
  refreshClaimButtons();
}

/* ---------------- Compte à rebours / démarrage ---------------- */
function onCountdown(v) {
  show('scr-game');
  buildGameUI();
  const ov = $('countdown-overlay');
  ov.classList.remove('hidden');
  $('countdown-num').textContent = v;
  $('countdown-num').style.animation = 'none';
  void $('countdown-num').offsetWidth;
  $('countdown-num').style.animation = '';
  sndCount();
  if (v === 1) setTimeout(() => ov.classList.add('hidden'), 900);
}
function onGameStart() {
  $('countdown-overlay').classList.add('hidden');
  state.drawn = new Set();
  $('history').innerHTML = '';
  const ball = $('current-ball');
  ball.className = 'ball big';
  ball.querySelector('.ball-letter').textContent = '?';
  ball.querySelector('.ball-number').textContent = '–';
  $('game-drawn').textContent = '0';
  buildGameUI();
  show('scr-game');
  toast('🎱 C’est parti ! Bonne chance !', true);
}

/* ---------------- Construction du jeu ---------------- */
function buildBoard() {
  const board = $('board');
  if (board.children.length) return;
  const cols = [['B', 1], ['I', 16], ['N', 31], ['G', 46], ['O', 61]];
  cols.forEach(([L, start]) => {
    const col = document.createElement('div');
    col.className = 'board-col ' + L.toLowerCase();
    col.innerHTML = `<h4>${L}</h4>`;
    for (let n = start; n < start + 15; n++) {
      const c = document.createElement('div');
      c.className = 'bcell'; c.dataset.n = n; c.textContent = n;
      col.appendChild(c);
    }
    board.appendChild(col);
  });
}
function buildGameUI() {
  buildBoard(); syncBoard();
  const wrap = $('my-cards');
  wrap.innerHTML = '';
  if (state.imSpectator) {
    wrap.innerHTML = '<p class="hint">👀 Mode spectateur : regarde les boules tomber !</p>';
    return;
  }
  state.myCards.forEach((card, ci) => {
    const el = document.createElement('div');
    el.className = 'bingo-card';
    el.innerHTML = `<div class="card-head"><span class="card-title">CARTE ${ci + 1}</span>
      <button class="claim-btn" data-ci="${ci}">🎉 BINGO !</button></div>
      <div class="card-grid"></div>`;
    const grid = el.querySelector('.card-grid');
    ['B', 'I', 'N', 'G', 'O'].forEach((L) => {
      const h = document.createElement('div');
      h.className = 'card-letter ' + L.toLowerCase(); h.textContent = L;
      grid.appendChild(h);
    });
    card.forEach((row, r) => row.forEach((v, c) => {
      const cell = document.createElement('div');
      cell.dataset.r = r; cell.dataset.c = c;
      if (v === 0) { cell.className = 'cell free'; cell.textContent = '★'; }
      else {
        cell.className = 'cell' + (state.drawn.has(v) ? ' marked' : '');
        cell.textContent = v;
      }
      grid.appendChild(cell);
    }));
    wrap.appendChild(el);
  });
  wrap.querySelectorAll('.claim-btn').forEach((b) => {
    b.addEventListener('click', () => {
      sndClick();
      const ci = Number(b.dataset.ci);
      const lv = b.dataset.level || bestLevelFor(state.myCards[ci]);
      if (!lv) { toast('Pas encore de palier complété sur cette carte.'); return; }
      send({ type: 'claim', cardIndex: ci, level: lv });
    });
  });
  refreshClaimButtons();
}

/* ---------------- Paliers & fin de partie ---------------- */
function onLevelWin(win) {
  state.wonLevels[win.level] = win;
  renderPrizes('prize-track');
  const iWon = win.id === state.myId;
  const prize = state.prizes[win.level] ? ` (${state.prizes[win.level]})` : '';
  sndWin();
  launchConfetti(iWon ? 220 : 70);
  toast(`🏆 « ${String(win.label).toUpperCase()} »${prize} remporté par ${iWon ? 'TOI' : win.pseudo} ! La partie continue…`, true);
  if (iWon) {
    document.querySelectorAll('.bingo-card')[win.cardIndex]?.classList.add('winner-card');
  }
  refreshClaimButtons();
}
function onGameOver(m) {
  clearFinalBanner();
  const wl = (m && m.wonLevels) || state.wonLevels;
  const levels = (m && m.levels) || state.levels;
  const labels = (m && m.levelLabels) || state.levelLabels;
  const prizes = (m && m.prizes) || state.prizes;
  const myWins = levels.filter((lv) => wl[lv] && wl[lv].id === state.myId).length;
  $('end-emoji').textContent = myWins > 0 ? '🏆' : '🎱';
  $('end-title').textContent = myWins > 0 ? 'FÉLICITATIONS !' : 'PARTIE TERMINÉE';
  $('end-sub').innerHTML = '<div class="prize-table">' + levels.map((lv) => {
    const w = wl[lv];
    const me = w && w.id === state.myId;
    return `<div class="prize-row${w ? ' won' : ''}"><span class="lvl">${w ? '🏆' : '▫️'} ${escapeHtml(labels[lv] || lv)}</span><span class="pz">${escapeHtml(prizes[lv] || '')}</span><span class="win">${w ? escapeHtml(me ? 'TOI ! 🎉' : w.pseudo) : '—'}</span></div>`;
  }).join('') + '</div>';
  $('btn-replay').classList.toggle('hidden', !(state.imHost || state.imAdmin));
  show('scr-end');
  launchConfetti(myWins > 0 ? 220 : 120);
}
function onFinalCall(sec) {
  const b = $('final-banner');
  b.classList.remove('hidden');
  let s = sec;
  $('final-secs').textContent = s;
  clearInterval(state.finalTimerInt);
  state.finalTimerInt = setInterval(() => {
    s--;
    if (s <= 0) { clearFinalBanner(); return; }
    $('final-secs').textContent = s;
  }, 1000);
  toast('🔥 Plus que ' + sec + ' secondes pour crier BINGO !');
}
function clearFinalBanner() {
  $('final-banner').classList.add('hidden');
  clearInterval(state.finalTimerInt);
}

/* ---------------- Confettis ---------------- */
function launchConfetti(count) {
  const cv = $('confetti'), ctx = cv.getContext('2d');
  cv.width = innerWidth; cv.height = innerHeight;
  const colors = ['#f5d67b', '#d4af37', '#ff5d5d', '#4de3a8', '#ffffff', '#a78bfa'];
  const parts = Array.from({ length: count }, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.3,
    w: 6 + Math.random() * 8, h: 8 + Math.random() * 10,
    c: colors[Math.floor(Math.random() * colors.length)],
    vy: 2 + Math.random() * 3.5, vx: -1.5 + Math.random() * 3,
    r: Math.random() * Math.PI, vr: -0.1 + Math.random() * 0.2,
  }));
  let frames = 0;
  (function tick() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    parts.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    if (++frames < 320) requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, cv.width, cv.height);
  })();
}

/* ---------------- Actions ---------------- */
function resetToHome() {
  state.code = null; state.myId = null; state.myCards = []; state.drawn = new Set();
  state.imAdmin = false; state.lastCode = null; state.lastPseudo = null;
  show('scr-home');
}
function cardsWanted() {
  return Math.min(25, Math.max(1, parseInt($('in-cards').value, 10) || 2));
}
$('btn-create').addEventListener('click', () => {
  const pseudo = $('in-pseudo').value.trim();
  if (!pseudo) { toast('⚠️ Entre ton pseudo d’abord !'); $('in-pseudo').focus(); return; }
  state.pseudo = pseudo; sndClick();
  send({ type: 'create', pseudo, cards: cardsWanted(),
    gameName: $('in-gamename').value.trim().slice(0, 30),
    adminPassword: $('in-adminpw').value });
});
$('btn-join').addEventListener('click', () => {
  const pseudo = $('in-pseudo').value.trim();
  const code = $('in-code').value.trim().toUpperCase();
  if (!pseudo) { toast('⚠️ Entre ton pseudo d’abord !'); return; }
  if (code.length !== 6) { toast('⚠️ Le code fait 6 caractères.'); return; }
  state.pseudo = pseudo; sndClick();
  send({ type: 'join', code, pseudo, cards: cardsWanted() });
});
$('in-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

$('btn-copy').addEventListener('click', async () => {
  sndClick();
  try { await navigator.clipboard.writeText(state.code); toast('📋 Code copié !', true); }
  catch { toast('Code : ' + state.code); }
});

$('btn-cfg-save').addEventListener('click', () => { sndClick(); pushAdminConfig(); });
$('btn-admin-login').addEventListener('click', () => { $('admin-modal').classList.remove('hidden'); $('in-admin-login-pw').focus(); });
$('btn-admin-login-cancel').addEventListener('click', () => { $('admin-modal').classList.add('hidden'); $('in-admin-login-pw').value = ''; });
$('btn-admin-login-ok').addEventListener('click', () => {
  send({ type: 'adminLogin', password: $('in-admin-login-pw').value });
  $('admin-modal').classList.add('hidden');
  $('in-admin-login-pw').value = '';
});

$('btn-start').addEventListener('click', () => { sndClick(); send({ type: 'start' }); });
$('btn-draw').addEventListener('click', () => { sndClick(); send({ type: 'draw' }); });
$('btn-pause').addEventListener('click', () => {
  sndClick();
  const paused = !$('paused-banner').classList.contains('hidden');
  send({ type: paused ? 'resume' : 'pause' });
  $('btn-pause').textContent = paused ? '⏸️ Pause' : '▶️ Reprendre';
});
$('btn-forceend').addEventListener('click', () => {
  if (confirm('Terminer la partie maintenant ?')) send({ type: 'forceEnd' });
});
$('board-toggle').addEventListener('click', () => {
  const b = $('board');
  b.classList.toggle('hidden');
  $('board-arrow').textContent = b.classList.contains('hidden') ? '▾' : '▴';
});
$('btn-replay').addEventListener('click', () => { sndClick(); send({ type: 'replay' }); });
$('btn-home').addEventListener('click', () => { send({ type: 'leave' }); resetToHome(); });
$('btn-leave-lobby').addEventListener('click', () => { send({ type: 'leave' }); resetToHome(); });
$('btn-leave-game').addEventListener('click', () => {
  if (confirm('Quitter la partie ?')) { send({ type: 'leave' }); resetToHome(); }
});
$('btn-mute').addEventListener('click', toggleMute);
$('btn-mute2').addEventListener('click', toggleMute);

/* ---------------- Init ---------------- */
updateMuteBtns();
buildBoard();
connect();
