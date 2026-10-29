// خادم تطبيق «معين» لحلقات القرآن — بدون أي اعتماديات خارجية (Node.js فقط)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC = path.join(__dirname, 'public');
const SESSION_DAYS = 30;

// ---------- قاعدة البيانات (ملف JSON) ----------
const uid = () => crypto.randomBytes(8).toString('hex');
const hash = (pw, salt = crypto.randomBytes(12).toString('hex')) =>
  salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
const verify = (pw, stored) => {
  const [salt, h] = String(stored).split(':');
  const a = Buffer.from(hash(pw, salt).split(':')[1], 'hex');
  const b = Buffer.from(h || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

let db;
function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  else {
    db = {
      settings: { appName: 'معين', welcome: 'بسم الله الرحمن الرحيم' },
      users: [{
        id: uid(), role: 'admin', name: 'المشرف', username: 'admin',
        pass: hash('admin123'), createdAt: Date.now(),
      }],
      entries: [], announcements: [], sessions: {},
    };
    save();
    console.log('تم إنشاء حساب المشرف الافتراضي:  admin / admin123  (غيّر كلمة المرور بعد الدخول)');
  }
}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- أدوات ----------
const publicUser = u => ({
  id: u.id, role: u.role, name: u.name, username: u.username,
  teacherId: u.teacherId || null, disabled: !!u.disabled, annBlocked: !!u.annBlocked,
  goal: u.goal || 0, phone: u.phone || '', createdAt: u.createdAt, lastSeen: u.lastSeen || 0,
});
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const int = (v, min, max) => Math.min(max, Math.max(min, parseInt(v, 10) || 0));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function annVisible(a, u) {
  if (u.role === 'admin') return true;
  if (u.annBlocked) return false;
  if ((a.hiddenFrom || []).includes(u.id)) return false;
  if (a.audience === 'teachers' && u.role !== 'teacher') return false;
  if (a.audience === 'students' && u.role !== 'student') return false;
  return true;
}

function stateFor(u) {
  const teachers = db.users.filter(x => x.role === 'teacher');
  let users, entries;
  if (u.role === 'admin') {
    users = db.users; entries = db.entries;
  } else if (u.role === 'teacher') {
    users = db.users.filter(x => x.id === u.id || x.teacherId === u.id || (x.role === 'student' && !x.teacherId));
    const mine = new Set(users.filter(x => x.teacherId === u.id).map(x => x.id));
    entries = db.entries.filter(e => mine.has(e.studentId));
  } else {
    users = [u, ...teachers];
    entries = db.entries.filter(e => e.studentId === u.id);
  }
  return {
    me: publicUser(u),
    settings: db.settings,
    users: users.map(publicUser),
    entries,
    announcements: u.annBlocked && u.role !== 'admin' ? [] : db.announcements.filter(a => annVisible(a, u)),
    annBlockedMe: !!u.annBlocked && u.role !== 'admin',
    serverTime: Date.now(),
  };
}

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

const attempts = new Map();
function throttle(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  if (a.length >= 15) fail(429, 'محاولات كثيرة، حاول بعد قليل');
  a.push(now); attempts.set(ip, a);
}

function newSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { userId: user.id, exp: Date.now() + SESSION_DAYS * 864e5 };
  return token;
}

function validUsername(s) {
  if (!/^[\w.\-@]{3,30}$/.test(s)) fail(400, 'اسم المستخدم: 3–30 حرفًا إنجليزيًا أو أرقامًا');
}
function validPass(s) { if (String(s).length < 6) fail(400, 'كلمة المرور 6 أحرف على الأقل'); }

