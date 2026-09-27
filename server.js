'use strict';
/* ============================================================
   BINGO MULTIJOUEUR — Serveur temps réel (Node.js + Express + ws)
   - Salles en mémoire, codes à 6 caractères
   - Cartes générées côté serveur (validation anti-triche)
   - Tirage synchronisé, victoire vérifiée par le serveur
   ============================================================ */

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 100;
const MAX_CARDS = 25;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans 0/O, 1/I
const SPEEDS = { lent: 8000, normal: 5000, rapide: 3000 };
const SPEED_LABELS = { lent: 'Lent (8 s)', normal: 'Normal (5 s)', rapide: 'Rapide (3 s)' };
// Paliers progressifs style vrai bingo de salle : chaque palier = un gain, la partie continue.
const LEVELS = ['ligne1', 'ligne2', 'ligne3', 'ligne4', 'pleine'];
const LEVEL_LABELS = {
  ligne1: '1 ligne',
  ligne2: '2 lignes',
  ligne3: '3 lignes',
  ligne4: '4 lignes',
  pleine: 'Carte pleine',
};
const FINAL_CALL_SECONDS = 15; // délai de réclamation après la 75e boule

/* Configuration par défaut d'une salle (modifiable par l'admin) */
function defaultConfig() {
  return {
    gameName: 'Bingo Royal',
    maxCards: MAX_CARDS,
    speed: 'normal',
    auto: true,
    prizes: {
      ligne1: '10 $',
      ligne2: '25 $',
      ligne3: '50 $',
      ligne4: '100 $',
      pleine: '500 $',
    },
  };
}
function cleanText(s, max) {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ---------------- Utilitaires ---------------- */

const rooms = new Map();   // code -> room
const clients = new Map(); // clientId -> { ws, roomCode, playerId }

function genCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Carte 5x5 : colonnes B:1-15, I:16-30, N:31-45, G:46-60, O:61-75. Centre = 0 (gratuite). */
function genCard() {
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
  for (let c = 0; c < 5; c++) {
    const nums = shuffled(Array.from({ length: 15 }, (_, i) => ranges[c][0] + i)).slice(0, 5);
    for (let r = 0; r < 5; r++) grid[r][c] = nums[r];
  }
  grid[2][2] = 0;
  return grid;
}

function letterFor(n) {
  return n <= 15 ? 'B' : n <= 30 ? 'I' : n <= 45 ? 'N' : n <= 60 ? 'G' : 'O';
}

function cleanPseudo(p) {
  if (typeof p !== 'string') return '';
  return p.trim().slice(0, 16);
}

/* ---------------- Figures gagnantes ---------------- */

function allLines() {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([[r, 0], [r, 1], [r, 2], [r, 3], [r, 4]]);
  for (let c = 0; c < 5; c++) lines.push([[0, c], [1, c], [2, c], [3, c], [4, c]]);
  lines.push([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  lines.push([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]);
  return lines;
}
const LINES = allLines();

/* ---------------- Paliers gagnants (progressifs) ---------------- */

function countLinesDone(card, drawn) {
  const m = (r, c) => card[r][c] === 0 || drawn.has(card[r][c]);
  let n = 0;
  for (const cells of LINES) {
    if (cells.every(([r, c]) => m(r, c))) n++;
  }
  return n;
}

function checkLevel(card, drawn, level) {
  switch (level) {
    case 'ligne1': return countLinesDone(card, drawn) >= 1;
    case 'ligne2': return countLinesDone(card, drawn) >= 2;
    case 'ligne3': return countLinesDone(card, drawn) >= 3;
    case 'ligne4': return countLinesDone(card, drawn) >= 4;
    case 'pleine':
      for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
        if (card[r][c] !== 0 && !drawn.has(card[r][c])) return false;
      }
      return true;
    default: return false;
  }
}

/* ---------------- Messagerie ---------------- */

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId = null) {
  for (const p of room.players.values()) {
    if (p.id !== exceptId) send(p.ws, msg);
  }
}

function roomSnapshot(room, forPlayer) {
  return {
    type: 'room',
    code: room.code,
    state: room.state,
    config: room.config,
    speedLabels: SPEED_LABELS,
    levelLabels: LEVEL_LABELS,
    levels: LEVELS,
    wonLevels: room.wonLevels,
    drawnCount: room.drawn.size,
    lastBalls: room.drawOrder.slice(-10),
    hostId: room.hostId,
    myId: forPlayer ? forPlayer.id : null,
    imHost: forPlayer ? forPlayer.id === room.hostId : false,
    imSpectator: forPlayer ? !!forPlayer.spectator : false,
    myCards: forPlayer ? forPlayer.cards : [],
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      pseudo: p.pseudo,
      spectator: !!p.spectator,
      isHost: p.id === room.hostId,
      isAdmin: !!p.isAdmin,
      cards: p.cards.length,
    })),
    history: room.history,
    imAdmin: forPlayer ? !!forPlayer.isAdmin : false,
  };
}

