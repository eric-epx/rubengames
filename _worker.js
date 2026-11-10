/**
 * Ruben Games — the server (runs on Cloudflare Pages, data in Cloudflare D1).
 *
 * Every page on the site is a plain file. The pages talk to this code by POSTing
 * { fn: 'lbInit', args: [...] } to /api, and get back { ok: true, result } or { ok: false, error }.
 * Errors that start with "AUTH:" tell the page to show the sign-in screen again.
 *
 * Needs ONE setting in Cloudflare: a D1 database binding named DB (see the setup guide).
 * There are no passwords or keys in this file. The session secret is made automatically and
 * kept in the database; the admin password is kept there too, salted and scrambled.
 *
 * THIS FILE IS BUILT from cf/worker_src.js by build_site.js (it fills in the game list).
 */

// The games (from the arcade list) and their leaderboard cheat guards
const GAMES = [
  {
    "id": "balloon",
    "title": "Blowin' in the Wind",
    "emoji": "🎃",
    "color": "#ff7a00"
  },
  {
    "id": "snowman",
    "title": "Feisty Frosty",
    "emoji": "⛄",
    "color": "#6cb4ef"
  },
  {
    "id": "chocoholic",
    "title": "Confessions of a Chocoholic",
    "emoji": "🍫",
    "color": "#ef5f86"
  },
  {
    "id": "forest",
    "title": "Forest Quest",
    "emoji": "🌲",
    "color": "#e8b64a"
  },
  {
    "id": "duck",
    "title": "Duck Dynasty",
    "emoji": "🦆",
    "color": "#e0874a"
  },
  {
    "id": "door",
    "title": "Door Dasher",
    "emoji": "🍕",
    "color": "#d23a2a"
  }
];
const LB_GAMES = {
  "duck": {
    "maxPerSecond": 0.6,
    "maxScore": 300
  },
  "door": {
    "maxPerSecond": 3.5,
    "maxScore": 450
  },
  "forest": {
    "maxPerSecond": 6,
    "maxScore": 2500
  },
  "chocoholic": {
    "maxPerSecond": 6,
    "maxScore": 800
  },
  "snowman": {
    "maxPerSecond": 2.5,
    "maxScore": 400
  },
  "balloon": {
    "lowerIsBetter": true,
    "minScore": 150,
    "maxScore": 60000
  }
};

const LB_LEVELS = ['easy', 'medium', 'hard'];
const LB_MIN_SECONDS = 2;
const LB_NAME_MAX = 24;
const AUTH_USER_MAX = 20;
const AUTH_TOKEN_DAYS = 30;
const AP_TOKEN_HOURS = 12;
const AP_MAX_FAILS = 6;            // wrong admin passwords before a 15-minute lockout
const TZ = 'America/Denver';

// ============================================================================ request handling

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname === '/api/') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST.' }, 405);
      let body;
      try { body = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, error: 'Bad request.' }, 400); }
      const fn = body && body.fn, args = Array.isArray(body && body.args) ? body.args : [];
      const handler = Object.prototype.hasOwnProperty.call(API, fn) ? API[fn] : null;
      if (!handler) return json({ ok: false, error: 'Unknown request: ' + fn }, 404);
      if (!env.DB) return json({ ok: false, error: 'The database isn\'t connected yet (add a D1 binding named DB in Cloudflare).' }, 500);
      try {
        const c = new Ctx(env, request);
        await c.schema();
        const result = await handler(c, ...args);
        return json({ ok: true, result: result === undefined ? null : result });
      } catch (e) {
        const msg = e && e.userFacing ? e.message : (e && /^AUTH:/.test(e.message) ? e.message : null);
        if (!msg) console.error(fn, e && e.stack || e);
        return json({ ok: false, error: msg || 'Something went wrong on the server. Please try again.' }, 200);
      }
    }
    // old Apps Script style links: /?game=door → /door, /?page=admin → /admin
    if (url.pathname === '/' && (url.searchParams.get('game') || url.searchParams.get('page'))) {
      const to = (url.searchParams.get('game') || url.searchParams.get('page') || '').replace(/[^a-z0-9_-]/gi, '');
      if (to) return Response.redirect(url.origin + '/' + to, 302);
    }
    return env.ASSETS.fetch(request);       // every other address is a normal file (pages, images…)
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
/** An error whose message is meant for the player. */
function oops(message) { const e = new Error(message); e.userFacing = true; return e; }
function authErr(message) { const e = new Error('AUTH: ' + (message || 'Please sign in again.')); e.userFacing = true; return e; }

