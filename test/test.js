'use strict';
/* Tests d'intégration du bingo multijoueur (paliers progressifs, 1-25 cartes).
   Lance le serveur, simule des joueurs WebSocket et vérifie le protocole. */
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3001;
const DIR = path.join(__dirname, '..');
const LEVELS = ['ligne1', 'ligne2', 'ligne3', 'ligne4', 'pleine'];
let failures = 0;

function ok(name, cond, extra = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { console.log(`  ❌ ${name} ${extra}`); failures++; }
}

/* ---------- Petit client de test ---------- */
class TC {
  constructor() {
    this.ws = new WebSocket(`ws://localhost:${PORT}`);
    this.inbox = [];
    this.waiters = [];
    this.opened = new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
    this.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      this.inbox.push(m);
      this.waiters = this.waiters.filter(([pred, res]) => {
        if (pred(m)) { res(m); return false; }
        return true;
      });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  mark() { return this.inbox.length; }
  waitForNew(pred, since, timeout = 10000) {
    for (let i = since; i < this.inbox.length; i++) {
      if (pred(this.inbox[i])) return Promise.resolve(this.inbox[i]);
    }
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w[1] !== res);
        rej(new Error('timeout en attendant un message'));
      }, timeout);
      this.waiters.push([(m) => this.inbox.indexOf(m) >= since && pred(m), (m) => { clearTimeout(t); res(m); }]);
    });
  }
  waitFor(pred, timeout = 10000) {
    const found = this.inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w[1] !== res);
        rej(new Error('timeout en attendant un message'));
      }, timeout);
      this.waiters.push([pred, (m) => { clearTimeout(t); res(m); }]);
    });
  }
  lastRoom() {
    return [...this.inbox].reverse().find((m) => m.type === 'room');
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

/* ---------- Miroir des paliers côté test ---------- */
function countLines(card, drawn) {
  const m = (r, c) => card[r][c] === 0 || drawn.has(card[r][c]);
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([[r, 0], [r, 1], [r, 2], [r, 3], [r, 4]]);
  for (let c = 0; c < 5; c++) lines.push([[0, c], [1, c], [2, c], [3, c], [4, c]]);
  lines.push([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  lines.push([[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]]);
  return lines.filter((cells) => cells.every(([r, c]) => m(r, c))).length;
}
function checkLevel(card, drawn, level) {
  if (level === 'pleine') {
    return card.every((row) => row.every((v) => v === 0 || drawn.has(v)));
  }
  return countLines(card, drawn) >= Number(level.slice(5));
}

function waitServer(proc) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('serveur trop lent à démarrer')), 15000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('en ligne sur')) { clearTimeout(t); res(); }
    });
    proc.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
    proc.on('exit', (c) => { clearTimeout(t); rej(new Error('serveur quitté code ' + c)); });
  });
}