function sendRoomToAll(room) {
  for (const p of room.players.values()) send(p.ws, roomSnapshot(room, p));
}

/* ---------------- Cycle de vie des salles ---------------- */

function clearTimers(room) {
  if (room.drawTimer) { clearInterval(room.drawTimer); room.drawTimer = null; }
  if (room.countdownTimer) { clearInterval(room.countdownTimer); room.countdownTimer = null; }
  if (room.finalTimer) { clearTimeout(room.finalTimer); room.finalTimer = null; }
}

function regenerateCards(room) {
  const max = Math.min(MAX_CARDS, Math.max(1, room.config.maxCards || MAX_CARDS));
  for (const p of room.players.values()) {
    if (p.spectator) { p.cards = []; continue; }
    const n = Math.min(max, Math.max(1, p.cardsWanted || 2));
    p.cards = Array.from({ length: n }, genCard);
  }
}

function drawBall(room) {
  if (room.state !== 'playing') return;
  const remaining = [];
  for (let n = 1; n <= 75; n++) if (!room.drawn.has(n)) remaining.push(n);
  if (remaining.length === 0) { startFinalCall(room); return; }
  const n = remaining[crypto.randomInt(remaining.length)];
  room.drawn.add(n);
  room.drawOrder.push(n);
  broadcast(room, {
    type: 'ball',
    number: n,
    letter: letterFor(n),
    drawIndex: room.drawOrder.length,
    remaining: 75 - room.drawOrder.length,
  });
  if (room.drawOrder.length === 75) startFinalCall(room);
}

/** Après la dernière boule : 15 s pour réclamer les paliers restants, puis fin. */
function startFinalCall(room) {
  if (room.finalTimer) return;
  broadcast(room, { type: 'finalCall', seconds: FINAL_CALL_SECONDS });
  room.finalTimer = setTimeout(() => {
    room.finalTimer = null;
    endGame(room);
  }, FINAL_CALL_SECONDS * 1000);
}

/** Fin de partie : annonce tous les paliers et leurs gagnants + historique. */
function endGame(room) {
  clearTimers(room);
  room.state = 'ended';
  const entry = {
    at: new Date().toISOString(),
    ballsDrawn: room.drawOrder.length,
    results: LEVELS.map((lv) => ({
      level: lv,
      label: LEVEL_LABELS[lv],
      prize: room.config.prizes[lv],
      pseudo: room.wonLevels[lv] ? room.wonLevels[lv].pseudo : null,
    })),
  };
  room.history.unshift(entry);
  room.history = room.history.slice(0, 10);
  broadcast(room, { type: 'gameOver', wonLevels: room.wonLevels, levels: LEVELS, levelLabels: LEVEL_LABELS, prizes: room.config.prizes });
  sendRoomToAll(room);
}

