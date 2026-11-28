const http = require('http');
const { Server } = require('socket.io');

// 호스팅 서비스가 정해 주는 포트를 쓰고, 내 컴퓨터에서는 3000번을 써요
const PORT = process.env.PORT || 3000;

// 주소로 들어오면 서버가 살아 있다는 글자를 보여 줘요
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`히어로 아레나 서버 작동 중 (3:3 매칭 · 친구 요청 · 닉네임 등록 · 랭킹 · 선물 · 길드 · 저장소: ${store.mode === 'mongo' ? 'MongoDB' : '메모리'})`);
});

const io = new Server(httpServer, { cors: { origin: '*' } });

// 방 코드 → { 방장 id, 플레이어 목록 }
const rooms = new Map();

function makeCode() {
  let code;
  do { code = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(code));
  return code;
}

// ---------- 3:3 빠른 매칭 ----------
const MATCH_WAIT = 10000; // 최대 10초 기다림
const MATCH_SIZE = 6;     // 3:3 = 6자리
let pending = null;       // 지금 사람을 모으고 있는 매칭 { code, until, timer }

function startMatch(code) {
  if (!pending || pending.code !== code) return;
  clearTimeout(pending.timer);
  pending = null;
  const room = rooms.get(code);
  if (!room || room.players.size === 0) return;
  // 6자리를 섞어서 들어온 사람들을 무작위 자리에 앉혀요. 남은 자리는 게임이 AI로 채워요.
  const seats = [0, 1, 2, 3, 4, 5].sort(() => Math.random() - 0.5);
  const slots = {}, names = {};
  [...room.players.keys()].forEach((id, i) => { slots[id] = seats[i]; names[id] = room.players.get(id).name; });
  room.host = [...room.players.keys()][0];
  room.started = true;
  io.to(code).emit('matchStart', { host: room.host, slots, names });
}

function leaveRoom(socket) {
  const code = socket.data.room;
  const room = rooms.get(code);
  socket.data.room = null;
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  socket.to(code).emit('playerLeft', { id: socket.id });
  if (room.players.size === 0) {
    rooms.delete(code);
    if (pending && pending.code === code) { clearTimeout(pending.timer); pending = null; }
  } else {
    if (room.host === socket.id) {
      room.host = room.players.keys().next().value;
      io.to(code).emit('hostChanged', { id: room.host });
    }
    if (pending && pending.code === code) io.to(code).emit('matchCount', { n: room.players.size });
  }
}

// ---------- 계정 · 닉네임 · 친구 ----------
// MONGODB_URI 환경 변수가 있으면 MongoDB에 영구 저장하고,
// 없으면 서버 메모리에만 저장해요(서버가 잠들면 초기화돼요).
const crypto = require('crypto');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(13), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const codeOk = (u) => typeof u === 'string' && /^[A-Z0-9]{13}$/.test(u);
const cleanName = (n) => String(n || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 10);
const nameKey = (n) => cleanName(n).normalize('NFC').toLowerCase().replace(/\s+/g, '');