// ============================================================================ the API (names match the old Apps Script functions)

const API = {
  // ---------------------------------------------------------------- players
  /** The "Who's playing?" list: every player's user name and leaderboard name, nothing else. */
  async authList(c) {
    const rows = await c.all('SELECT username, display_name FROM players WHERE username IS NOT NULL ORDER BY lower(display_name) LIMIT 3000');
    return rows.map(r => ({ u: r.username, n: r.display_name || r.username }));
  },

  /** Create a new player (no password). */
  async authSignUp(c, username) {
    const u = cleanUser(username), id = 'u:' + u.toLowerCase();
    const taken = await c.first('SELECT COUNT(*) AS n FROM players WHERE id = ? OR lower(username) = lower(?) OR lower(display_name) = lower(?)', id, u, u);
    if (taken && taken.n > 0) throw oops('There\'s already a player called "' + u + '". Pick them from the list, or add a letter or number to make a new name.');
    const now = Date.now();
    try {
      await c.run('INSERT INTO players (id, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, u, u, now, now);
    } catch (e) {
      throw oops('There\'s already a player called "' + u + '". Pick them from the list.');
    }
    return { token: await c.makeToken(id, u), name: u, user: u };
  },

  /** Sign in by picking your name. */
  async authSignIn(c, who) {
    const u = String(who == null ? '' : who).replace(/\s+/g, ' ').trim();
    if (!u) throw oops('Type your name.');
    let p = await c.first('SELECT id, username, display_name FROM players WHERE lower(username) = lower(?) LIMIT 1', u);
    if (!p) p = await c.first('SELECT id, username, display_name FROM players WHERE lower(display_name) = lower(?) AND username IS NOT NULL LIMIT 1', u);
    if (!p) throw oops('There\'s no player called "' + u + '" yet. Tap "New player" to join.');
    return { token: await c.makeToken(p.id, p.username), name: p.display_name, user: p.username };
  },

  /** No passwords any more; kept so an old page can't break anything. */
  async authChangePassword() { throw oops('Players don\'t have passwords any more.'); },

  async authMe(c, token) {
    const s = await c.session(token);
    return { name: await c.playerName(s.id), user: s.user };
  },

  // ---------------------------------------------------------------- leaderboards
  async lbInit(c, token, game, level) {
    checkGame(game); level = checkLevel(level);
    const s = await c.session(token);
    const name = await c.playerName(s.id);
    return { name, board: await c.board(game, level, s.id, '') };
  },

  async lbBoard(c, token, game, level) {
    checkGame(game);
    let id = '';
    try { id = (await c.session(token)).id; } catch (e) {}
    return c.board(game, checkLevel(level), id, '');
  },

  async lbSetName(c, token, newName) {
    const s = await c.session(token);
    const nm = cleanName(newName);
    if (!nm.ok) throw oops(nm.error);
    await c.playerName(s.id);
    if (await c.nameTaken(nm.value, s.id)) throw oops('Sorry, "' + nm.value + '" is already taken. Try another name.');
    await c.run('UPDATE players SET display_name = ?, updated_at = ? WHERE id = ?', nm.value, Date.now(), s.id);
    return { name: nm.value };
  },

  /** A game starts: count the play, and hand back a one-time ticket for saving its score. */
  async lbStartRun(c, token, game, level) {
    checkGame(game); level = checkLevel(level);
    const s = await c.session(token);
    const runId = crypto.randomUUID(), now = Date.now();
    await c.run('INSERT INTO plays (play_id, player_id, game, difficulty, played_at, day, done) VALUES (?, ?, ?, ?, ?, ?, 0)',
                runId, s.id, game, level, now, denverDay(now));
    return runId;
  },

  /** A game ends: check the score is possible, save it, and return the updated Top 10. */
  async lbSubmitScore(c, token, game, runId, score, outcome) {
    const cfg = checkGame(game);
    const s = await c.session(token);
    const bad = oops('This game could not be verified, so the score was not saved.');
    if (!runId) throw bad;
    const run = await c.first('SELECT player_id, game, difficulty, played_at, done FROM plays WHERE play_id = ?', String(runId));
    if (!run || run.done || run.player_id !== s.id || run.game !== game) throw bad;
    if (Date.now() - run.played_at > 3600000) throw bad;   // tickets last an hour
    const used = await c.run('UPDATE plays SET done = 1 WHERE play_id = ? AND done = 0', String(runId));
    if (!used.meta || used.meta.changes !== 1) throw bad;  // each ticket works once
    const seconds = (Date.now() - run.played_at) / 1000;
    score = Math.round(Number(score));
    const ok = cfg.lowerIsBetter
      ? score >= cfg.minScore && score <= cfg.maxScore && score / 100 <= seconds + 2
      : score >= 0 && score <= cfg.maxScore && seconds >= LB_MIN_SECONDS && score <= Math.ceil(seconds * cfg.maxPerSecond) + 3;
    if (!ok || !isFinite(score)) throw oops('That score looks impossible, so it was not saved.');
    outcome = String(outcome || '').replace(/[^a-z_]/gi, '').slice(0, 20);
    await c.playerName(s.id);
    const scoreId = crypto.randomUUID(), now = Date.now(), level = run.difficulty;
    const better = cfg.lowerIsBetter ? '<' : '>';
    await c.db.batch([
      c.stmt('INSERT INTO scores (score_id, game, difficulty, player_id, score, outcome, duration_s, played_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
             scoreId, game, level, s.id, score, outcome, Math.round(seconds * 10) / 10, now),
      // each player's best score per board, kept up to date so leaderboards stay fast
      c.stmt('INSERT INTO bests (game, difficulty, player_id, score, score_id, played_at) VALUES (?, ?, ?, ?, ?, ?) ' +
             'ON CONFLICT (game, difficulty, player_id) DO UPDATE SET score = excluded.score, score_id = excluded.score_id, played_at = excluded.played_at ' +
             'WHERE excluded.score ' + better + ' bests.score', game, level, s.id, score, scoreId, now)
    ]);
    return { board: await c.board(game, level, s.id, scoreId) };
  },

  // ---------------------------------------------------------------- admin page
  /** Is there an admin password yet? (A brand-new database first needs the import from Apps Script.) */
  async apStatus(c) {
    const pw = await c.setting('admin_pw');
    return { ready: !!pw };
  },

  async apLogin(c, password) {
    const stored = await c.setting('admin_pw');
    if (!stored) throw oops('This arcade hasn\'t been set up yet. Use "First-time setup" below.');
    await c.checkAdminPassword(stored, password);
    return { token: await c.makeAdminToken() };
  },

  async apData(c, token) {
    await c.adminCheck(token);
    const players = await c.all(
      'SELECT p.id, p.username, p.display_name, p.created_at, ' +
      '(SELECT COUNT(*) FROM scores s WHERE s.player_id = p.id) AS scores FROM players p ORDER BY lower(p.display_name)');
    const idx = new Map(), out = [];
    for (const r of players) {
      if (idx.has(r.id)) continue;
      idx.set(r.id, out.length);
      out.push({ key: await c.playerKey(r.id), name: r.display_name || r.username || 'Player', user: r.username || '', old: false,
                 made: r.created_at ? denverDay(r.created_at) : '', scores: r.scores || 0 });
    }
    // one row per player per game per day; the page adds them up any way it likes
    const rows = await c.all('SELECT player_id, game, day, COUNT(*) AS n FROM plays GROUP BY player_id, game, day ORDER BY day LIMIT 100000');
    const plays = [];
    for (const r of rows) {
      let i = idx.get(r.player_id);
      if (i === undefined) {
        i = out.length; idx.set(r.player_id, i);
        out.push({ key: await c.playerKey(r.player_id), name: '(deleted player)', user: '', old: false, made: '', scores: 0, gone: true });
      }
      plays.push([i, r.game, r.day, r.n]);
    }
    const games = GAMES.map(g => ({ id: g.id, title: g.title, emoji: g.emoji || '🎮', color: g.color || '#f0a64a' }));
    return { players: out, plays, games, today: denverDay(Date.now()) };
  },

  async apRename(c, token, key, newName) {
    await c.adminCheck(token);
    const p = await c.findPlayer(key);
    const nm = cleanName(newName);
    if (!nm.ok) throw oops(nm.error);
    if (await c.nameTaken(nm.value, p.id)) throw oops('"' + nm.value + '" is already taken.');
    await c.run('UPDATE players SET display_name = ?, updated_at = ? WHERE id = ?', nm.value, Date.now(), p.id);
    return { ok: true };
  },

  /** Delete a player. With moveToKey their scores + plays go to that player; without, they're erased too. */
  async apDelete(c, token, key, moveToKey) {
    await c.adminCheck(token);
    const p = await c.findPlayer(key), to = moveToKey ? await c.findPlayer(moveToKey) : null;
    if (to && to.id === p.id) throw oops('Pick a different player to move the scores to.');
    const st = [];
    if (to) {
      st.push(c.stmt('UPDATE scores SET player_id = ? WHERE player_id = ?', to.id, p.id));
      st.push(c.stmt('UPDATE plays SET player_id = ? WHERE player_id = ?', to.id, p.id));
      st.push(c.stmt('DELETE FROM bests WHERE player_id IN (?, ?)', p.id, to.id));
      st.push(...bestsRebuild(c, to.id));
    } else {
      st.push(c.stmt('DELETE FROM scores WHERE player_id = ?', p.id));
      st.push(c.stmt('DELETE FROM plays WHERE player_id = ?', p.id));
      st.push(c.stmt('DELETE FROM bests WHERE player_id = ?', p.id));
    }
    st.push(c.stmt('DELETE FROM players WHERE id = ?', p.id));
    await c.db.batch(st);
    return { ok: true };
  },

  /** Erase every player, score and play (type ERASE). Signs everyone out, the admin too. Keeps the admin password. */
  async apEraseAll(c, token, confirm) {
    await c.adminCheck(token);
    if (confirm !== 'ERASE') throw oops('Type ERASE to confirm.');
    await c.db.batch([
      c.stmt('DELETE FROM scores'), c.stmt('DELETE FROM bests'), c.stmt('DELETE FROM plays'), c.stmt('DELETE FROM players'),
      c.stmt('DELETE FROM settings WHERE k = ?', 'auth_secret')
    ]);
    return { ok: true };
  },

  async apChangePassword(c, token, current, next) {
    await c.adminCheck(token);
    next = String(next || '');
    if (next.length < 8) throw oops('The new password needs at least 8 characters.');
    await c.checkAdminPassword(await c.setting('admin_pw'), current);
    await c.saveAdminPassword(next);
    return { ok: true };
  },

  /**
   * First-time setup: bring in the file exported from Apps Script, in chunks (the page sends a few
   * hundred rows per call). Allowed without signing in ONLY while no admin password exists; the
   * password typed on the page must match the admin password inside the export file.
   * After setup, an admin can import again (e.g. scores played on the old site in the meantime);
   * rows already here are skipped.
   */
  async apImport(c, token, part) {
    part = part || {};
    const stored = await c.setting('admin_pw');
    if (stored) await c.adminCheck(token);
    else {
      if (!part.adminHash || !/^[^$]+\$[A-Za-z0-9+/=]+$/.test(part.adminHash)) throw oops('This file has no admin password in it. Export it again with the newest ExportForCloudflare.gs.');
      await c.checkAdminPassword(part.adminHash, part.password);
    }
    const st = [];
    for (const p of (part.players || []).slice(0, 500)) {
      if (!p || !/^u:/.test(p.id) || !p.username) continue;
      st.push(c.stmt('INSERT OR IGNORE INTO players (id, username, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                     p.id, String(p.username).slice(0, 40), String(p.name || p.username).slice(0, 40), Number(p.made) || Date.now(), Date.now()));
    }
    for (const s of (part.scores || []).slice(0, 500)) {
      if (!s || !LB_GAMES[s.game]) continue;
      st.push(c.stmt('INSERT OR IGNORE INTO scores (score_id, game, difficulty, player_id, score, outcome, duration_s, played_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                     String(s.sid), s.game, LB_LEVELS.includes(s.level) ? s.level : 'easy', String(s.pid), Math.round(Number(s.score) || 0),
                     String(s.outcome || '').slice(0, 20), Number(s.secs) || null, Number(s.at) || Date.now()));
    }
    for (const p of (part.plays || []).slice(0, 500)) {
      if (!p) continue;
      const at = Number(p.at) || Date.now();
      st.push(c.stmt('INSERT OR IGNORE INTO plays (play_id, player_id, game, difficulty, played_at, day, done) VALUES (?, ?, ?, ?, ?, ?, 1)',
                     String(p.id), String(p.pid), String(p.game).slice(0, 30), LB_LEVELS.includes(p.level) ? p.level : 'easy', at, denverDay(at)));
    }
    for (let i = 0; i < st.length; i += 100) await c.db.batch(st.slice(i, i + 100));
    if (part.last) {
      // all rows are in: rebuild every best score, then (first time only) save the admin password
      await c.db.batch([c.stmt('DELETE FROM bests'), ...bestsRebuild(c, null)]);
      if (!stored) await c.setSetting('admin_pw', part.adminHash);
      const n = await c.first('SELECT (SELECT COUNT(*) FROM players) AS players, (SELECT COUNT(*) FROM scores) AS scores, (SELECT COUNT(*) FROM plays) AS plays');
      return { done: true, counts: n, token: stored ? null : await c.makeAdminToken() };
    }
    return { done: false };
  }
};

/** Fill the bests table from scores (for one player, or everyone). Earliest of tied scores wins. */
function bestsRebuild(c, playerId) {
  const where = playerId ? ' AND player_id = ?' : '';
  return [true, false].map(lower => {
    const games = Object.keys(LB_GAMES).filter(g => !!LB_GAMES[g].lowerIsBetter === lower);
    if (!games.length) return null;
    const inList = games.map(() => '?').join(',');
    const sql = 'INSERT OR REPLACE INTO bests (game, difficulty, player_id, score, score_id, played_at) ' +
      'SELECT game, difficulty, player_id, score, score_id, played_at FROM (' +
      ' SELECT *, ROW_NUMBER() OVER (PARTITION BY game, difficulty, player_id ORDER BY score ' + (lower ? 'ASC' : 'DESC') + ', played_at ASC) AS rn' +
      ' FROM scores WHERE game IN (' + inList + ')' + where + ') WHERE rn = 1';
    return c.stmt(sql, ...games, ...(playerId ? [playerId] : []));
  }).filter(Boolean);
}

// ============================================================================ per-request helpers

class Ctx {
  constructor(env, request) { this.env = env; this.db = env.DB; this.request = request; }
  stmt(sql, ...args) { return this.db.prepare(sql).bind(...args.map(a => a === undefined ? null : a)); }
  async all(sql, ...args) { return (await this.stmt(sql, ...args).all()).results || []; }
  async first(sql, ...args) { return this.stmt(sql, ...args).first(); }
  async run(sql, ...args) { return this.stmt(sql, ...args).run(); }

  /** Makes the tables the first time (cheap afterwards: remembered for the life of this server copy). */
  async schema() {
    if (SCHEMA_DONE) return;
    await this.db.batch(SCHEMA.map(s => this.db.prepare(s)));
    SCHEMA_DONE = true;
  }

  async setting(k) { const r = await this.first('SELECT v FROM settings WHERE k = ?', k); return r ? r.v : null; }
  async setSetting(k, v) { await this.run('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, v); }

  /** The secret that signs sessions: made once, kept in the database. */
  async secret() {
    if (this._secret) return this._secret;
    let s = await this.setting('auth_secret');
    if (!s) {
      await this.run('INSERT OR IGNORE INTO settings (k, v) VALUES (?, ?)', 'auth_secret', crypto.randomUUID() + crypto.randomUUID());
      s = await this.setting('auth_secret');
    }
    return (this._secret = s);
  }
  async sign(payload) {
    const key = await crypto.subtle.importKey('raw', enc(await this.secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc(payload))));
  }
  async makeToken(id, user) {
    const payload = b64url(enc(JSON.stringify({ p: id, u: user, t: Date.now() })));
    return payload + '.' + await this.sign(payload);
  }
  async session(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !parts[0] || !safeEq(await this.sign(parts[0]), parts[1])) throw authErr();
    let data;
    try { data = JSON.parse(new TextDecoder().decode(unb64url(parts[0]))); } catch (e) { throw authErr(); }
    if (!data || !data.p || !(Date.now() - data.t < AUTH_TOKEN_DAYS * 86400000)) throw authErr();
    return { id: String(data.p), user: String(data.u || '') };
  }
  async playerName(id) {
    const r = await this.first('SELECT display_name FROM players WHERE id = ?', id);
    if (!r) throw authErr('That player no longer exists. Please sign in again.');
    return r.display_name;
  }
  async nameTaken(name, id) {
    const r = await this.first('SELECT COUNT(*) AS n FROM players WHERE id != ? AND (lower(display_name) = lower(?) OR lower(COALESCE(username, \'\')) = lower(?))', id, name, name);
    return r && r.n > 0;
  }

  async board(game, level, id, scoreId) {
    const lower = !!LB_GAMES[game].lowerIsBetter, ord = lower ? 'ASC' : 'DESC', beats = lower ? '<' : '>';
    const [top, me] = await this.db.batch([
      this.stmt('SELECT COALESCE(p.display_name, \'Player\') AS name, b.score, b.played_at, b.player_id = ? AS mine, b.score_id = ? AS latest ' +
                'FROM bests b LEFT JOIN players p ON p.id = b.player_id WHERE b.game = ? AND b.difficulty = ? ' +
                'ORDER BY b.score ' + ord + ', b.played_at ASC LIMIT 10', id || '', scoreId || '', game, level),
      this.stmt('SELECT (SELECT score FROM bests WHERE game = ? AND difficulty = ? AND player_id = ?) AS best, ' +
                '(SELECT COUNT(*) FROM bests WHERE game = ? AND difficulty = ?) AS total', game, level, id || '', game, level)
    ]);
    const m = (me.results || [])[0] || {};
    const board = { level, lowerIsBetter: lower, rows: [], best: null, rank: null, total: m.total || 0 };
    if (m.best !== null && m.best !== undefined) {
      const rk = await this.first('SELECT COUNT(*) AS n FROM bests WHERE game = ? AND difficulty = ? AND score ' + beats + ' ?', game, level, m.best);
      board.best = m.best; board.rank = (rk ? rk.n : 0) + 1;
    }
    for (const r of top.results || []) {
      board.rows.push({ name: r.name, score: r.score, day: niceDay(r.played_at), mine: !!r.mine, latest: !!r.latest });
    }
    return board;
  }

  // ---- admin
  async checkAdminPassword(stored, password) {
    const f = JSON.parse((await this.setting('apfail')) || '{"n":0,"t":0}');
    if (f.n >= AP_MAX_FAILS && Date.now() - f.t < 15 * 60000) throw oops('Too many wrong tries. Wait 15 minutes.');
    const parts = String(stored || '').split('$');
    if (!parts[1] || !safeEq(await pwHash(parts[0], String(password == null ? '' : password)), parts[1])) {
      const n = Date.now() - f.t < 15 * 60000 ? f.n + 1 : 1;
      await this.setSetting('apfail', JSON.stringify({ n, t: Date.now() }));
      throw oops('That isn\'t the admin password.');
    }
    if (f.n) await this.setSetting('apfail', '{"n":0,"t":0}');
  }
  async saveAdminPassword(pw) {
    const salt = crypto.randomUUID();
    await this.setSetting('admin_pw', salt + '$' + await pwHash(salt, pw));
  }
  async makeAdminToken() {
    const payload = b64url(enc(JSON.stringify({ adm: 1, t: Date.now() })));
    return payload + '.' + await this.sign('admin|' + payload);
  }
  async adminCheck(token) {
    const bad = authErr('Please sign in to the admin page again.');
    const parts = String(token || '').split('.');
    if (parts.length !== 2 || !safeEq(await this.sign('admin|' + parts[0]), parts[1])) throw bad;
    let d;
    try { d = JSON.parse(new TextDecoder().decode(unb64url(parts[0]))); } catch (e) { throw bad; }
    if (!d || d.adm !== 1 || !(Date.now() - d.t < AP_TOKEN_HOURS * 3600000)) throw bad;
  }
  /** Players are named to the admin page by an unguessable key, never by their id. */
  async playerKey(id) { return 'p' + (await this.sign('pk|' + id)).replace(/[^A-Za-z0-9]/g, '').slice(0, 22); }
  async findPlayer(key) {
    const rows = await this.all('SELECT id, display_name FROM players');
    for (const r of rows) if (await this.playerKey(r.id) === key) return r;
    throw oops('That player isn\'t there any more. Reload the admin page.');
  }
}

let SCHEMA_DONE = false;
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)',
  'CREATE TABLE IF NOT EXISTS scores (score_id TEXT PRIMARY KEY, game TEXT NOT NULL, difficulty TEXT NOT NULL, player_id TEXT NOT NULL, score INTEGER NOT NULL, outcome TEXT, duration_s REAL, played_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS scores_player ON scores (player_id)',
  'CREATE TABLE IF NOT EXISTS bests (game TEXT NOT NULL, difficulty TEXT NOT NULL, player_id TEXT NOT NULL, score INTEGER NOT NULL, score_id TEXT, played_at INTEGER, PRIMARY KEY (game, difficulty, player_id))',
  'CREATE INDEX IF NOT EXISTS bests_rank ON bests (game, difficulty, score)',
  'CREATE TABLE IF NOT EXISTS plays (play_id TEXT PRIMARY KEY, player_id TEXT NOT NULL, game TEXT NOT NULL, difficulty TEXT, played_at INTEGER NOT NULL, day TEXT NOT NULL, done INTEGER DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS plays_player ON plays (player_id)',
  'CREATE INDEX IF NOT EXISTS plays_day ON plays (day)',
  'CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)'
];

// ============================================================================ small helpers

function checkGame(game) {
  const cfg = LB_GAMES[game];
  if (!cfg) throw oops('Unknown game: ' + game);
  return cfg;
}
function checkLevel(level) {
  if (!LB_LEVELS.includes(level)) throw oops('Unknown difficulty: ' + level);
  return level;
}
function cleanName(raw) {
  const v = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (v.length < 2) return { ok: false, error: 'Names need at least 2 characters.' };
  if (v.length > LB_NAME_MAX) return { ok: false, error: 'Names can be at most ' + LB_NAME_MAX + ' characters.' };
  if (/@/.test(v)) return { ok: false, error: 'Please don\'t use an email address as your name.' };
  if (!/^[A-Za-z0-9À-ÖØ-öø-ÿ .'_\-]+$/.test(v)) return { ok: false, error: 'Use letters, numbers, spaces and . \' - _ only.' };
  if (!/[A-Za-z0-9À-ÖØ-öø-ÿ]/.test(v)) return { ok: false, error: 'Names need at least one letter or number.' };
  return { ok: true, value: v };
}
function cleanUser(raw) {
  const v = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (v.length < 2) throw oops('User names need at least 2 characters.');
  if (v.length > AUTH_USER_MAX) throw oops('User names can be at most ' + AUTH_USER_MAX + ' characters.');
  const chk = cleanName(v);
  if (!chk.ok) throw oops(chk.error.replace(/^Names/, 'User names').replace('as your name', 'as your user name'));
  return chk.value;
}

/** Same scrambling the Apps Script version used, so the admin password carries over. */
async function pwHash(salt, password) {
  let h = salt + '|' + password;
  for (let i = 0; i < 150; i++) {
    h = b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc(h + '|' + salt))));
  }
  return h;
}

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const NICE_FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
function denverDay(ms) { return DAY_FMT.format(new Date(ms)); }            // 'YYYY-MM-DD'
function niceDay(ms) { return ms ? NICE_FMT.format(new Date(ms)) : ''; }   // 'Nov 9, 2026'

function enc(s) { return new TextEncoder().encode(s); }
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function b64url(bytes) { return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '==='.slice((s.length + 3) % 4);
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function safeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