function startCountdown(room) {
  clearTimers(room);
  room.state = 'countdown';
  room.drawn = new Set();
  room.drawOrder = [];
  room.wonLevels = {};
  sendRoomToAll(room);
  let n = 5;
  broadcast(room, { type: 'countdown', value: n });
  room.countdownTimer = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      room.state = 'playing';
      broadcast(room, { type: 'gameStart' });
      if (room.config.auto) {
        room.drawTimer = setInterval(() => drawBall(room), SPEEDS[room.config.speed]);
      }
    } else {
      broadcast(room, { type: 'countdown', value: n });
    }
  }, 1000);
}

function removePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;
  room.players.delete(playerId);
  broadcast(room, { type: 'playerLeft', pseudo: player.pseudo });
  if (room.players.size === 0) {
    clearTimers(room);
    rooms.delete(room.code);
    return;
  }
  if (playerId === room.hostId) {
    // L'hôte passe au joueur restant le plus ancien (non spectateur de préférence)
    const candidates = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const next = candidates.find((p) => !p.spectator) || candidates[0];
    room.hostId = next.id;
    broadcast(room, { type: 'hostChanged', pseudo: next.pseudo, id: next.id });
  }
  sendRoomToAll(room);
}

/* ---------------- Gestion des messages ---------------- */