const store = {
  mode: 'memory',
  mem: { users: new Map(), byName: new Map(), reqs: new Map(), runs: new Map(), gifts: new Map() }, // reqs: 받는 사람 → Set(보낸 사람), runs: 기록 키 → 기록
  db: null,
  async init() {
    const uri = process.env.MONGODB_URI;
    if (!uri) { console.log('저장소: 메모리 (서버가 잠들면 닉네임·친구 기록이 초기화돼요)'); return; }
    try {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(uri);
      await client.connect();
      const d = client.db('heroarena');
      this.db = { users: d.collection('users'), reqs: d.collection('requests'), runs: d.collection('runs'), gifts: d.collection('gifts') };
      await this.db.gifts.createIndex({ to: 1 });
      await this.db.users.createIndex({ uid: 1 }, { unique: true });
      await this.db.users.createIndex({ nameKey: 1 }, { unique: true });
      await this.db.reqs.createIndex({ from: 1, to: 1 }, { unique: true });
      await this.db.runs.createIndex({ key: 1 }, { unique: true });
      await this.db.runs.createIndex({ mode: 1, ms: 1 });
      await G.load(d);
      this.mode = 'mongo';
      console.log('저장소: MongoDB 연결됨 (닉네임·친구가 영구 저장돼요)');
    } catch (e) {
      console.log('MongoDB 연결 실패, 메모리로 실행해요:', e.message);
      this.db = null;
    }
  },
  async getUser(uid) {
    if (this.db) return this.db.users.findOne({ uid });
    return this.mem.users.get(uid) || null;
  },
  async getByName(key) {
    if (this.db) return this.db.users.findOne({ nameKey: key });
    const uid = this.mem.byName.get(key);
    return uid ? this.mem.users.get(uid) : null;
  },
  async createUser(u) {
    if (this.db) { await this.db.users.insertOne(u); return; }
    this.mem.users.set(u.uid, u);
    this.mem.byName.set(u.nameKey, u.uid);
  },
  async setName(uid, name, key) {
    if (this.db) { await this.db.users.updateOne({ uid }, { $set: { name, nameKey: key } }); return; }
    const u = this.mem.users.get(uid);
    if (!u) return;
    this.mem.byName.delete(u.nameKey);
    u.name = name; u.nameKey = key;
    this.mem.byName.set(key, uid);
  },
  async addFriend(a, b) {
    if (this.db) {
      await this.db.users.updateOne({ uid: a }, { $addToSet: { friends: b } });
      await this.db.users.updateOne({ uid: b }, { $addToSet: { friends: a } });
      return;
    }
    for (const [x, y] of [[a, b], [b, a]]) {
      const u = this.mem.users.get(x);
      if (u && !u.friends.includes(y)) u.friends.push(y);
    }
  },
  async removeFriend(a, b) {
    if (this.db) {
      await this.db.users.updateOne({ uid: a }, { $pull: { friends: b } });
      await this.db.users.updateOne({ uid: b }, { $pull: { friends: a } });
      return;
    }
    for (const [x, y] of [[a, b], [b, a]]) {
      const u = this.mem.users.get(x);
      if (u) u.friends = u.friends.filter((f) => f !== y);
    }
  },
  async addReq(from, to) {
    if (this.db) { await this.db.reqs.updateOne({ from, to }, { $set: { from, to, at: new Date() } }, { upsert: true }); return; }
    if (!this.mem.reqs.has(to)) this.mem.reqs.set(to, new Set());
    this.mem.reqs.get(to).add(from);
  },
  async hasReq(from, to) {
    if (this.db) return !!(await this.db.reqs.findOne({ from, to }));
    return !!(this.mem.reqs.get(to) && this.mem.reqs.get(to).has(from));
  },
  async delReq(from, to) {
    if (this.db) { await this.db.reqs.deleteOne({ from, to }); return; }
    if (this.mem.reqs.get(to)) this.mem.reqs.get(to).delete(from);
  },
  // 랭킹: 한 사람(둘이서는 한 팀)당 가장 빠른 기록 하나만 남겨요
  async getRun(key) {
    if (this.db) return this.db.runs.findOne({ key });
    return this.mem.runs.get(key) || null;
  },
  async putRun(r) {
    if (this.db) { await this.db.runs.updateOne({ key: r.key }, { $set: r }, { upsert: true }); return; }
    this.mem.runs.set(r.key, r);
  },
  async topRuns(mode, n) {
    if (this.db) return this.db.runs.find({ mode }).sort({ ms: 1 }).limit(n).toArray();
    return [...this.mem.runs.values()].filter((r) => r.mode === mode).sort((a, b) => a.ms - b.ms).slice(0, n);
  },
  async rankOf(mode, ms) {
    if (this.db) return (await this.db.runs.countDocuments({ mode, ms: { $lt: ms } })) + 1;
    return [...this.mem.runs.values()].filter((r) => r.mode === mode && r.ms < ms).length + 1;
  },
  // 선물: 받는 사람이 접속하면 전달하고, 받았다고 하면 지워요
  async addGift(g) {
    if (this.db) { await this.db.gifts.insertOne(g); return; }
    if (!this.mem.gifts.has(g.to)) this.mem.gifts.set(g.to, []);
    const a = this.mem.gifts.get(g.to); a.push(g); if (a.length > 100) a.shift();
  },
  async giftsTo(to) {
    if (this.db) return (await this.db.gifts.find({ to }).limit(50).toArray()).map(({ _id, ...g }) => g);
    return (this.mem.gifts.get(to) || []).slice(0, 50);
  },
  async delGifts(to, ids) {
    if (this.db) { await this.db.gifts.deleteMany({ to, id: { $in: ids } }); return; }
    const a = this.mem.gifts.get(to); if (a) this.mem.gifts.set(to, a.filter((g) => !ids.includes(g.id)));
  },
  async setSave(uid, data) {
    if (this.db) { await this.db.users.updateOne({ uid }, { $set: { save: data, saveAt: Date.now() } }); return; }
    const u = this.mem.users.get(uid); if (u) { u.save = data; u.saveAt = Date.now(); }
  },
  async addAlt(uid, h) {
    if (this.db) { await this.db.users.updateOne({ uid }, { $addToSet: { alt: h } }); return; }
    const u = this.mem.users.get(uid); if (u) { u.alt = u.alt || []; if (!u.alt.includes(h)) u.alt.push(h); }
  },
  async reqsTo(to) {
    if (this.db) return (await this.db.reqs.find({ to }).toArray()).map((r) => r.from);
    return [...(this.mem.reqs.get(to) || [])];
  },
};

const online = new Map(); // 친구 코드 → socket id (지금 접속한 사람)
async function brief(uid) {
  const u = await store.getUser(uid);
  return u ? { uid, name: u.name, online: online.has(uid) } : null;
}
async function friendList(u) {
  const out = [];
  for (const f of u.friends || []) { const b = await brief(f); if (b) out.push(b); }
  return out;
}
async function tellFriends(u, on) {
  for (const f of u.friends || []) {
    const sid = online.get(f);
    if (sid) io.to(sid).emit('presence', { uid: u.uid, on, name: u.name });
  }
}
async function rankList(mode, uid) {
  return (await store.topRuns(mode, 20)).map((r) => ({ names: r.names, ms: r.ms, heroes: r.heroes, at: r.at, mine: !!uid && r.uid === uid }));
}
// 이벤트 처리 중 오류가 나도 서버가 멈추지 않게 감싸요
const safe = (fn) => async (data, reply) => {
  const r = typeof reply === 'function' ? reply : () => {};
  try { await fn(data || {}, r); } catch (e) { console.log('오류:', e.message); r({ ok: false, error: 'server' }); }
};