// ---------- المسارات ----------
function route(req, body, user, ip) {
  const { method, url } = req;
  const p = url.split('?')[0];
  const m = (verb, pattern) => {
    if (method !== verb) return null;
    const re = new RegExp('^' + pattern.replace(/:id/g, '([\\w]+)') + '$');
    const r = re.exec(p);
    return r ? r.slice(1) : null;
  };
  let r;

  // --- بدون تسجيل دخول ---
  if (m('POST', '/api/login')) {
    throttle(ip);
    const u = db.users.find(x => x.username.toLowerCase() === str(body.username, 40).toLowerCase());
    if (!u || !verify(body.password, u.pass)) fail(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
    if (u.disabled) fail(403, 'هذا الحساب معطّل، تواصل مع المشرف');
    return { token: newSession(u), ...{ ok: true } };
  }
  if (m('GET', '/api/public')) {
    return {
      appName: db.settings.appName,
      teachers: db.users.filter(x => x.role === 'teacher' && !x.disabled).map(x => ({ id: x.id, name: x.name })),
    };
  }
  if (m('POST', '/api/register')) {
    throttle(ip);
    const username = str(body.username, 30), name = str(body.name, 60);
    validUsername(username); validPass(body.password);
    if (name.length < 2) fail(400, 'أدخل الاسم');
    if (db.users.some(x => x.username.toLowerCase() === username.toLowerCase())) fail(409, 'اسم المستخدم مستخدم من قبل');
    const t = db.users.find(x => x.id === body.teacherId && x.role === 'teacher');
    const u = { id: uid(), role: 'student', name, username, pass: hash(body.password), teacherId: t ? t.id : null, createdAt: Date.now() };
    db.users.push(u); save();
    return { token: newSession(u), ok: true };
  }

  if (!user) fail(401, 'يلزم تسجيل الدخول');
  user.lastSeen = Date.now();
  const isAdmin = user.role === 'admin', isTeacher = user.role === 'teacher', isStudent = user.role === 'student';

  if (m('GET', '/api/state')) return stateFor(user);
  if (m('POST', '/api/logout')) { delete db.sessions[body._token]; save(); return { ok: true }; }

  if (m('POST', '/api/password')) {
    if (!verify(body.old, user.pass)) fail(400, 'كلمة المرور الحالية غير صحيحة');
    validPass(body.new);
    user.pass = hash(body.new); save(); return { ok: true };
  }
  if (m('PUT', '/api/profile')) {
    if (body.name !== undefined) { const n = str(body.name, 60); if (n.length < 2) fail(400, 'الاسم قصير'); user.name = n; }
    if (body.phone !== undefined) user.phone = str(body.phone, 20);
    if (isStudent && body.goal !== undefined) user.goal = int(body.goal, 0, 1000);
    if (isStudent && body.teacherId !== undefined) {
      const t = db.users.find(x => x.id === body.teacherId && x.role === 'teacher');
      user.teacherId = t ? t.id : null;
    }
    save(); return { ok: true };
  }

  // --- المستخدمون ---
  if (m('POST', '/api/users')) {
    if (!isAdmin) fail(403, 'للمشرف فقط');
    const username = str(body.username, 30), name = str(body.name, 60);
    validUsername(username); validPass(body.password);
    if (name.length < 2) fail(400, 'أدخل الاسم');
    if (!['teacher', 'student'].includes(body.role)) fail(400, 'نوع غير صحيح');
    if (db.users.some(x => x.username.toLowerCase() === username.toLowerCase())) fail(409, 'اسم المستخدم مستخدم من قبل');
    const t = db.users.find(x => x.id === body.teacherId && x.role === 'teacher');
    db.users.push({ id: uid(), role: body.role, name, username, pass: hash(body.password), phone: str(body.phone, 20),
      teacherId: body.role === 'student' && t ? t.id : null, createdAt: Date.now() });
    save(); return { ok: true };
  }
  if ((r = m('PUT', '/api/users/:id'))) {
    const t = db.users.find(x => x.id === r[0]);
    if (!t) fail(404, 'غير موجود');
    if (isTeacher) { // المعلم يستطيع ضم طالب غير مسند فقط
      if (t.role !== 'student' || (t.teacherId && t.teacherId !== user.id)) fail(403, 'غير مسموح');
      t.teacherId = body.teacherId === null ? null : user.id; save(); return { ok: true };
    }
    if (!isAdmin) fail(403, 'للمشرف فقط');
    if (body.name !== undefined) t.name = str(body.name, 60) || t.name;
    if (body.phone !== undefined) t.phone = str(body.phone, 20);
    if (body.disabled !== undefined && t.role !== 'admin') {
      t.disabled = !!body.disabled;
      if (t.disabled) for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === t.id) delete db.sessions[k];
    }
    if (body.annBlocked !== undefined) t.annBlocked = !!body.annBlocked;
    if (body.teacherId !== undefined && t.role === 'student') {
      const tt = db.users.find(x => x.id === body.teacherId && x.role === 'teacher');
      t.teacherId = tt ? tt.id : null;
    }
    if (body.password) { validPass(body.password); t.pass = hash(body.password); }
    save(); return { ok: true };
  }
  if ((r = m('DELETE', '/api/users/:id'))) {
    if (!isAdmin) fail(403, 'للمشرف فقط');
    const t = db.users.find(x => x.id === r[0]);
    if (!t || t.role === 'admin') fail(400, 'لا يمكن الحذف');
    db.users = db.users.filter(x => x.id !== t.id);
    db.entries = db.entries.filter(e => e.studentId !== t.id);
    db.users.forEach(x => { if (x.teacherId === t.id) x.teacherId = null; });
    for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === t.id) delete db.sessions[k];
    save(); return { ok: true };
  }

  // --- جدول المتابعة ---
  if (m('POST', '/api/entries')) {
    const date = str(body.date, 10);
    if (!DATE_RE.test(date)) fail(400, 'تاريخ غير صحيح');
    let studentId = user.id;
    if (!isStudent) {
      const s = db.users.find(x => x.id === body.studentId && x.role === 'student');
      if (!s) fail(404, 'الطالب غير موجود');
      if (isTeacher && s.teacherId !== user.id) fail(403, 'ليس من طلابك');
      studentId = s.id;
    }
    let e = db.entries.find(x => x.studentId === studentId && x.date === date);
    if (!e) { e = { id: uid(), studentId, date, attendance: '', createdAt: Date.now() }; db.entries.push(e); }
    const att = v => (['present', 'absent', 'excused'].includes(v) ? v : '');
    if (isStudent) {
      if (body.attendance !== undefined) { e.attendance = att(body.attendance); if (e.attendance === 'present' && body.checkin) e.checkinAt = Date.now(); }
      for (const k of ['newSurah', 'revSurah']) if (body[k] !== undefined) e[k] = int(body[k], 0, 114);
      for (const k of ['newFrom', 'newTo', 'revFrom', 'revTo']) if (body[k] !== undefined) e[k] = int(body[k], 0, 300);
      if (body.note !== undefined) e.note = str(body.note, 500);
    } else {
      if (body.attendance !== undefined) e.attendance = att(body.attendance);
      if (body.grade !== undefined) e.grade = int(body.grade, 0, 5);
      if (body.teacherNote !== undefined) e.teacherNote = str(body.teacherNote, 500);
    }
    e.updatedAt = Date.now();
    save(); return { ok: true, entry: e };
  }
  if ((r = m('DELETE', '/api/entries/:id'))) {
    const e = db.entries.find(x => x.id === r[0]);
    if (!e) fail(404, 'غير موجود');
    if (!isAdmin && !(isStudent && e.studentId === user.id)) fail(403, 'غير مسموح');
    db.entries = db.entries.filter(x => x !== e); save(); return { ok: true };
  }

  // --- الإعلانات (للمشرف) ---
  const annBody = () => {
    const title = str(body.title, 120), text = str(body.body, 2000);
    if (!title) fail(400, 'أدخل عنوان الإعلان');
    return {
      title, body: text, pinned: !!body.pinned, important: !!body.important,
      audience: ['all', 'teachers', 'students'].includes(body.audience) ? body.audience : 'all',
      hiddenFrom: Array.isArray(body.hiddenFrom) ? body.hiddenFrom.filter(id => db.users.some(u => u.id === id)).slice(0, 500) : [],
    };
  };
  if (m('POST', '/api/announcements')) {
    if (!isAdmin) fail(403, 'للمشرف فقط');
    db.announcements.unshift({ id: uid(), createdAt: Date.now(), ...annBody() }); save(); return { ok: true };
  }
  if ((r = m('PUT', '/api/announcements/:id'))) {
    if (!isAdmin) fail(403, 'للمشرف فقط');
    const a = db.announcements.find(x => x.id === r[0]); if (!a) fail(404, 'غير موجود');
    Object.assign(a, annBody()); save(); return { ok: true };
  }
  if ((r = m('DELETE', '/api/announcements/:id'))) {
    if (!isAdmin) fail(403, 'للمشرف فقط');
    db.announcements = db.announcements.filter(x => x.id !== r[0]); save(); return { ok: true };
  }

  if (m('PUT', '/api/settings')) {
    if (!isAdmin) fail(403, 'للمشرف فقط');
    if (body.appName !== undefined) db.settings.appName = str(body.appName, 40) || 'معين';
    if (body.welcome !== undefined) db.settings.welcome = str(body.welcome, 200);
    save(); return { ok: true };
  }
  if (m('GET', '/api/backup')) {
    if (!isAdmin) fail(403, 'للمشرف فقط');
    return { users: db.users.map(publicUser), entries: db.entries, announcements: db.announcements, settings: db.settings };
  }

  fail(404, 'المسار غير موجود');
}

// ---------- خادم HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

load();
http.createServer((req, res) => {
  if (!req.url.startsWith('/api/')) return serveStatic(req, res);
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 200000) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      let body = {};
      if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'بيانات غير صحيحة'); } }
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      const s = db.sessions[token];
      let user = null;
      if (s && s.exp > Date.now()) user = db.users.find(u => u.id === s.userId && !u.disabled) || null;
      body._token = token;
      send(200, route(req, body, user, req.socket.remoteAddress));
    } catch (e) {
      if (e instanceof HttpError) send(e.code, { error: e.message });
      else { console.error(e); send(500, { error: 'خطأ في الخادم' }); }
    }
  });
}).listen(PORT, '0.0.0.0', () => {

  console.log(`\nتطبيق «معين» يعمل على:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`من الجوال (نفس الشبكة):  http://${i.address}:${PORT}`);
});