function handleMessage(clientId, raw) {
  const ctx = clients.get(clientId);
  if (!ctx) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { send(ctx.ws, { type: 'error', message: 'Message invalide.' }); return; }

  switch (msg.type) {
    case 'create': {
      const pseudo = cleanPseudo(msg.pseudo);
      if (!pseudo) { send(ctx.ws, { type: 'error', message: 'Choisis un pseudo pour créer une partie.' }); return; }
      const adminPassword = cleanText(msg.adminPassword, 32) || 'admin123';
      const cardsWanted = Math.min(MAX_CARDS, Math.max(1, parseInt(msg.cards, 10) || 2));
      const code = genCode();
      const playerId = crypto.randomUUID();
      const room = {
        code,
        hostId: playerId,
        adminPassword,
        players: new Map(),
        config: defaultConfig(),
        state: 'lobby',
        drawn: new Set(),
        drawOrder: [],
        wonLevels: {},
        history: [],
        drawTimer: null,
        countdownTimer: null,
        finalTimer: null,
      };
      const cfgName = cleanText(msg.gameName, 30);
      if (cfgName) room.config.gameName = cfgName;
      const player = {
        id: playerId, pseudo, ws: ctx.ws, cards: [], cardsWanted,
        joinedAt: Date.now(), spectator: false, isAdmin: true,
      };
      room.players.set(playerId, player);
      regenerateCards(room);
      rooms.set(code, room);
      ctx.roomCode = code;
      ctx.playerId = playerId;
      send(ctx.ws, { type: 'joined', code });
      sendRoomToAll(room);
      break;
    }

    case 'join': {
      const code = String(msg.code || '').trim().toUpperCase();
      const pseudo = cleanPseudo(msg.pseudo);
      const room = rooms.get(code);
      if (!room) { send(ctx.ws, { type: 'error', message: 'Code de partie introuvable. Vérifie le code.' }); return; }
      if (!pseudo) { send(ctx.ws, { type: 'error', message: 'Choisis un pseudo pour rejoindre.' }); return; }
      const playing = room.state === 'playing' || room.state === 'paused' || room.state === 'countdown';
      const realPlayers = [...room.players.values()].filter((p) => !p.spectator).length;
      if (!playing && realPlayers >= MAX_PLAYERS) {
        send(ctx.ws, { type: 'error', message: 'Partie complète (100 joueurs max).' });
        return;
      }
      const taken = [...room.players.values()].some((p) => p.pseudo.toLowerCase() === pseudo.toLowerCase());
      if (taken) { send(ctx.ws, { type: 'error', message: 'Ce pseudo est déjà pris dans cette partie.' }); return; }
      const playerId = crypto.randomUUID();
      const cardsWanted = Math.min(MAX_CARDS, Math.max(1, parseInt(msg.cards, 10) || 2));
      const player = {
        id: playerId, pseudo, ws: ctx.ws, cards: [], cardsWanted,
        joinedAt: Date.now(), spectator: playing, isAdmin: false, // rejoint en cours de partie = spectateur
      };
      room.players.set(playerId, player);
      regenerateCards(room);
      ctx.roomCode = code;
      ctx.playerId = playerId;
      send(ctx.ws, { type: 'joined', code, spectator: player.spectator });
      if (player.spectator) send(ctx.ws, { type: 'notice', message: 'Partie en cours : tu es spectateur. Tu pourras jouer à la prochaine manche.' });
      sendRoomToAll(room);
      break;
    }

    case 'adminLogin': {
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player) return;
      if (cleanText(msg.password, 32) === room.adminPassword) {
        player.isAdmin = true;
        send(ctx.ws, { type: 'notice', message: '🔑 Connecté en tant qu’administrateur.' });
        sendRoomToAll(room);
      } else {
        send(ctx.ws, { type: 'error', message: 'Mot de passe admin incorrect.' });
      }
      break;
    }

    case 'adminConfig': {
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player) return;
      if (!player.isAdmin) { send(ctx.ws, { type: 'error', message: 'Réservé à l’administrateur.' }); return; }
      if (room.state !== 'lobby') { send(ctx.ws, { type: 'error', message: 'Configuration modifiable uniquement dans le salon.' }); return; }
      const c = msg.config || {};
      const name = cleanText(c.gameName, 30);
      if (name) room.config.gameName = name;
      const mc = parseInt(c.maxCards, 10);
      if (mc >= 1 && mc <= MAX_CARDS) room.config.maxCards = mc;
      if (Object.keys(SPEEDS).includes(c.speed)) room.config.speed = c.speed;
      if (typeof c.auto === 'boolean') room.config.auto = c.auto;
      if (c.prizes && typeof c.prizes === 'object') {
        for (const lv of LEVELS) {
          const pz = cleanText(c.prizes[lv], 20);
          if (pz) room.config.prizes[lv] = pz;
        }
      }
      regenerateCards(room);
      sendRoomToAll(room);
      break;
    }

    case 'kick': {
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player) return;
      if (!player.isAdmin) { send(ctx.ws, { type: 'error', message: 'Réservé à l’administrateur.' }); return; }
      const target = room.players.get(msg.targetId);
      if (!target || target.id === player.id) { send(ctx.ws, { type: 'error', message: 'Joueur introuvable.' }); return; }
      send(target.ws, { type: 'kicked', message: 'Tu as été exclu de la partie par l’administrateur.' });
      try { target.ws.close(); } catch { /* noop */ }
      removePlayer(room, target.id);
      break;
    }

    case 'forceEnd': {
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player) return;
      if (!player.isAdmin) { send(ctx.ws, { type: 'error', message: 'Réservé à l’administrateur.' }); return; }
      if (room.state !== 'playing' && room.state !== 'paused') return;
      endGame(room);
      break;
    }

    case 'start': {
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player) return;
      if (player.id !== room.hostId && !player.isAdmin) { send(ctx.ws, { type: 'error', message: 'Seul l’hôte ou l’admin peut lancer la partie.' }); return; }
      if (room.state !== 'lobby' && room.state !== 'ended') return;
      if ([...room.players.values()].filter((p) => !p.spectator).length < 1) {
        send(ctx.ws, { type: 'error', message: 'Il faut au moins 1 joueur pour lancer.' });
        return;
      }
      regenerateCards(room);
      startCountdown(room);
      break;
    }

    case 'draw': { // tirage manuel (hôte)
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player) return;
      if (player.id !== room.hostId && !player.isAdmin) return;
      if (room.state !== 'playing') return;
      drawBall(room);
      break;
    }

    case 'pause': {
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player || (player.id !== room.hostId && !player.isAdmin)) return;
      if (room.state !== 'playing') return;
      if (room.drawTimer) { clearInterval(room.drawTimer); room.drawTimer = null; }
      room.state = 'paused';
      broadcast(room, { type: 'paused' });
      sendRoomToAll(room);
      break;
    }

    case 'resume': {
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player || (player.id !== room.hostId && !player.isAdmin)) return;
      if (room.state !== 'paused') return;
      room.state = 'playing';
      broadcast(room, { type: 'resumed' });
      if (room.config.auto) room.drawTimer = setInterval(() => drawBall(room), SPEEDS[room.config.speed]);
      sendRoomToAll(room);
      break;
    }

    case 'claim': {
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player) return;
      if (room.state !== 'playing' && room.state !== 'paused') {
        send(ctx.ws, { type: 'error', message: 'Pas de partie en cours.' });
        return;
      }
      if (player.spectator) { send(ctx.ws, { type: 'error', message: 'Les spectateurs ne peuvent pas gagner.' }); return; }
      const level = msg.level;
      if (!LEVELS.includes(level)) { send(ctx.ws, { type: 'error', message: 'Palier invalide.' }); return; }
      if (room.wonLevels[level]) {
        send(ctx.ws, { type: 'error', message: `« ${LEVEL_LABELS[level]} » déjà remporté par ${room.wonLevels[level].pseudo} !` });
        return;
      }
      const idx = msg.cardIndex;
      const card = player.cards[idx];
      if (!card) { send(ctx.ws, { type: 'error', message: 'Carte invalide.' }); return; }
      const t0 = Date.now();
      if (checkLevel(card, room.drawn, level)) {
        const win = {
          level,
          label: LEVEL_LABELS[level],
          id: player.id,
          pseudo: player.pseudo,
          cardIndex: idx,
          ballsDrawn: room.drawOrder.length,
        };
        room.wonLevels[level] = win;
        if (level === 'pleine') {
          endGame(room); // carte pleine = fin de partie
        } else {
          broadcast(room, { type: 'levelWin', win, wonLevels: room.wonLevels });
          sendRoomToAll(room);
        }
      } else {
        send(ctx.ws, { type: 'error', message: `Raté ! Ta carte n’a pas encore « ${LEVEL_LABELS[level]} » (${Date.now() - t0} ms de vérif).` });
      }
      break;
    }

    case 'replay': {
      const room = rooms.get(ctx.roomCode);
      const player = room && room.players.get(ctx.playerId);
      if (!room || !player) return;
      if (player.id !== room.hostId && !player.isAdmin) { send(ctx.ws, { type: 'error', message: 'Seul l’hôte ou l’admin peut relancer.' }); return; }
      if (room.state !== 'ended') return;
      // Les spectateurs deviennent joueurs pour la nouvelle manche
      for (const p of room.players.values()) p.spectator = false;
      regenerateCards(room);
      startCountdown(room);
      break;
    }

    case 'leave': {
      const room = rooms.get(ctx.roomCode);
      if (room) removePlayer(room, ctx.playerId);
      ctx.roomCode = null;
      ctx.playerId = null;
      send(ctx.ws, { type: 'left' });
      break;
    }

    default:
      send(ctx.ws, { type: 'error', message: 'Action inconnue.' });
  }
}

/* ---------------- Connexions ---------------- */

wss.on('connection', (ws) => {
  const clientId = crypto.randomUUID();
  clients.set(clientId, { ws, roomCode: null, playerId: null });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => handleMessage(clientId, raw));

  const cleanup = () => {
    const ctx = clients.get(clientId);
    if (ctx && ctx.roomCode) {
      const room = rooms.get(ctx.roomCode);
      if (room) removePlayer(room, ctx.playerId);
    }
    clients.delete(clientId);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// Nettoyage des connexions mortes
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`🎱 Bingo multijoueur en ligne sur http://localhost:${PORT}`);
});

module.exports = { server, rooms, checkLevel, countLinesDone, genCard, letterFor };