// ───────── 길드 ─────────
// 길드는 서버 메모리에 모두 올려 두고(빠른 실시간 성벽용), 바뀔 때마다 몽고에도 저장해요
const DAY = 86400000;
const G = {
  map: new Map(),      // gid → 길드
  byUser: new Map(),   // 친구 코드 → gid
  col: null,           // 몽고 길드 저장소
  timers: new Map(),
  async load(db) {
    if (!db) return;
    this.col = db.collection('guilds');
    await this.col.createIndex({ gid: 1 }, { unique: true });
    for (const g of await this.col.find({}).toArray()) { delete g._id; this.map.set(g.gid, g); }
    for (const g of this.map.values()) for (const m of g.members) this.byUser.set(m, g.gid);
    console.log(`길드 ${this.map.size}개 불러옴`);
  },
  save(g, now) {
    if (!this.col) return;
    clearTimeout(this.timers.get(g.gid));
    const run = () => { this.timers.delete(g.gid); this.col.replaceOne({ gid: g.gid }, g, { upsert: true }).catch((e) => console.log('길드 저장 실패', e.message)); };
    if (now) run(); else this.timers.set(g.gid, setTimeout(run, 2000));
  },
  remove(g) {
    clearTimeout(this.timers.get(g.gid)); this.timers.delete(g.gid);
    this.map.delete(g.gid);
    if (this.col) this.col.deleteOne({ gid: g.gid }).catch(() => {});
  },
  of(uid) { const id = this.byUser.get(uid); return id ? this.map.get(id) : null; },
};
const WAR_COST = 300;            // 전쟁 선포 비용 (길드 창고 다이아)
const SHIELD = 3 * DAY;          // 새 길드 보호막
const WAR_LEN = DAY;             // 전쟁 시간
const CREATE_COST = 100;         // 길드 만들기 비용 (게임에서 차감)
const weekId = () => Math.floor((Date.now() + 9 * 3600000 - 4 * DAY) / (7 * DAY));
const dayId = () => Math.floor((Date.now() + 9 * 3600000) / DAY);
const gLevel = (g) => Math.min(50, 1 + Math.floor(Math.sqrt((g.xp || 0) / 100)));
const gCap = (g) => 10 + (g.castles || 0) * 10;
const wallMax = (g) => 150000 + 60000 * g.members.length;
const bossMax = (g) => 40000 + 60000 * g.members.length;
const wkGoal = (g) => 40 + 25 * g.members.length;
const gScore = (g) => (g.xp || 0) + (g.castles || 0) * 3000 + (g.bossKills || 0) * 1500 + g.members.length * 200;
const cleanGName = (n) => String(n || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
const EMBS = ['🐉', '🦁', '🦅', '🐺', '🦊', '🐻', '🐙', '🦄', '🔥', '⚡', '🌙', '⭐', '❄️', '🌸', '🍎', '👑', '🛡️', '⚔️', '💀', '🎃'];
const COLS = ['#ff5a5a', '#ffb13b', '#ffe14d', '#5ad46a', '#4fc3ff', '#6a7bff', '#c46aff', '#ff7ad9', '#eeeeee', '#555b66'];

function gFresh(g) {
  // 주간 목표·보스가 새 주로 바뀌었으면 새로 시작해요
  const w = weekId();
  if (!g.wk || g.wk.id !== w) g.wk = { id: w, prog: 0, claimed: [] };
  if (!g.boss || g.boss.id !== w) g.boss = { id: w, max: bossMax(g), hp: bossMax(g), dmg: {}, tries: {}, claimed: [], killed: false };
}
function shielded(g) { return !g.warDone && Date.now() < (g.created || 0) + SHIELD && !g.broke; }
function gTell(g, ev, data) {
  if (!g) return;
  for (const m of g.members) { const sid = online.get(m); if (sid) io.to(sid).emit(ev, data); }
}
function gBrief(g) {
  return { gid: g.gid, name: g.name, emb: g.emb, col: g.col, lv: gLevel(g), n: g.members.length, cap: gCap(g),
    castles: g.castles || 0, shield: shielded(g) ? (g.created + SHIELD) : 0, war: g.war ? g.war.vs : null, score: gScore(g) };
}
async function gView(g, uid) {
  gFresh(g);
  const members = [];
  for (const m of g.members) {
    const u = await store.getUser(m);
    members.push({ uid: m, name: u ? u.name : '???', online: online.has(m), leader: m === g.leader, hero: (g.hero || {})[m] || null, dmg: g.boss.dmg[m] || 0 });
  }
  const t = g.boss.tries[uid];
  let war = null;
  if (g.war) {
    const e = G.map.get(g.war.vs);
    if (e && e.war) war = { wid: g.war.wid, vs: gBrief(e), end: g.war.end, my: { hp: g.war.hp, max: g.war.max }, en: { hp: e.war.hp, max: e.war.max }, me: (g.war.dmg || {})[uid] || 0 };
  }
  return { ...gBrief(g), leader: g.leader, me: uid, members, bank: g.bank || 0, xp: g.xp || 0, bossKills: g.bossKills || 0,
    chat: (g.chat || []).slice(-40), log: (g.log || []).slice(-15),
    wk: { prog: g.wk.prog, goal: wkGoal(g), claimed: g.wk.claimed.includes(uid) },
    boss: { hp: g.boss.hp, max: g.boss.max, killed: g.boss.killed, claimed: g.boss.claimed.includes(uid), tries: t && t.day === dayId() ? t.n : 0, maxTries: 3, week: g.boss.id },
    war, warCost: WAR_COST, created: g.created };
}
function gLog(g, t) { g.log = g.log || []; g.log.push({ t, at: Date.now() }); if (g.log.length > 30) g.log.shift(); }
function gAdd(g, uid) {
  if (!g.members.includes(uid)) { g.members.push(uid); if (g.boss && !g.boss.killed) { g.boss.max += 60000; g.boss.hp += 60000; } }
  G.byUser.set(uid, g.gid);
}
function gDrop(g, uid) {
  g.members = g.members.filter((m) => m !== uid);
  if (G.byUser.get(uid) === g.gid) G.byUser.delete(uid);
  if (g.hero) delete g.hero[uid];
  if (!g.members.length) {
    // 아무도 없으면 길드가 사라져요. 전쟁 중이면 상대는 그냥 전쟁이 끝나요
    if (g.war) { const e = G.map.get(g.war.vs); if (e) { e.war = null; gLog(e, `${g.name} 길드가 사라져서 전쟁이 끝났어요`); gTell(e, 'gUpd', {}); G.save(e); } }
    G.remove(g); return;
  }
  if (g.leader === uid) g.leader = g.members[0];
  G.save(g);
}
// 전쟁 결과: 진 길드는 사라지고 길드원은 전부 이긴 길드로 들어가요
function warResolve(win, lose, why) {
  const wn = win.name, ln = lose.name, moved = [...lose.members];
  const loseIds = [...lose.members];
  for (const m of moved) gAdd(win, m);
  win.bank = (win.bank || 0) + (lose.bank || 0);
  win.xp = (win.xp || 0) + Math.floor((lose.xp || 0) / 2);
  win.castles = (win.castles || 0) + 1 + (lose.castles || 0);
  win.bossKills = (win.bossKills || 0) + (lose.bossKills || 0);
  win.hero = { ...(lose.hero || {}), ...(win.hero || {}) };
  win.war = null; win.warDone = true;
  gLog(win, `⚔️ ${ln} 길드의 성을 정복했어요! 길드원 ${moved.length}명이 합류했어요 (${why})`);
  G.remove(lose);
  G.save(win, true);
  const data = { win: wn, lose: ln, gid: win.gid, why };
  for (const m of win.members) {
    const sid = online.get(m);
    if (sid) io.to(sid).emit('gWarEnd', { ...data, won: !loseIds.includes(m) });
  }
}
function warDraw(a, b) {
  a.war = null; b.war = null; a.warDone = b.warDone = true;
  gLog(a, `⚔️ ${b.name} 길드와의 전쟁이 무승부로 끝났어요`); gLog(b, `⚔️ ${a.name} 길드와의 전쟁이 무승부로 끝났어요`);
  G.save(a, true); G.save(b, true);
  gTell(a, 'gWarEnd', { draw: true, vs: b.name }); gTell(b, 'gWarEnd', { draw: true, vs: a.name });
}
// 시간이 다 되면 성벽이 더 많이 깎인 쪽이 져요
setInterval(() => {
  const now = Date.now(), seen = new Set();
  for (const g of [...G.map.values()]) {
    if (!g.war || seen.has(g.gid) || now < g.war.end) continue;
    const e = G.map.get(g.war.vs); seen.add(g.gid);
    if (!e || !e.war) { g.war = null; G.save(g); continue; }
    seen.add(e.gid);
    const pa = g.war.hp / g.war.max, pb = e.war.hp / e.war.max;
    if (Math.abs(pa - pb) < 1e-9) warDraw(g, e);
    else if (pa > pb) warResolve(g, e, '시간 종료 · 성벽이 더 튼튼했어요');
    else warResolve(e, g, '시간 종료 · 성벽이 더 튼튼했어요');
  }
}, 15000);

function registerGuild(socket, me) {
  const who = async () => { const uid = me(); return uid ? await store.getUser(uid) : null; };
  const mine = () => G.of(me());

  socket.on('gGet', safe(async (d, reply) => {
    const u = await who(); if (!u) return reply({ ok: false, error: 'auth' });
    const g = mine();
    reply({ ok: true, g: g ? await gView(g, u.uid) : null, embs: EMBS, cols: COLS, createCost: CREATE_COST });
  }));
  socket.on('gList', safe(async ({ q }, reply) => {
    const u = await who(); if (!u) return reply({ ok: false, error: 'auth' });
    const k = cleanGName(q).toLowerCase();
    let list = [...G.map.values()];
    if (k) list = list.filter((g) => g.name.toLowerCase().includes(k));
    list.sort((a, b) => gScore(b) - gScore(a));
    reply({ ok: true, list: list.slice(0, 40).map(gBrief) });
  }));
  socket.on('gRank', safe(async (d, reply) => {
    const list = [...G.map.values()].sort((a, b) => gScore(b) - gScore(a)).slice(0, 20).map(gBrief);
    reply({ ok: true, list, mine: G.byUser.get(me()) || null });
  }));
  socket.on('gCreate', safe(async ({ name, emb, col }, reply) => {
    const u = await who(); if (!u) return reply({ ok: false, error: 'auth' });
    if (mine()) return reply({ ok: false, error: 'already' });
    const n = cleanGName(name);
    if (n.length < 2) return reply({ ok: false, error: 'short' });
    const key = n.toLowerCase().replace(/\s+/g, '');
    for (const g of G.map.values()) if (g.name.toLowerCase().replace(/\s+/g, '') === key) return reply({ ok: false, error: 'taken' });
    const g = { gid: crypto.randomBytes(6).toString('hex'), name: n, emb: EMBS.includes(emb) ? emb : EMBS[0], col: COLS.includes(col) ? col : COLS[0],
      leader: u.uid, members: [], created: Date.now(), xp: 0, bank: 0, castles: 0, bossKills: 0, chat: [], log: [], hero: {}, war: null };
    gFresh(g); gAdd(g, u.uid); gLog(g, `🏰 ${u.name}님이 길드를 만들었어요`);
    G.map.set(g.gid, g); G.save(g, true);
    reply({ ok: true, g: await gView(g, u.uid) });
  }));
  socket.on('gJoin', safe(async ({ gid }, reply) => {
    const u = await who(); if (!u) return reply({ ok: false, error: 'auth' });
    if (mine()) return reply({ ok: false, error: 'already' });
    const g = G.map.get(gid); if (!g) return reply({ ok: false, error: 'none' });
    if (g.members.length >= gCap(g)) return reply({ ok: false, error: 'full' });
    gAdd(g, u.uid); gLog(g, `👋 ${u.name}님이 들어왔어요`); G.save(g);
    gTell(g, 'gUpd', {});
    reply({ ok: true, g: await gView(g, u.uid) });
  }));
  socket.on('gLeave', safe(async (d, reply) => {
    const u = await who(); const g = mine(); if (!u || !g) return reply({ ok: false });
    gLog(g, `🚪 ${u.name}님이 나갔어요`); gDrop(g, u.uid);
    if (G.map.has(g.gid)) gTell(g, 'gUpd', {});
    reply({ ok: true });
  }));
  socket.on('gKick', safe(async ({ uid }, reply) => {
    const u = await who(); const g = mine(); if (!u || !g || g.leader !== u.uid || uid === u.uid || !g.members.includes(uid)) return reply({ ok: false });
    const t = await store.getUser(uid);
    gLog(g, `👢 ${t ? t.name : '?'}님이 내보내졌어요`); gDrop(g, uid);
    const sid = online.get(uid); if (sid) io.to(sid).emit('gKicked', { name: g.name });
    gTell(g, 'gUpd', {}); reply({ ok: true });
  }));
  socket.on('gLeader', safe(async ({ uid }, reply) => {
    const u = await who(); const g = mine(); if (!u || !g || g.leader !== u.uid || !g.members.includes(uid)) return reply({ ok: false });
    g.leader = uid; const t = await store.getUser(uid); gLog(g, `👑 ${t ? t.name : '?'}님이 새 길드장이 됐어요`); G.save(g);
    gTell(g, 'gUpd', {}); reply({ ok: true });
  }));
  socket.on('gEdit', safe(async ({ emb, col }, reply) => {
    const u = await who(); const g = mine(); if (!u || !g || g.leader !== u.uid) return reply({ ok: false });
    if (EMBS.includes(emb)) g.emb = emb; if (COLS.includes(col)) g.col = col; G.save(g);
    gTell(g, 'gUpd', {}); reply({ ok: true });
  }));
  socket.on('gChat', safe(async ({ t }, reply) => {
    const u = await who(); const g = mine(); if (!u || !g) return reply({ ok: false });
    const txt = String(t || '').replace(/[<>]/g, '').slice(0, 120).trim(); if (!txt) return reply({ ok: false });
    const m = { uid: u.uid, n: u.name, t: txt, at: Date.now() };
    g.chat = g.chat || []; g.chat.push(m); if (g.chat.length > 60) g.chat.shift(); G.save(g);
    gTell(g, 'gChat', m); reply({ ok: true });
  }));
  socket.on('gHero', safe(async ({ hero }) => {
    const g = mine(); if (!g || typeof hero !== 'string' || !/^[a-z0-9_]{1,24}$/.test(hero)) return;
    g.hero = g.hero || {}; if (g.hero[me()] !== hero) { g.hero[me()] = hero; G.save(g); }
  }));
  socket.on('gProg', safe(async ({ n }, reply) => {
    const g = mine(); if (!g) return reply({ ok: false });
    gFresh(g); const k = Math.max(0, Math.min(30, Math.floor(Number(n) || 0)));
    const before = g.wk.prog; g.wk.prog += k; G.save(g);
    if (before < wkGoal(g) && g.wk.prog >= wkGoal(g)) { gLog(g, '🎯 이번 주 길드 목표 달성!'); gTell(g, 'gUpd', { goal: true }); }
    reply({ ok: true, prog: g.wk.prog, goal: wkGoal(g) });
  }));
  socket.on('gDonate', safe(async ({ d }, reply) => {
    const u = await who(); const g = mine(); if (!u || !g) return reply({ ok: false });
    const n = Math.floor(Number(d)); if (!(n >= 1 && n <= 100000)) return reply({ ok: false, error: 'bad' });
    const lv0 = gLevel(g); g.bank = (g.bank || 0) + n; g.xp = (g.xp || 0) + n;
    gLog(g, `💎 ${u.name}님이 ${n}개를 기부했어요`);
    if (gLevel(g) > lv0) gLog(g, `⬆️ 길드 레벨 ${gLevel(g)} 달성!`);
    G.save(g); gTell(g, 'gUpd', {}); reply({ ok: true });
  }));
  socket.on('gClaim', safe(async ({ kind }, reply) => {
    const u = await who(); const g = mine(); if (!u || !g) return reply({ ok: false });
    gFresh(g);
    if (kind === 'wk') {
      if (g.wk.prog < wkGoal(g) || g.wk.claimed.includes(u.uid)) return reply({ ok: false });
      g.wk.claimed.push(u.uid); G.save(g); return reply({ ok: true, d: 50 });
    }
    if (kind === 'boss') {
      if (!g.boss.killed || g.boss.claimed.includes(u.uid)) return reply({ ok: false });
      g.boss.claimed.push(u.uid); G.save(g); return reply({ ok: true, d: 80, week: g.boss.id });
    }
    reply({ ok: false });
  }));
  // 길드 보스: 하루 3번 도전, 데미지는 실시간으로 길드 전체에 보여요
  socket.on('gBossStart', safe(async (d, reply) => {
    const g = mine(); if (!g) return reply({ ok: false, error: 'guild' });
    gFresh(g);
    if (g.boss.killed) return reply({ ok: false, error: 'killed' });
    const t = g.boss.tries[me()]; const day = dayId();
    const n = t && t.day === day ? t.n : 0;
    if (n >= 3) return reply({ ok: false, error: 'tries' });
    g.boss.tries[me()] = { day, n: n + 1 }; G.save(g);
    socket.data.gfight = { k: 'boss', at: Date.now(), sum: 0 };
    reply({ ok: true, hp: g.boss.hp, max: g.boss.max, week: g.boss.id, tries: n + 1 });
  }));
  // 성 공격: 상대 길드 성으로 들어가요 (수비대 = 상대 길드원 영웅)
  socket.on('gSiege', safe(async (d, reply) => {
    const g = mine(); if (!g || !g.war) return reply({ ok: false, error: 'nowar' });
    const e = G.map.get(g.war.vs); if (!e || !e.war) return reply({ ok: false, error: 'nowar' });
    const def = [];
    for (const m of e.members) { const u = await store.getUser(m); def.push({ name: u ? u.name : '?', hero: (e.hero || {})[m] || null }); }
    socket.data.gfight = { k: 'war', at: Date.now(), sum: 0, wid: g.war.wid };
    reply({ ok: true, vs: gBrief(e), wall: { hp: e.war.hp, max: e.war.max }, my: { hp: g.war.hp, max: g.war.max }, def, end: g.war.end });
  }));
  // 데미지 보내기 (1초에 한 번쯤). 너무 큰 값은 잘라요
  socket.on('gHit', safe(async ({ dmg }, reply) => {
    const f = socket.data.gfight, g = mine(); if (!f || !g) return reply({ ok: false });
    const now = Date.now();
    const lim = Math.max(0, (now - f.at) / 1000 * 4000 + 6000 - f.sum);   // 초당 최대 4000
    const n = Math.max(0, Math.min(Math.floor(Number(dmg) || 0), lim, 20000));
    f.sum += n;
    if (f.k === 'boss') {
      gFresh(g); if (g.boss.killed) return reply({ ok: true, hp: 0, max: g.boss.max, killed: true });
      g.boss.hp = Math.max(0, g.boss.hp - n); g.boss.dmg[me()] = (g.boss.dmg[me()] || 0) + n;
      if (g.boss.hp <= 0) {
        g.boss.killed = true; g.bossKills = (g.bossKills || 0) + 1;
        const u = await store.getUser(me()); gLog(g, `🐉 길드 보스 처치! 마지막 한 방: ${u ? u.name : '?'}`);
        G.save(g, true); gTell(g, 'gBoss', { hp: 0, max: g.boss.max, killed: true }); gTell(g, 'gUpd', {});
      } else { G.save(g); gTell(g, 'gBoss', { hp: g.boss.hp, max: g.boss.max }); }
      return reply({ ok: true, hp: g.boss.hp, max: g.boss.max, killed: g.boss.killed });
    }
    if (f.k === 'war') {
      if (!g.war || g.war.wid !== f.wid) return reply({ ok: false, error: 'over' });
      const e = G.map.get(g.war.vs); if (!e || !e.war) return reply({ ok: false, error: 'over' });
      e.war.hp = Math.max(0, e.war.hp - n);
      g.war.dmg = g.war.dmg || {}; g.war.dmg[me()] = (g.war.dmg[me()] || 0) + n;
      const w = { wid: g.war.wid, hp: { [g.gid]: g.war.hp, [e.gid]: e.war.hp }, max: { [g.gid]: g.war.max, [e.gid]: e.war.max } };
      gTell(g, 'gWall', w); gTell(e, 'gWall', w);
      if (e.war.hp <= 0) { warResolve(g, e, '성벽 함락'); return reply({ ok: true, hp: 0, won: true }); }
      G.save(g); G.save(e);
      return reply({ ok: true, hp: e.war.hp, max: e.war.max });
    }
    reply({ ok: false });
  }));
  socket.on('gFightEnd', () => { socket.data.gfight = null; });
  // 전쟁 선포: 길드장만, 창고 다이아 300개, 보호막 있는 길드에는 못 걸어요
  socket.on('gWar', safe(async ({ vs }, reply) => {
    const u = await who(); const g = mine(); if (!u || !g) return reply({ ok: false, error: 'guild' });
    if (g.leader !== u.uid) return reply({ ok: false, error: 'leader' });
    if (g.war) return reply({ ok: false, error: 'busy' });
    const e = G.map.get(vs); if (!e || e.gid === g.gid) return reply({ ok: false, error: 'none' });
    if (e.war) return reply({ ok: false, error: 'enbusy' });
    if (shielded(e)) return reply({ ok: false, error: 'shield', until: e.created + SHIELD });
    if ((g.bank || 0) < WAR_COST) return reply({ ok: false, error: 'cost' });
    g.bank -= WAR_COST; g.broke = true;   // 전쟁을 걸면 내 보호막도 사라져요
    const wid = crypto.randomBytes(6).toString('hex'), now = Date.now(), end = now + WAR_LEN;
    g.war = { wid, vs: e.gid, start: now, end, hp: wallMax(g), max: wallMax(g), dmg: {}, atk: true };
    e.war = { wid, vs: g.gid, start: now, end, hp: wallMax(e), max: wallMax(e), dmg: {}, atk: false };
    gLog(g, `⚔️ ${e.name} 길드에 전쟁을 선포했어요! (24시간)`); gLog(e, `⚔️ ${g.name} 길드가 전쟁을 선포했어요! 성을 지키고 반격하세요! (24시간)`);
    G.save(g, true); G.save(e, true);
    gTell(g, 'gWarStart', { vs: g.name === e.name ? '' : e.name, atk: true }); gTell(e, 'gWarStart', { vs: g.name, atk: false });
    reply({ ok: true });
  }));
}

// 기기 옮기기 코드 (10분 동안만 쓸 수 있어요)
const xfer = new Map();
const XC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
io.on('connection', (socket) => {
  const me = () => socket.data.uid;
  registerGuild(socket, me);

  // 클라우드 백업: 다이아·전리품·스토리 같은 기기 데이터를 서버에 저장해요
  socket.on('saveUp', safe(async ({ data }, reply) => {
    const uid = me(); if (!uid) return reply({ ok: false, error: 'auth' });
    if (typeof data !== 'string' || data.length > 400000) return reply({ ok: false, error: 'big' });
    await store.setSave(uid, data); reply({ ok: true, at: Date.now() });
  }));
  socket.on('saveGet', safe(async (d, reply) => {
    const uid = me(); if (!uid) return reply({ ok: false, error: 'auth' });
    const u = await store.getUser(uid); reply({ ok: true, save: (u && u.save) || null, at: (u && u.saveAt) || 0 });
  }));
  // 기기 옮기기: 예전 기기에서 코드를 만들고, 새 기기에서 입력해요
  socket.on('xferMake', safe(async (d, reply) => {
    const uid = me(); if (!uid) return reply({ ok: false, error: 'auth' });
    for (const [k, v] of xfer) if (v.uid === uid || v.exp < Date.now()) xfer.delete(k);
    let code; do { code = Array.from(crypto.randomBytes(8), (b) => XC[b % XC.length]).join(''); } while (xfer.has(code));
    const exp = Date.now() + 10 * 60000; xfer.set(code, { uid, exp, tries: 0 });
    reply({ ok: true, code: code.slice(0, 4) + '-' + code.slice(4), exp });
  }));
  socket.on('xferUse', safe(async ({ code }, reply) => {
    socket.data.xtry = (socket.data.xtry || 0) + 1;
    if (socket.data.xtry > 10) return reply({ ok: false, error: 'many' });
    const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const x = xfer.get(c);
    if (!x || x.exp < Date.now()) { if (x) xfer.delete(c); return reply({ ok: false, error: 'code' }); }
    xfer.delete(c);
    const u = await store.getUser(x.uid); if (!u) return reply({ ok: false, error: 'code' });
    const secret = crypto.randomBytes(18).toString('base64url');
    await store.addAlt(u.uid, hash(secret));
    reply({ ok: true, uid: u.uid, secret, name: u.name, save: u.save || null });
  }));

  // 닉네임 등록: 겹치는 닉네임이 없으면 13자리 코드와 비밀 열쇠를 만들어 줘요
  socket.on('register', safe(async ({ name }, reply) => {
    const n = cleanName(name), key = nameKey(n);
    if (!n) return reply({ ok: false, error: 'bad' });
    if (await store.getByName(key)) return reply({ ok: false, error: 'taken' });
    let uid;
    do { uid = newCode(); } while (await store.getUser(uid));
    const secret = crypto.randomBytes(18).toString('base64url');
    try { await store.createUser({ uid, secret: hash(secret), name: n, nameKey: key, friends: [], created: new Date() }); }
    catch (e) { return reply({ ok: false, error: 'taken' }); }
    reply({ ok: true, uid, secret, name: n });
  }));

  // 로그인: 내 코드와 비밀 열쇠로 확인하고, 친구 목록과 받은 요청을 돌려줘요
  socket.on('auth', safe(async ({ uid, secret, name, cache }, reply) => {
    if (!codeOk(uid) || typeof secret !== 'string') return reply({ ok: false, error: 'bad' });
    let u = await store.getUser(uid);
    if (!u) {
      // 메모리 저장소가 초기화된 경우: 이 기기에 남아 있던 정보로 계정을 되살려요
      if (store.mode === 'mongo') return reply({ ok: false, error: 'unknown' });
      const n = cleanName(name), key = nameKey(n);
      if (!n) return reply({ ok: false, error: 'unknown' });
      if (await store.getByName(key)) return reply({ ok: false, error: 'taken' });
      const friends = (Array.isArray(cache) ? cache : []).filter(codeOk).slice(0, 200);
      u = { uid, secret: hash(secret), name: n, nameKey: key, friends, created: new Date() };
      await store.createUser(u);
    } else if (u.secret !== hash(secret) && !(u.alt || []).includes(hash(secret))) {
      return reply({ ok: false, error: 'secret' });
    }
    const old = online.get(uid);
    if (old && old !== socket.id) io.to(old).emit('kicked', {});
    socket.data.uid = uid;
    online.set(uid, socket.id);
    await tellFriends(u, true);
    const reqs = [];
    for (const f of await store.reqsTo(uid)) { const b = await brief(f); if (b) reqs.push(b); }
    reply({ ok: true, uid, name: u.name, friends: await friendList(u), reqs, mode: store.mode, gifts: await store.giftsTo(uid), guild: G.of(uid) ? gBrief(G.of(uid)) : null });
  }));

  // 닉네임 바꾸기 (겹치면 안 돼요)
  socket.on('rename', safe(async ({ name }, reply) => {
    const u = me() && await store.getUser(me());
    if (!u) return reply({ ok: false, error: 'auth' });
    const n = cleanName(name), key = nameKey(n);
    if (!n) return reply({ ok: false, error: 'bad' });
    const other = await store.getByName(key);
    if (other && other.uid !== u.uid) return reply({ ok: false, error: 'taken' });
    await store.setName(u.uid, n, key);
    u.name = n;
    await tellFriends(u, true);
    reply({ ok: true, name: n });
  }));

  // 닉네임으로 사람 찾기
  socket.on('findUser', safe(async ({ name }, reply) => {
    const u = me() && await store.getUser(me());
    if (!u) return reply({ ok: false, error: 'auth' });
    const t = await store.getByName(nameKey(name));
    if (!t) return reply({ ok: false, error: 'none' });
    reply({ ok: true, user: { uid: t.uid, name: t.name, online: online.has(t.uid), self: t.uid === u.uid,
      friend: (u.friends || []).includes(t.uid), sent: await store.hasReq(u.uid, t.uid), got: await store.hasReq(t.uid, u.uid) } });
  }));

  // 친구 요청 보내기
  socket.on('friendReq', safe(async ({ to }, reply) => {
    const u = me() && await store.getUser(me());
    if (!u) return reply({ ok: false, error: 'auth' });
    const t = codeOk(to) && await store.getUser(to);
    if (!t || t.uid === u.uid) return reply({ ok: false, error: 'none' });
    if ((u.friends || []).includes(t.uid)) return reply({ ok: false, error: 'friend' });
    // 상대도 나에게 요청을 보냈었다면 바로 친구가 돼요
    if (await store.hasReq(t.uid, u.uid)) {
      await store.delReq(t.uid, u.uid);
      await store.addFriend(u.uid, t.uid);
      const sid = online.get(t.uid);
      if (sid) io.to(sid).emit('friendAccepted', { uid: u.uid, name: u.name, online: true });
      return reply({ ok: true, state: 'friends', user: await brief(t.uid) });
    }
    await store.addReq(u.uid, t.uid);
    const sid = online.get(t.uid);
    if (sid) io.to(sid).emit('friendReqIn', { uid: u.uid, name: u.name, online: true });
    reply({ ok: true, state: 'sent' });
  }));

  // 받은 친구 요청에 답하기 (수락해야 친구가 돼요)
  socket.on('friendRespond', safe(async ({ from, accept }, reply) => {
    const u = me() && await store.getUser(me());
    if (!u) return reply({ ok: false, error: 'auth' });
    if (!codeOk(from) || !(await store.hasReq(from, u.uid))) return reply({ ok: false, error: 'none' });
    await store.delReq(from, u.uid);
    if (accept) {
      await store.addFriend(u.uid, from);
      const sid = online.get(from);
      if (sid) io.to(sid).emit('friendAccepted', { uid: u.uid, name: u.name, online: true });
      return reply({ ok: true, user: await brief(from) });
    }
    reply({ ok: true });
  }));

  // 친구 삭제 (양쪽에서 모두 지워져요)
  socket.on('friendRemove', safe(async ({ uid }, reply) => {
    const u = me() && await store.getUser(me());
    if (!u || !codeOk(uid)) return reply({ ok: false });
    await store.removeFriend(u.uid, uid);
    const sid = online.get(uid);
    if (sid) io.to(sid).emit('friendRemoved', { uid: u.uid });
    reply({ ok: true });
  }));

  // 30웨이브 클리어 기록 올리기
  socket.on('submitRun', safe(async ({ mode, ms, partner, heroes }, reply) => {
    const u = me() && await store.getUser(me());
    if (!u) return reply({ ok: false, error: 'auth' });
    if (mode !== 'solo' && mode !== 'duo') return reply({ ok: false, error: 'bad' });
    ms = Math.round(Number(ms));
    if (!(ms >= 120000 && ms <= 6 * 3600000)) return reply({ ok: false, error: 'bad' });
    const hs = (Array.isArray(heroes) ? heroes : []).slice(0, 2).map((h) => String(h).replace(/[^a-z0-9_]/gi, '').slice(0, 20));
    const names = mode === 'solo' ? [u.name] : [u.name, cleanName(partner) || '2P'];
    const key = mode === 'solo' ? `solo:${u.uid}` : `duo:${u.uid}:${nameKey(names[1])}`;
    const old = await store.getRun(key);
    const better = !old || ms < old.ms;
    if (better) await store.putRun({ key, mode, ms, names, heroes: hs, uid: u.uid, at: new Date() });
    const bestMs = better ? ms : old.ms;
    reply({ ok: true, better, bestMs, rank: await store.rankOf(mode, bestMs), top: await rankList(mode, u.uid) });
  }));

  // 랭킹 보기
  socket.on('getRanks', safe(async ({ mode }, reply) => {
    if (mode !== 'solo' && mode !== 'duo') return reply({ ok: false });
    const uid = me();
    let mine = null;
    if (uid) {
      const r = mode === 'solo' ? await store.getRun(`solo:${uid}`) : null;
      if (r) mine = { ms: r.ms, rank: await store.rankOf(mode, r.ms) };
    }
    reply({ ok: true, top: await rankList(mode, uid), mine, mode: store.mode });
  }));

  // 초대: 친구에게만 방 코드를 대신 전달해요
  // 친구에게 다이아나 전리품 선물하기
  socket.on('gift', safe(async ({ to, kind, amount, item }, reply) => {
    const u = me() && await store.getUser(me());
    if (!u) return reply({ ok: false, error: 'auth' });
    if (!codeOk(to) || !(u.friends || []).includes(to)) return reply({ ok: false, error: 'friend' });
    let g;
    if (kind === 'd') {
      const n = Math.floor(Number(amount));
      if (!(n >= 1 && n <= 100000)) return reply({ ok: false, error: 'bad' });
      g = { kind: 'd', amount: n };
    } else if (kind === 'i') {
      if (typeof item !== 'string' || !/^[a-z0-9_]{2,24}$/.test(item)) return reply({ ok: false, error: 'bad' });
      g = { kind: 'i', item };
    } else return reply({ ok: false, error: 'bad' });
    Object.assign(g, { id: crypto.randomBytes(8).toString('hex'), to, from: u.uid, fromName: u.name, at: Date.now() });
    await store.addGift(g);
    const sid = online.get(to);
    if (sid) io.to(sid).emit('giftIn', g);
    reply({ ok: true });
  }));
  socket.on('giftAck', safe(async ({ ids }) => {
    const uid = me();
    if (!uid || !Array.isArray(ids)) return;
    await store.delGifts(uid, ids.filter((x) => typeof x === 'string').slice(0, 50));
  }));

  socket.on('invite', safe(async ({ to, code }, reply) => {
    const u = me() && await store.getUser(me());
    if (!u || !(u.friends || []).includes(to) || !online.has(to)) return reply({ ok: false });
    io.to(online.get(to)).emit('invited', { uid: u.uid, name: u.name, code: String(code || '').slice(0, 4) });
    reply({ ok: true });
  }));
  socket.on('inviteReply', safe(async ({ to, ok }) => {
    const u = me() && await store.getUser(me());
    if (u && online.has(to)) io.to(online.get(to)).emit('inviteReply', { uid: u.uid, name: u.name, ok: !!ok });
  }));

  // 방 만들기: 만든 사람이 방장
  socket.on('createRoom', ({ name, hero } = {}, reply) => {
    if (typeof reply !== 'function') return;
    if (socket.data.room) leaveRoom(socket);
    const code = makeCode();
    rooms.set(code, { host: socket.id, players: new Map([[socket.id, { name, hero }]]) });
    socket.join(code);
    socket.data.room = code;
    reply({ ok: true, code, you: socket.id, host: true });
  });

  // 방 코드로 입장 (최대 4명)
  socket.on('joinRoom', ({ code, name, hero } = {}, reply) => {
    if (typeof reply !== 'function') return;
    code = String(code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room || room.match) return reply({ ok: false, error: '방이 없어요' });
    if (room.players.size >= 4) return reply({ ok: false, error: '방이 꽉 찼어요' });
    if (socket.data.room) leaveRoom(socket);
    room.players.set(socket.id, { name, hero });
    socket.join(code);
    socket.data.room = code;
    const players = [...room.players].map(([id, p]) => ({ id, ...p }));
    reply({ ok: true, code, you: socket.id, host: false, players });
    socket.to(code).emit('playerJoined', { id: socket.id, name, hero });
  });

  // 3:3 빠른 매칭: 모으는 중인 매칭이 있으면 거기에, 없으면 새로 만들어요
  socket.on('quickMatch', (data, reply) => {
    if (typeof reply !== 'function') return;
    if (socket.data.room) leaveRoom(socket);
    if (!pending) {
      const code = makeCode();
      rooms.set(code, { host: socket.id, players: new Map(), match: true });
      pending = { code, until: Date.now() + MATCH_WAIT };
      pending.timer = setTimeout(() => startMatch(code), MATCH_WAIT);
    }
    const code = pending.code;
    const room = rooms.get(code);
    room.players.set(socket.id, { name: cleanName(data && data.name) || '플레이어' });
    socket.join(code);
    socket.data.room = code;
    reply({ ok: true, code, wait: Math.max(0, pending.until - Date.now()), you: socket.id });
    io.to(code).emit('matchCount', { n: room.players.size });
    if (room.players.size >= MATCH_SIZE) startMatch(code);
  });

  // 매칭 취소 / 방 나가기
  socket.on('leaveRoom', () => leaveRoom(socket));

  // 위치·체력 같은 계속 바뀌는 상태: 밀리면 버려도 되는 메시지(volatile)
  socket.on('state', (data) => {
    const code = socket.data.room;
    if (code) socket.to(code).volatile.emit('state', { id: socket.id, ...data });
  });

  // 스킬 사용·처치·라운드 시작 같은 사건: 꼭 전달되어야 하는 메시지
  socket.on('event', (data) => {
    const code = socket.data.room;
    if (code) socket.to(code).emit('event', { id: socket.id, ...data });
  });

  socket.on('disconnect', async () => {
    leaveRoom(socket);
    const uid = socket.data.uid;
    if (uid && online.get(uid) === socket.id) {
      online.delete(uid);
      try { const u = await store.getUser(uid); if (u) await tellFriends(u, false); } catch (e) {}
    }
  });
});

store.init().then(() => httpServer.listen(PORT, () => console.log(`서버 시작: http://localhost:${PORT}`)));