async function main() {
  console.log('🚀 Démarrage du serveur de test…');
  const proc = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, cwd: DIR });
  await waitServer(proc);
  console.log('✅ Serveur démarré\n');

  /* ── TEST 1 : création + jointure + 1 à 25 cartes ── */
  console.log('TEST 1 — Création, jointure et nombre de cartes');
  const host = new TC(); await host.opened;
  host.send({ type: 'create', pseudo: 'Hote', cards: 25, gameName: 'Soirée Test', adminPassword: 'secret123' });
  const joined = await host.waitFor((m) => m.type === 'joined');
  ok('hôte reçoit joined + code à 6 caractères', /^[A-Z2-9]{6}$/.test(joined.code));
  const code = joined.code;
  const room1 = await host.waitFor((m) => m.type === 'room');
  ok('hôte reçoit snapshot room', room1.players.length === 1 && room1.imHost === true);
  ok('créateur = admin', room1.imAdmin === true);
  ok('nom de partie personnalisé', room1.config.gameName === 'Soirée Test', `reçu=${room1.config.gameName}`);
  ok('cagnottes par défaut présentes', room1.config.prizes.pleine === '500 $');
  ok('25 cartes générées pour l’hôte', room1.myCards.length === 25, `reçu=${room1.myCards.length}`);

  const players = [];
  for (let i = 1; i <= 3; i++) {
    const p = new TC(); await p.opened;
    p.send({ type: 'join', code, pseudo: 'Joueur' + i, cards: i === 1 ? 1 : 2 });
    const j = await p.waitFor((m) => m.type === 'joined');
    ok(`Joueur${i} rejoint`, j.code === code && j.spectator === false);
    players.push(p);
  }
  const r1 = await players[0].waitFor((m) => m.type === 'room' && m.myCards.length === 1);
  ok('Joueur1 a 1 carte (choix perso)', r1.myCards.length === 1);
  const roomAfter = await host.waitFor((m) => m.type === 'room' && m.players.length === 4);
  ok('4 joueurs dans le salon', roomAfter.players.length === 4);

  // Cartes invalides bornées à 1-25
  const bad = new TC(); await bad.opened;
  bad.send({ type: 'join', code, pseudo: 'Tricheur', cards: 999 });
  const rb = await bad.waitFor((m) => m.type === 'room' && m.myCards.length > 0);
  ok('cartes bornées à 25 max', rb.myCards.length === 25, `reçu=${rb.myCards.length}`);

  // Cas d'erreur : mauvais code, pseudo doublon
  const since1 = bad.mark();
  bad.send({ type: 'join', code: 'ZZZZZZ', pseudo: 'X' });
  const e1 = await bad.waitForNew((m) => m.type === 'error', since1);
  ok('code inexistant rejeté', /introuvable/.test(e1.message));
  const since2 = bad.mark();
  bad.send({ type: 'join', code, pseudo: 'joueur1' });
  const e2 = await bad.waitForNew((m) => m.type === 'error', since2);
  ok('pseudo doublon rejeté (insensible à la casse)', /déjà pris/.test(e2.message));

  // Paramètres par un non-admin
  const since3 = players[0].mark();
  players[0].send({ type: 'adminConfig', config: { speed: 'rapide' } });
  const e3 = await players[0].waitForNew((m) => m.type === 'error', since3);
  ok('non-admin ne peut pas configurer', /admin/i.test(e3.message));
  bad.close();

  /* ── TEST 1b : connexion admin par mot de passe ── */
  console.log('\nTEST 1b — Connexion admin');
  const adm2 = new TC(); await adm2.opened;
  adm2.send({ type: 'join', code, pseudo: 'FuturAdmin', cards: 1 });
  await adm2.waitFor((m) => m.type === 'joined');
  const rAdm0 = await adm2.waitFor((m) => m.type === 'room');
  ok('nouveau joueur non-admin par défaut', rAdm0.imAdmin === false);
  const sinceA = adm2.mark();
  adm2.send({ type: 'adminLogin', password: 'mauvais' });
  const eA = await adm2.waitForNew((m) => m.type === 'error', sinceA);
  ok('mauvais mot de passe admin refusé', /incorrect/.test(eA.message));
  adm2.send({ type: 'adminLogin', password: 'secret123' });
  const rAdm1 = await adm2.waitFor((m) => m.type === 'room' && m.imAdmin === true, 8000);
  ok('bon mot de passe → admin', rAdm1.imAdmin === true);

  /* ── TEST 2 : configuration admin + démarrage ── */
  console.log('\nTEST 2 — Configuration admin et démarrage');
  host.send({ type: 'adminConfig', config: {
    gameName: 'Soirée Test', maxCards: 25, speed: 'rapide', auto: false,
    prizes: { ligne1: '5 €', ligne2: '10 €', ligne3: '20 €', ligne4: '50 €', pleine: '200 €' },
    pattern: 'pleine', cardsPerPlayer: 99,
  }});
  const rs = await host.waitFor((m) => m.type === 'room' && m.config.speed === 'rapide' && m.config.auto === false);
  ok('vitesse + tirage manuel appliqués', rs.config.speed === 'rapide');
  ok('cagnottes personnalisées', rs.config.prizes.pleine === '200 €' && rs.config.prizes.ligne1 === '5 €');
  ok('champs inconnus ignorés', rs.config.pattern === undefined && rs.config.cardsPerPlayer === undefined);
  ok('paliers progressifs annoncés', JSON.stringify(rs.levels) === JSON.stringify(LEVELS));
  host.send({ type: 'start' });
  const cd = await host.waitFor((m) => m.type === 'countdown' && m.value === 5);
  ok('compte à rebours synchronisé (5)', cd.value === 5);
  const gs = await host.waitFor((m) => m.type === 'gameStart', 15000);
  ok('gameStart diffusé', !!gs);
  for (const p of players) await p.waitFor((m) => m.type === 'gameStart', 15000);
  ok('gameStart reçu par les 3 joueurs', true);

  /* ── TEST 3 : paliers progressifs ── */
  console.log('\nTEST 3 — Paliers progressifs (1→2→3→4 lignes→pleine)');
  const all = [host, ...players];
  const cardsOf = new Map();
  for (const c of all) {
    const snap = c.lastRoom();
    cardsOf.set(c, snap.myCards);
  }
  const drawn = new Set();
  const won = {};
  const winners = {};
  // Claim invalide : palier non complété
  const since4 = players[0].mark();
  players[0].send({ type: 'claim', cardIndex: 0, level: 'ligne1' });
  const e4 = await players[0].waitForNew((m) => m.type === 'error', since4);
  ok('claim prématuré rejeté', /Raté/.test(e4.message));

  for (let d = 0; d < 75 && !won.pleine; d++) {
    host.send({ type: 'draw' });
    const ball = await host.waitFor((m) => m.type === 'ball' && m.drawIndex === d + 1, 5000);
    drawn.add(ball.number);
    // cherche le premier palier non remporté qu'une carte complète
    let claimed = null;
    for (const lv of LEVELS) {
      if (won[lv]) continue;
      for (const c of all) {
        const cards = cardsOf.get(c);
        for (let ci = 0; ci < cards.length; ci++) {
          if (checkLevel(cards[ci], drawn, lv)) { claimed = { lv, c, ci }; break; }
        }
        if (claimed) break;
      }
      if (claimed) break;
    }
    if (!claimed) continue;
    const { lv, c, ci } = claimed;
    c.send({ type: 'claim', cardIndex: ci, level: lv });
    if (lv === 'pleine') {
      const gos = await Promise.all(all.map((x) => x.waitFor((m) => m.type === 'gameOver', 10000)));
      ok('« carte pleine » termine la partie (gameOver diffusé)', gos.length === 4);
      ok('gameOver contient les 5 paliers', gos.every((g) => g.levels.length === 5));
      won.pleine = gos[0].wonLevels.pleine;
      winners.pleine = won.pleine.pseudo;
    } else {
      const lws = await Promise.all(all.map((x) => x.waitFor((m) => m.type === 'levelWin' && m.win.level === lv, 8000)));
      ok(`palier « ${lv} » annoncé à tous (levelWin)`, lws.length === 4);
      won[lv] = lws[0].win;
      winners[lv] = won[lv].pseudo;
      // la partie CONTINUE après un palier intermédiaire
      const still = await c.waitFor((m) => m.type === 'room' && m.state === 'playing' && m.wonLevels[lv], 8000);
      ok(`partie continue après « ${lv} »`, still.state === 'playing');
      // réclamer le même palier une 2e fois = refusé
      const since5 = c.mark();
      c.send({ type: 'claim', cardIndex: ci, level: lv });
      const e5 = await c.waitForNew((m) => m.type === 'error', since5, 8000);
      ok(`palier « ${lv} » non regagnable`, /déjà remporté/.test(e5.message));
    }
  }
  ok('les 5 paliers ont été remportés', LEVELS.every((lv) => !!won[lv]), `manquants=${LEVELS.filter((lv) => !won[lv])}`);
  console.log('   Gagnants : ' + LEVELS.map((lv) => `${lv}=${winners[lv] || '?'}`).join(', '));

  /* ── TEST 3b : exclusion par l'admin ── */
  console.log('\nTEST 3b — Exclusion (kick)');
  const sinceK = adm2.mark();
  const sinceH = host.mark();
  // un non-admin ne peut pas exclure
  const sinceP0 = players[0].mark();
  players[0].send({ type: 'kick', targetId: adm2.lastRoom().myId });
  const eK = await players[0].waitForNew((m) => m.type === 'error', sinceP0, 8000);
  ok('kick par non-admin refusé', /admin/i.test(eK.message));
  host.send({ type: 'kick', targetId: adm2.lastRoom().myId });
  const kicked = await adm2.waitForNew((m) => m.type === 'kicked', sinceK, 8000);
  ok('joueur exclu notifié', /exclu/.test(kicked.message));
  const rAfterKick = await host.waitForNew((m) => m.type === 'room' && !m.players.some((p) => p.pseudo === 'FuturAdmin'), sinceH, 8000);
  ok('joueur retiré de la liste', !rAfterKick.players.some((p) => p.pseudo === 'FuturAdmin'));
  adm2.close();
  console.log('\nTEST 4 — Limite de 100 joueurs');
  const host2 = new TC(); await host2.opened;
  host2.send({ type: 'create', pseudo: 'Hote2', cards: 2 });
  const j2 = await host2.waitFor((m) => m.type === 'joined');
  const code2 = j2.code;
  const extra = [];
  let extraCount = 0;
  for (let b = 0; b < 5 && extra.length < 99; b++) {
    const batch = [];
    while (batch.length < 20 && extra.length + batch.length < 99) {
      const p = new TC();
      const n = extraCount++;
      batch.push(p.opened.then(() => {
        p.send({ type: 'join', code: code2, pseudo: 'Extra' + n, cards: 1 });
        return p.waitFor((m) => m.type === 'joined', 10000).then(() => p);
      }));
    }
    const done = await Promise.all(batch);
    extra.push(...done);
  }
  const full = await host2.waitFor((m) => m.type === 'room' && m.players.length === 100, 15000);
  ok('100 joueurs dans la salle', full.players.length === 100);
  const tooMany = new TC(); await tooMany.opened;
  tooMany.send({ type: 'join', code: code2, pseudo: 'TropTard', cards: 1 });
  const e6 = await tooMany.waitFor((m) => m.type === 'error', 8000);
  ok('101e joueur refusé proprement', /complète|100/.test(e6.message));
  tooMany.close();
  extra.forEach((p) => p.close());

  /* ── TEST 5 : migration d'hôte + rejouer ── */
  console.log('\nTEST 5 — Migration d’hôte');
  host.close(); // l'hôte de la salle 1 quitte
  const hc = await players[0].waitFor((m) => m.type === 'hostChanged', 8000);
  ok('hostChanged diffusé', hc.pseudo === 'Joueur1', `reçu=${hc.pseudo}`);
  players[0].send({ type: 'replay' });
  const cd2 = await players[1].waitFor((m) => m.type === 'countdown' && m.value === 5, 12000);
  ok('nouvel hôte relance la partie (replay)', cd2.value === 5);
  // les paliers sont réinitialisés pour la nouvelle manche
  const rsnap = await players[1].waitFor((m) => m.type === 'room' && m.state === 'countdown', 8000);
  ok('paliers réinitialisés à la nouvelle manche', Object.keys(rsnap.wonLevels).length === 0);
  players.forEach((p) => p.close());

  /* ── TEST 6 : spectateur qui rejoint en cours de partie ── */
  console.log('\nTEST 6 — Spectateur en cours de partie');
  const spec = new TC(); await spec.opened;
  spec.send({ type: 'join', code: code2, pseudo: 'Spectateur', cards: 3 });
  const js = await spec.waitFor((m) => m.type === 'joined', 8000);
  ok('rejoint le salon normalement (pas spectateur)', js.spectator === false);
  host2.send({ type: 'start' });
  await host2.waitFor((m) => m.type === 'gameStart', 15000);
  const late = new TC(); await late.opened;
  late.send({ type: 'join', code: code2, pseudo: 'Retardataire', cards: 2 });
  const jl = await late.waitFor((m) => m.type === 'joined', 8000);
  const notice = await late.waitFor((m) => m.type === 'notice', 8000).catch(() => null);
  ok('joueur tardif = spectateur', jl.spectator === true);
  ok('spectateur notifié', !!notice);
  late.send({ type: 'claim', cardIndex: 0, level: 'ligne1' });
  const e7 = await late.waitFor((m) => m.type === 'error', 8000);
  ok('claim spectateur rejeté', /spectateur/i.test(e7.message));
  late.close(); spec.close(); host2.close();

  proc.kill();
  console.log(`\n${failures === 0 ? '🎉 TOUS LES TESTS RÉUSSIS' : `⚠️ ${failures} ÉCHEC(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('\n💥 ERREUR FATALE :', err.message); process.exit(2); });
