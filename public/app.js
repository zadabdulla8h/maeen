'use strict';
// ================= أدوات عامة =================
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDay = s => new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(s + 'T00:00:00'));
const fmtShort = s => new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', { day: 'numeric', month: 'numeric' }).format(new Date(s + 'T00:00:00'));
const hijri = () => new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura', { dateStyle: 'full' }).format(new Date());
const fmtTime = t => new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t));
const ROLE = { admin: 'مشرف', teacher: 'معلم', student: 'طالب' };
const ATT = { present: 'حاضر', absent: 'غائب', excused: 'معتذر' };
const GRADE = ['', 'ضعيف', 'مقبول', 'جيد', 'جيد جدًا', 'ممتاز'];

let S = null;            // الحالة القادمة من الخادم
let view = 'dash';       // الصفحة الحالية
let ctx = {};            // سياق الصفحة (الطالب المفتوح، فلاتر...)
let token = localStorage.getItem('token') || '';
let theme = JSON.parse(localStorage.getItem('theme') || '{}');
let pollTimer;

async function api(path, method = 'GET', body) {
  const r = await fetch('/api/' + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token) { token = ''; localStorage.removeItem('token'); S = null; renderAuth(); }
    throw new Error(j.error || 'حدث خطأ');
  }
  return j;
}
function toast(msg, bad) {
  const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await refresh(); } catch (e) { toast(e.message, true); }
}

// ================= المظهر =================
const ACCENTS = { teal: '#0f766e', gold: '#a16207', blue: '#1d4ed8', purple: '#7e22ce', rose: '#be185d', brown: '#78350f' };
function applyTheme() {
  const d = document.documentElement, m = theme.mode || 'auto';
  d.dataset.theme = m === 'auto' ? (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light') : m;
  d.dataset.accent = theme.accent || 'teal';
  d.style.fontSize = (theme.size || 16) + 'px';
  const mt = document.querySelector('meta[name=theme-color]'); if (mt) mt.content = ACCENTS[theme.accent || 'teal'];
}
function setTheme(p) { theme = { ...theme, ...p }; localStorage.setItem('theme', JSON.stringify(theme)); applyTheme(); }
matchMedia('(prefers-color-scheme:dark)').addEventListener?.('change', applyTheme);

function themeCard() {
  const m = theme.mode || 'auto', a = theme.accent || 'teal', z = theme.size || 16;
  return `<div class="card"><h3>🎨 المظهر</h3>
    <div class="field"><label>النمط</label><div class="seg">
      ${[['light', '☀️ فاتح'], ['dark', '🌙 داكن'], ['auto', '🖥️ تلقائي']].map(([k, v]) => `<button data-theme-mode="${k}" class="${m === k ? 'on' : ''}">${v}</button>`).join('')}</div></div>
    <div class="field"><label>اللون الرئيسي</label><div class="swatches">
      ${Object.entries(ACCENTS).map(([k, c]) => `<div class="sw ${a === k ? 'on' : ''}" data-accent="${k}" style="background:${c}" title="${k}"></div>`).join('')}</div></div>
    <div class="field"><label>حجم الخط</label><div class="seg">
      ${[[14, 'صغير'], [16, 'متوسط'], [18, 'كبير'], [20, 'كبير جدًا']].map(([k, v]) => `<button data-theme-size="${k}" class="${z === k ? 'on' : ''}">${v}</button>`).join('')}</div></div></div>`;
}

// ================= حساب الإحصائيات =================
const span = (a, b) => (a && b && b >= a ? b - a + 1 : 0);
const newAyahs = e => (e.newSurah ? span(e.newFrom, e.newTo) : 0);
const revAyahs = e => (e.revSurah ? span(e.revFrom, e.revTo) : 0);
function stats(entries, from, to) {
  const es = entries.filter(e => (!from || e.date >= from) && (!to || e.date <= to));
  const c = { days: es.length, present: 0, absent: 0, excused: 0, newA: 0, revA: 0, gSum: 0, gN: 0 };
  es.forEach(e => {
    if (e.attendance) c[e.attendance]++;
    c.newA += newAyahs(e); c.revA += revAyahs(e);
    if (e.grade) { c.gSum += e.grade; c.gN++; }
  });
  const att = c.present + c.absent + c.excused;
  c.rate = att ? Math.round((c.present / att) * 100) : 0;
  c.avg = c.gN ? c.gSum / c.gN : 0;
  return c;
}
function streak(entries) {
  const set = new Set(entries.filter(e => e.attendance === 'present').map(e => e.date));
  let d = today(), n = 0;
  if (!set.has(d)) d = addDays(d, -1);
  while (set.has(d)) { n++; d = addDays(d, -1); }
  return n;
}
const entriesOf = id => S.entries.filter(e => e.studentId === id);
const userById = id => S.users.find(u => u.id === id);
const students = () => S.users.filter(u => u.role === 'student');
const teachers = () => S.users.filter(u => u.role === 'teacher');
const stars = g => (g ? `<span class="stars" title="${GRADE[g]}">${'★'.repeat(g)}${'☆'.repeat(5 - g)}</span>` : '<span class="muted">—</span>');
const attPill = a => `<span class="pill ${a || 'none'}">${ATT[a] || 'لم يُسجّل'}</span>`;
const surahName = i => (i ? SURAHS[i - 1].name : '');
function range(s, f, t) { return s ? `${surahName(s)} ${f || '؟'}${t && t !== f ? '–' + t : ''}` : '<span class="muted">—</span>'; }

// ================= رسوم =================
function barChart(days, series) {
  // days: [{label, a, b}] — a: حفظ، b: مراجعة
  const W = 560, H = 170, pl = 28, pb = 22, n = days.length;
  const max = Math.max(5, ...days.map(d => Math.max(d.a, d.b)));
  const bw = (W - pl) / n;
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const y = 8 + (H - pb - 8) * (i / 3), v = Math.round(max * (1 - i / 3));
    g += `<line class="grid-l" x1="${pl}" x2="${W}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${y + 3}" text-anchor="end">${v}</text>`;
  }
  days.forEach((d, i) => {
    const x = pl + i * bw, h1 = (d.a / max) * (H - pb - 8), h2 = (d.b / max) * (H - pb - 8), w = Math.max(3, bw / 2 - 3);
    g += `<rect class="b" x="${x + 2}" y="${H - pb - h1}" width="${w}" height="${h1}" rx="2"><title>${d.label}: حفظ ${d.a}</title></rect>`;
    g += `<rect class="b2" x="${x + 2 + w + 1}" y="${H - pb - h2}" width="${w}" height="${h2}" rx="2"><title>${d.label}: مراجعة ${d.b}</title></rect>`;
    if (n <= 14 || i % 2 === 0) g += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.label}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="رسم بياني">${g}</svg>
  <div class="legend"><span><i style="background:var(--accent)"></i>${series[0]}</span><span><i style="background:var(--accent-2)"></i>${series[1]}</span></div>`;
}
function dailyData(entries, nDays) {
  const out = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const d = addDays(today(), -i), es = entries.filter(e => e.date === d);
    out.push({ label: fmtShort(d), a: es.reduce((s, e) => s + newAyahs(e), 0), b: es.reduce((s, e) => s + revAyahs(e), 0) });
  }
  return out;
}
function donut(c) {
  const parts = [['present', c.present, '#16a34a'], ['excused', c.excused, '#d97706'], ['absent', c.absent, '#dc2626']];
  const tot = c.present + c.absent + c.excused, R = 48, L = 2 * Math.PI * R;
  let off = 0, arcs = '';
  if (tot) parts.forEach(([, v, col]) => {
    if (!v) return; const len = (v / tot) * L;
    arcs += `<circle r="${R}" cx="60" cy="60" fill="none" stroke="${col}" stroke-width="16" stroke-dasharray="${len} ${L - len}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)"/>`;
    off += len;
  });
  return `<div class="donut"><svg viewBox="0 0 120 120"><circle r="${R}" cx="60" cy="60" fill="none" stroke="var(--bg)" stroke-width="16"/>${arcs}
    <text x="60" y="66" text-anchor="middle" style="font-size:20px;font-weight:800;fill:var(--text)">${c.rate}%</text></svg>
    <div class="small">${parts.map(([k, v, col]) => `<div><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${col};margin-inline-end:.4rem"></i>${ATT[k]}: <b>${v}</b></div>`).join('')}</div></div>`;
}
const statCard = (ic, val, lbl) => `<div class="stat"><div class="ic">${ic}</div><div><b>${val}</b><span>${lbl}</span></div></div>`;
const empty = (ic, msg) => `<div class="empty"><div class="big">${ic}</div>${msg}</div>`;

// ================= النوافذ =================
function modal(title, html, onSubmit, okText = 'حفظ') {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal"><h3>${title}</h3>${html}<div class="err"></div><div class="btns"><button type="button" class="btn" data-x>إلغاء</button><button class="btn primary">${okText}</button></div></form>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  $('[data-x]', bg).onclick = close;
  $('form', bg).onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target, data = {};
    new FormData(f).forEach((v, k) => { data[k] = k in data ? [].concat(data[k], v) : v; });
    f.querySelectorAll('input[type=checkbox]:not([name$="[]"])').forEach(c => { if (c.name) data[c.name] = c.checked; });
    try { await onSubmit(data, f); close(); await refresh(); } catch (e) { $('.err', bg).textContent = e.message; }
  };
  const first = $('input:not([type=hidden]),select,textarea', bg); first?.focus();
  return bg;
}
const confirmBox = (msg, fn) => modal('تأكيد', `<p style="margin-bottom:.8rem">${msg}</p>`, fn, 'نعم، متأكد');
const surahSel = (name, val) => `<select name="${name}"><option value="0">— بدون —</option>${SURAHS.map((s, i) => `<option value="${i + 1}" ${val == i + 1 ? 'selected' : ''}>${i + 1}. ${s.name}</option>`).join('')}</select>`;

// ================= تسجيل الدخول =================
async function renderAuth() {
  clearInterval(pollTimer);
  let pub = { appName: 'معين', teachers: [] };
  try { pub = await fetch('/api/public').then(r => r.json()); } catch { }
  let tab = 'login';
  const root = $('#root');
  const draw = () => {
    root.innerHTML = `<div class="auth"><div class="auth-box">
      <div class="logo">📖</div><h1>${esc(pub.appName)}</h1><div class="sub">حلقة القرآن الكريم</div>
      <div class="tabs"><button data-t="login" class="${tab === 'login' ? 'on' : ''}">دخول</button><button data-t="reg" class="${tab === 'reg' ? 'on' : ''}">طالب جديد</button></div>
      <form id="af">
        ${tab === 'reg' ? `<div class="field"><label>الاسم الكامل</label><input name="name" required></div>` : ''}
        <div class="field"><label>اسم المستخدم</label><input name="username" required autocomplete="username" dir="ltr" style="text-align:start"></div>
        <div class="field"><label>كلمة المرور</label><input name="password" type="password" required autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}" dir="ltr" style="text-align:start"></div>
        ${tab === 'reg' ? `<div class="field"><label>المعلم</label><select name="teacherId"><option value="">— سيحدده المشرف —</option>${pub.teachers.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>` : ''}
        <div class="err"></div>
        <button class="btn primary" style="width:100%;justify-content:center;padding:.7rem">${tab === 'login' ? 'دخول' : 'إنشاء الحساب'}</button>
      </form></div></div>`;
    root.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; draw(); });
    $('#af').onsubmit = async e => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api(tab === 'login' ? 'login' : 'register', 'POST', d);
        token = r.token; localStorage.setItem('token', token);
        view = 'dash'; await boot();
      } catch (err) { $('.err').textContent = err.message; }
    };
  };
  draw();
}

// ================= الهيكل العام =================
const NAV = {
  admin: [['dash', '📊', 'لوحة التحكم'], ['students', '🎓', 'الطلاب'], ['teachers', '👨‍🏫', 'المعلمون'], ['ann', '📢', 'الإعلانات'], ['settings', '⚙️', 'الإعدادات']],
  teacher: [['dash', '📊', 'لوحة التحكم'], ['students', '🎓', 'طلابي'], ['ann', '📢', 'الإعلانات'], ['settings', '⚙️', 'حسابي']],
  student: [['dash', '🏠', 'الرئيسية'], ['table', '📋', 'جدول متابعتي'], ['ann', '📢', 'الإعلانات'], ['settings', '⚙️', 'حسابي']],
};
const annSeen = () => +localStorage.getItem('annSeen' + S.me.id) || 0;
const annUnread = () => S.announcements.filter(a => a.createdAt > annSeen()).length;

function shell(title, body, actions = '') {
  const nav = NAV[S.me.role], unread = annUnread();
  const items = (cls) => nav.map(([k, ic, lb]) => `<button data-nav="${k}" class="${(view === k || (k === 'students' && view === 'student')) ? 'on' : ''}"><span>${ic}</span>${cls ? lb.split(' ')[0] : lb}${k === 'ann' && unread ? `<i class="badge">${unread}</i>` : ''}</button>`).join('');
  return `<div class="app"><aside class="side"><div class="brand"><div class="logo">📖</div>${esc(S.settings.appName)}</div>
    <nav class="nav">${items()}</nav>
    <div class="foot"><b>${esc(S.me.name)}</b><br><span class="role-chip">${ROLE[S.me.role]}</span><br><br><button class="btn sm" data-logout>تسجيل الخروج</button></div></aside>
    <main class="main"><div class="top"><h2>${title}</h2>${actions}<span class="date">${hijri()}</span>
      <button class="btn icon sm" data-toggle-dark title="تبديل الوضع الداكن">🌓</button><button class="btn sm no-print mnav-out" data-logout>خروج</button></div>
      ${body}</main>
    <nav class="mnav">${items(1)}</nav></div>`;
}

function render() {
  if (!S) return;
  const role = S.me.role, root = $('#root');
  if (view === 'ann') localStorage.setItem('annSeen' + S.me.id, Date.now());
  const scroll = window.scrollY;
  let out;
  if (view === 'student') out = viewStudent(ctx.studentId);
  else out = ({ admin: ADMIN, teacher: TEACHER, student: STUDENT }[role][view] || (() => ''))();
  const keep = document.activeElement?.closest?.('[data-keep]') ? document.activeElement : null;
  root.innerHTML = out;
  window.scrollTo(0, scroll);
  if (keep?.id) $('#' + keep.id)?.focus();
}
function go(v, c = {}) { view = v; ctx = c; render(); window.scrollTo(0, 0); }

async function refresh() {
  S = await api('state');
  document.title = S.settings.appName + ' — حلقة القرآن';
  if (!$('.modal-bg')) render();
}
async function boot() {
  if (!token) return renderAuth();
  try { await refresh(); } catch { return renderAuth(); }
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (!document.hidden && !$('.modal-bg') && !document.activeElement?.closest?.('input,textarea,select')) refresh().catch(() => { }); }, 20000);
}

// ================= الإعلانات (مشتركة) =================
function annList() {
  const isAdmin = S.me.role === 'admin', seen = annSeen();
  const list = [...S.announcements].sort((a, b) => (b.pinned - a.pinned) || b.createdAt - a.createdAt);
  if (!list.length) return empty('📢', S.annBlockedMe ? 'تم إيقاف عرض الإعلانات لحسابك' : 'لا توجد إعلانات حاليًا');
  return list.map(a => `<div class="ann ${a.important ? 'important' : ''} ${a.createdAt > seen && !isAdmin ? 'new' : ''}">
    <h4>${a.pinned ? '📌' : ''} ${esc(a.title)} ${a.important ? '<span class="pill imp">مهم</span>' : ''}${isAdmin ? `<span class="pill pin">${{ all: 'للجميع', teachers: 'للمعلمين', students: 'للطلاب' }[a.audience]}</span>${a.hiddenFrom?.length ? `<span class="pill none">🚫 محجوب عن ${a.hiddenFrom.length}</span>` : ''}` : ''}</h4>
    <p>${esc(a.body)}</p>
    <div class="meta">${fmtTime(a.createdAt)}${isAdmin ? `<span style="flex:1"></span><button class="btn sm" data-ann-edit="${a.id}">✏️ تعديل</button><button class="btn sm danger" data-ann-del="${a.id}">🗑️ حذف</button>` : ''}</div></div>`).join('');
}
function annForm(a) {
  a = a || { audience: 'all', hiddenFrom: [] };
  const people = S.users.filter(u => u.role !== 'admin');
  modal(a.id ? 'تعديل إعلان' : 'إعلان جديد', `
    <div class="field"><label>العنوان</label><input name="title" value="${esc(a.title)}" required maxlength="120"></div>
    <div class="field"><label>النص</label><textarea name="body" rows="4" maxlength="2000">${esc(a.body)}</textarea></div>
    <div class="row"><div class="field"><label>موجّه إلى</label><select name="audience">
      ${[['all', 'الجميع'], ['teachers', 'المعلمين فقط'], ['students', 'الطلاب فقط']].map(([k, v]) => `<option value="${k}" ${a.audience === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" name="pinned" ${a.pinned ? 'checked' : ''}>📌 تثبيت في الأعلى</label>
      <label class="check"><input type="checkbox" name="important" ${a.important ? 'checked' : ''}>❗ إعلان مهم</label></div></div>
    <div class="field"><label>🚫 إخفاء هذا الإعلان عن أشخاص محددين</label>
      <div class="users-pick">${people.length ? people.map(u => `<label class="check"><input type="checkbox" name="hiddenFrom[]" value="${u.id}" ${a.hiddenFrom?.includes(u.id) ? 'checked' : ''}>${esc(u.name)} <span class="muted small">(${ROLE[u.role]})</span></label>`).join('') : '<span class="muted">لا يوجد مستخدمون بعد</span>'}</div></div>`,
    d => api('announcements' + (a.id ? '/' + a.id : ''), a.id ? 'PUT' : 'POST', { ...d, hiddenFrom: [].concat(d['hiddenFrom[]'] || []) }).then(() => toast('تم النشر ✅')));
}

// ================= جدول المتابعة (مشترك) =================
function entriesTable(list, opts = {}) {
  if (!list.length) return empty('📋', opts.emptyMsg || 'لا توجد سجلات بعد');
  const rows = [...list].sort((a, b) => b.date.localeCompare(a.date)).map(e => `<tr>
    <td><b>${fmtDay(e.date)}</b>${e.date === today() ? ' <span class="pill pin">اليوم</span>' : ''}</td>
    <td>${attPill(e.attendance)}${e.checkinAt ? `<div class="muted small">${new Intl.DateTimeFormat('ar', { timeStyle: 'short' }).format(new Date(e.checkinAt))}</div>` : ''}</td>
    <td>${range(e.newSurah, e.newFrom, e.newTo)}${newAyahs(e) ? ` <span class="muted small">(${newAyahs(e)} آية)</span>` : ''}</td>
    <td>${range(e.revSurah, e.revFrom, e.revTo)}${revAyahs(e) ? ` <span class="muted small">(${revAyahs(e)})</span>` : ''}</td>
    <td>${stars(e.grade)}</td>
    <td class="small">${e.note ? `<div>🧑‍🎓 ${esc(e.note)}</div>` : ''}${e.teacherNote ? `<div>👨‍🏫 ${esc(e.teacherNote)}</div>` : ''}</td>
    <td class="act no-print">${opts.student ? `<button class="btn sm" data-e-edit="${e.date}">✏️</button><button class="btn sm danger" data-e-del="${e.id}">🗑️</button>` : `<button class="btn sm" data-t-edit="${e.date}">💬 تقييم</button>`}</td></tr>`).join('');
  return `<div class="tw"><table><thead><tr><th>التاريخ</th><th>الحضور</th><th>الحفظ الجديد</th><th>المراجعة</th><th>التقييم</th><th>ملاحظات</th><th class="no-print"></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function studentEntryForm(date) {
  const e = entriesOf(S.me.id).find(x => x.date === date) || { date: date || today() };
  modal(date ? 'تعديل السجل' : 'سجل جديد في جدولي', `
    <div class="row"><div class="field"><label>التاريخ</label><input type="date" name="date" value="${e.date}" max="${addDays(today(), 0)}" required ${date ? 'readonly' : ''}></div>
    <div class="field"><label>الحضور</label><select name="attendance">${[['', '— بدون —'], ['present', 'حاضر'], ['absent', 'غائب'], ['excused', 'معتذر']].map(([k, v]) => `<option value="${k}" ${e.attendance === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
    <div class="card" style="padding:.8rem;background:var(--bg)"><b>📗 الحفظ الجديد</b><div class="row" style="margin-top:.5rem">
      <div class="field"><label>السورة</label>${surahSel('newSurah', e.newSurah)}</div>
      <div class="field"><label>من آية</label><input type="number" name="newFrom" min="0" value="${e.newFrom || ''}"></div>
      <div class="field"><label>إلى آية</label><input type="number" name="newTo" min="0" value="${e.newTo || ''}"></div></div></div>
    <div class="card" style="padding:.8rem;background:var(--bg)"><b>🔁 المراجعة</b><div class="row" style="margin-top:.5rem">
      <div class="field"><label>السورة</label>${surahSel('revSurah', e.revSurah)}</div>
      <div class="field"><label>من آية</label><input type="number" name="revFrom" min="0" value="${e.revFrom || ''}"></div>
      <div class="field"><label>إلى آية</label><input type="number" name="revTo" min="0" value="${e.revTo || ''}"></div></div></div>
    <div class="field"><label>ملاحظاتي</label><textarea name="note" maxlength="500">${esc(e.note)}</textarea></div>`,
    async d => {
      for (const p of ['new', 'rev']) {
        const s = +d[p + 'Surah'], f = +d[p + 'From'], t = +d[p + 'To'];
        if (s) {
          const max = SURAHS[s - 1].ayahs;
          if (!f || !t) throw new Error('حدّد آية البداية والنهاية');
          if (f > t) throw new Error('آية البداية بعد آية النهاية');
          if (t > max) throw new Error(`سورة ${SURAHS[s - 1].name} عدد آياتها ${max}`);
        }
      }
      if (d.date > today()) throw new Error('لا يمكن التسجيل في تاريخ مستقبلي');
      await api('entries', 'POST', d); toast('تم الحفظ ✅');
    });
}
function teacherEntryForm(studentId, date) {
  const st = userById(studentId), e = entriesOf(studentId).find(x => x.date === date) || { date };
  modal(`تقييم ${esc(st.name)} — ${fmtDay(date)}`, `
    ${e.newSurah || e.revSurah ? `<div class="card small" style="background:var(--bg)">📗 ${range(e.newSurah, e.newFrom, e.newTo)}<br>🔁 ${range(e.revSurah, e.revFrom, e.revTo)}</div>` : '<p class="muted small" style="margin-bottom:.6rem">لم يسجّل الطالب حفظه لهذا اليوم.</p>'}
    <div class="row"><div class="field"><label>الحضور</label><select name="attendance">${[['', '— بدون —'], ['present', 'حاضر'], ['absent', 'غائب'], ['excused', 'معتذر']].map(([k, v]) => `<option value="${k}" ${e.attendance === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label>التقييم</label><select name="grade">${GRADE.map((g, i) => `<option value="${i}" ${(e.grade || 0) === i ? 'selected' : ''}>${i ? '★'.repeat(i) + ' ' + g : '— بدون —'}</option>`).join('')}</select></div></div>
    <div class="field"><label>ملاحظة المعلم</label><textarea name="teacherNote" maxlength="500">${esc(e.teacherNote)}</textarea></div>`,
    d => api('entries', 'POST', { ...d, studentId, date, grade: +d.grade }).then(() => toast('تم الحفظ ✅')));
}
function csvExport(st) {
  const rows = [['التاريخ', 'الحضور', 'الحفظ الجديد', 'المراجعة', 'التقييم', 'ملاحظة الطالب', 'ملاحظة المعلم']];
  [...entriesOf(st.id)].sort((a, b) => a.date.localeCompare(b.date)).forEach(e => rows.push([e.date, ATT[e.attendance] || '',
    e.newSurah ? `${surahName(e.newSurah)} ${e.newFrom}-${e.newTo}` : '', e.revSurah ? `${surahName(e.revSurah)} ${e.revFrom}-${e.revTo}` : '', GRADE[e.grade] || '', e.note || '', e.teacherNote || '']));
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `متابعة-${st.name}.csv`; a.click();
}

// ================= عرض طالب (للمعلم والمشرف) =================
function viewStudent(id) {
  const st = userById(id); if (!st) { view = 'students'; return (S.me.role === 'admin' ? ADMIN : TEACHER).students(); }
  const es = entriesOf(id), all = stats(es), w = stats(es, addDays(today(), -6)), t = userById(st.teacherId);
  const body = `
    <div class="grid">
      ${statCard('✅', all.rate + '%', 'نسبة الحضور')}${statCard('📗', all.newA, 'آية حفظ جديد')}${statCard('🔁', all.revA, 'آية مراجعة')}
      ${statCard('🔥', streak(es), 'أيام حضور متتالية')}${statCard('⭐', all.avg ? all.avg.toFixed(1) + '/5' : '—', 'متوسط التقييم')}
      ${st.goal ? statCard('🎯', `${w.newA}/${st.goal}`, 'هدف الأسبوع (آيات)') : ''}</div>
    <div class="grid two"><div class="card"><h3>📈 آخر 14 يومًا</h3>${barChart(dailyData(es, 14), ['حفظ جديد', 'مراجعة'])}</div>
      <div class="card"><h3>🗓️ الحضور</h3>${donut(all)}</div></div>
    <div class="card"><h3>📋 جدول المتابعة <span class="spacer"></span>
      <button class="btn sm" data-csv="${id}">⬇️ تصدير CSV</button><button class="btn sm" onclick="print()">🖨️ طباعة</button>
      <button class="btn sm primary" data-t-edit="${today()}">💬 تقييم اليوم</button></h3>${entriesTable(es, { emptyMsg: 'لم يبدأ الطالب بتسجيل متابعته بعد' })}</div>`;
  return shell(`🎓 ${esc(st.name)}`, `<p class="muted small" style="margin:-.8rem 0 1rem">المعلم: ${t ? esc(t.name) : 'غير محدد'} · @${esc(st.username)}${st.phone ? ' · ' + esc(st.phone) : ''}</p>${body}`,
    `<button class="btn sm" data-nav="students">↩ رجوع</button>`);
}

// ================= لوحة المشرف / المعلم: مكوّنات =================
function leaderboard(list) {
  const from = addDays(today(), -29);
  const rows = list.map(s => ({ s, st: stats(entriesOf(s.id), from) })).sort((a, b) => (b.st.newA + b.st.revA / 2) - (a.st.newA + a.st.revA / 2)).slice(0, 5);
  if (!rows.length || !rows[0].st.days) return empty('🏆', 'ستظهر هنا قائمة المتميزين');
  const max = Math.max(1, rows[0].st.newA);
  return rows.map((r, i) => `<div class="rank"><div class="n">${i + 1}</div><div class="grow"><b data-open="${r.s.id}" style="cursor:pointer">${esc(r.s.name)}</b>
    <div class="bar"><i style="width:${Math.round(r.st.newA / max * 100)}%"></i></div></div><div class="small muted">${r.st.newA} آية</div></div>`).join('');
}
function todayBoard(list) {
  const d = today(), rows = list.map(s => ({ s, e: entriesOf(s.id).find(x => x.date === d) }));
  const c = { present: 0, absent: 0, excused: 0, none: 0 };
  rows.forEach(r => c[r.e?.attendance || 'none']++);
  return `<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.7rem">${['present', 'excused', 'absent', 'none'].map(k => `<span class="pill ${k}">${ATT[k] || 'لم يُسجّل'}: ${c[k]}</span>`).join('')}</div>` +
    (rows.length ? rows.filter(r => !r.e?.attendance).slice(0, 6).map(r => `<div class="rank"><div class="grow" data-open="${r.s.id}" style="cursor:pointer">${esc(r.s.name)}</div><span class="pill none">لم يُسجّل</span></div>`).join('') || '<p class="muted small">🎉 الجميع سجّل حضوره اليوم</p>' : '');
}
function weeklyAll(list) {
  const ids = new Set(list.map(s => s.id)); return dailyData(S.entries.filter(e => ids.has(e.studentId)), 14);
}
const studentRow = (s, admin) => {
  const st = stats(entriesOf(s.id)), t = userById(s.teacherId), td = entriesOf(s.id).find(e => e.date === today());
  return `<tr><td><b data-open="${s.id}" style="cursor:pointer;color:var(--accent)">${esc(s.name)}</b>${s.disabled ? ' <span class="pill absent">معطّل</span>' : ''}${s.annBlocked ? ' <span class="pill none" title="محجوب عن الإعلانات">🚫📢</span>' : ''}<div class="muted small">@${esc(s.username)}</div></td>
    <td>${t ? esc(t.name) : '<span class="muted">—</span>'}</td><td>${attPill(td?.attendance)}</td>
    <td>${st.rate}%<div class="bar" style="width:70px"><i style="width:${st.rate}%"></i></div></td><td>${st.newA}</td><td>${st.revA}</td><td>${stars(Math.round(st.avg))}</td>
    <td class="act">${admin ? `<button class="btn sm" data-u-edit="${s.id}">✏️</button><button class="btn sm danger" data-u-del="${s.id}">🗑️</button>` : (!s.teacherId ? `<button class="btn sm primary" data-claim="${s.id}">➕ ضمّه لحلقتي</button>` : `<button class="btn sm" data-open="${s.id}">فتح</button>`)}</td></tr>`;
};
function studentsTable(list, admin) {
  const q = (ctx.q || '').trim(), f = ctx.teacher || '';
  list = list.filter(s => (!q || s.name.includes(q) || s.username.includes(q)) && (!f || (f === 'none' ? !s.teacherId : s.teacherId === f)));
  return `<div class="toolbar no-print"><input id="q" data-keep placeholder="🔍 بحث بالاسم..." value="${esc(ctx.q || '')}">
    ${admin ? `<select id="tf"><option value="">كل المعلمين</option><option value="none" ${f === 'none' ? 'selected' : ''}>بدون معلم</option>${teachers().map(t => `<option value="${t.id}" ${f === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` : ''}</div>` +
    (list.length ? `<div class="tw"><table><thead><tr><th>الطالب</th><th>المعلم</th><th>اليوم</th><th>الحضور</th><th>حفظ</th><th>مراجعة</th><th>التقييم</th><th></th></tr></thead><tbody>${list.map(s => studentRow(s, admin)).join('')}</tbody></table></div>` : empty('🎓', 'لا يوجد طلاب'));
}

// ================= صفحات المشرف =================
const ADMIN = {
  dash() {
    const ss = students(), tt = teachers(), all = stats(S.entries), todayD = today();
    const td = S.entries.filter(e => e.date === todayD && e.attendance === 'present').length;
    const active = ss.filter(s => entriesOf(s.id).some(e => e.date >= addDays(todayD, -6))).length;
    const perT = tt.map(t => { const mine = ss.filter(s => s.teacherId === t.id), st = stats(S.entries.filter(e => mine.some(s => s.id === e.studentId)), addDays(todayD, -29)); return { t, n: mine.length, st }; });
    return shell('📊 لوحة تحكم المشرف', `
      <div class="grid">${statCard('🎓', ss.length, 'طالب')}${statCard('👨‍🏫', tt.length, 'معلم')}${statCard('✅', td, 'حاضر اليوم')}${statCard('📈', all.rate + '%', 'نسبة الحضور العامة')}
        ${statCard('📗', all.newA, 'آية حفظ (الإجمالي)')}${statCard('🔁', all.revA, 'آية مراجعة')}${statCard('⚡', active, 'طالب نشط هذا الأسبوع')}${statCard('📢', S.announcements.length, 'إعلان منشور')}</div>
      <div class="grid two"><div class="card"><h3>📈 الإنجاز اليومي — آخر 14 يومًا</h3>${barChart(weeklyAll(ss), ['حفظ جديد', 'مراجعة'])}</div>
        <div class="card"><h3>🗓️ توزيع الحضور (الكل)</h3>${donut(all)}</div></div>
      <div class="grid two"><div class="card"><h3>🏆 المتميزون (30 يومًا)</h3>${leaderboard(ss)}</div>
        <div class="card"><h3>🕒 حضور اليوم</h3>${todayBoard(ss)}</div></div>
      <div class="card"><h3>👨‍🏫 أداء المعلمين (30 يومًا)</h3>${perT.length ? `<div class="tw"><table><thead><tr><th>المعلم</th><th>الطلاب</th><th>نسبة الحضور</th><th>حفظ</th><th>مراجعة</th></tr></thead><tbody>
        ${perT.map(x => `<tr><td><b>${esc(x.t.name)}</b></td><td>${x.n}</td><td>${x.st.rate}%</td><td>${x.st.newA}</td><td>${x.st.revA}</td></tr>`).join('')}</tbody></table></div>` : empty('👨‍🏫', 'أضف معلمين من صفحة «المعلمون»')}</div>`);
  },
  students() {
    return shell('🎓 الطلاب', `<div class="card">${studentsTable(students(), true)}</div>`, `<button class="btn primary" data-u-add="student">➕ طالب</button>`);
  },
  teachers() {
    const tt = teachers();
    return shell('👨‍🏫 المعلمون', `<div class="card">${tt.length ? `<div class="tw"><table><thead><tr><th>المعلم</th><th>الجوال</th><th>الطلاب</th><th>آخر ظهور</th><th></th></tr></thead><tbody>
      ${tt.map(t => `<tr><td><b>${esc(t.name)}</b>${t.disabled ? ' <span class="pill absent">معطّل</span>' : ''}${t.annBlocked ? ' <span class="pill none">🚫📢</span>' : ''}<div class="muted small">@${esc(t.username)}</div></td><td dir="ltr" style="text-align:start">${esc(t.phone) || '—'}</td>
      <td>${students().filter(s => s.teacherId === t.id).length}</td><td class="small muted">${t.lastSeen ? fmtTime(t.lastSeen) : '—'}</td>
      <td class="act"><button class="btn sm" data-u-edit="${t.id}">✏️</button><button class="btn sm danger" data-u-del="${t.id}">🗑️</button></td></tr>`).join('')}</tbody></table></div>` : empty('👨‍🏫', 'لم تُضف معلمين بعد')}</div>`,
      `<button class="btn primary" data-u-add="teacher">➕ معلم</button>`);
  },
  ann() { return shell('📢 الإعلانات', `<div class="card">${annList()}</div>`, `<button class="btn primary" data-ann-new>➕ إعلان جديد</button>`); },
  settings() {
    return shell('⚙️ الإعدادات', `<div class="grid two"><div>
      <div class="card"><h3>🏷️ بيانات التطبيق</h3><form id="setf"><div class="field"><label>اسم التطبيق / الحلقة</label><input name="appName" value="${esc(S.settings.appName)}" maxlength="40"></div>
        <div class="field"><label>عبارة الترحيب</label><input name="welcome" value="${esc(S.settings.welcome)}" maxlength="200"></div><button class="btn primary">حفظ</button></form></div>
      ${accountCard()}</div><div>${themeCard()}
      <div class="card"><h3>💾 نسخة احتياطية</h3><p class="muted small" style="margin-bottom:.6rem">حمّل نسخة من جميع البيانات (الطلاب، السجلات، الإعلانات).</p><button class="btn" data-backup>⬇️ تنزيل نسخة JSON</button></div></div></div>`);
  },
};
function userForm(role, u) {
  const isNew = !u;
  modal(isNew ? (role === 'teacher' ? 'إضافة معلم' : 'إضافة طالب') : 'تعديل: ' + esc(u.name), `
    <div class="field"><label>الاسم الكامل</label><input name="name" value="${esc(u?.name)}" required></div>
    ${isNew ? `<div class="field"><label>اسم المستخدم (إنجليزي)</label><input name="username" required dir="ltr" style="text-align:start"></div>` : ''}
    <div class="field"><label>${isNew ? 'كلمة المرور' : 'كلمة مرور جديدة (اتركها فارغة بدون تغيير)'}</label><input name="password" type="text" ${isNew ? 'required' : ''} minlength="6" dir="ltr" style="text-align:start" autocomplete="off"></div>
    <div class="row"><div class="field"><label>الجوال</label><input name="phone" value="${esc(u?.phone)}" dir="ltr" style="text-align:start"></div>
    ${role === 'student' ? `<div class="field"><label>المعلم</label><select name="teacherId"><option value="">— بدون —</option>${teachers().map(t => `<option value="${t.id}" ${u?.teacherId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>` : ''}</div>
    ${isNew ? '' : `<label class="check"><input type="checkbox" name="annBlocked" ${u.annBlocked ? 'checked' : ''}>🚫 حجب الإعلانات عن هذا الشخص</label>
    <label class="check"><input type="checkbox" name="disabled" ${u.disabled ? 'checked' : ''}>⛔ تعطيل الحساب (منع الدخول)</label>`}`,
    d => {
      if (isNew) return api('users', 'POST', { ...d, role }).then(() => toast('تمت الإضافة ✅'));
      const body = { name: d.name, phone: d.phone, annBlocked: d.annBlocked, disabled: d.disabled };
      if (role === 'student') body.teacherId = d.teacherId || null;
      if (d.password) body.password = d.password;
      return api('users/' + u.id, 'PUT', body).then(() => toast('تم التحديث ✅'));
    });
}
function accountCard() {
  return `<div class="card"><h3>👤 حسابي</h3><form id="proff"><div class="field"><label>الاسم</label><input name="name" value="${esc(S.me.name)}" required></div>
    <div class="field"><label>الجوال</label><input name="phone" value="${esc(S.me.phone)}" dir="ltr" style="text-align:start"></div>
    ${S.me.role === 'student' ? `<div class="row"><div class="field"><label>هدفي الأسبوعي (آيات حفظ)</label><input type="number" min="0" name="goal" value="${S.me.goal || ''}"></div>
    <div class="field"><label>معلمي</label><select name="teacherId"><option value="">— غير محدد —</option>${teachers().map(t => `<option value="${t.id}" ${S.me.teacherId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div></div>` : ''}
    <button class="btn primary">حفظ</button></form>
    <hr style="border:0;border-top:1px solid var(--border);margin:1rem 0"><form id="passf"><h4 style="margin-bottom:.5rem">🔑 تغيير كلمة المرور</h4>
    <div class="row"><div class="field"><label>الحالية</label><input type="password" name="old" required></div><div class="field"><label>الجديدة</label><input type="password" name="new" required minlength="6"></div></div>
    <button class="btn">تغيير</button></form></div>`;
}

// ================= صفحات المعلم =================
const TEACHER = {
  dash() {
    const mine = students().filter(s => s.teacherId === S.me.id), es = S.entries, all = stats(es), free = students().filter(s => !s.teacherId).length;
    return shell('📊 لوحة المعلم', `
      <div class="grid">${statCard('🎓', mine.length, 'طالب في حلقتي')}${statCard('✅', es.filter(e => e.date === today() && e.attendance === 'present').length, 'حاضر اليوم')}
        ${statCard('📈', all.rate + '%', 'نسبة الحضور')}${statCard('📗', all.newA, 'آية حفظ')}${statCard('🔁', all.revA, 'آية مراجعة')}${free ? statCard('🆕', free, 'طالب بلا معلم') : ''}</div>
      <div class="grid two"><div class="card"><h3>📈 آخر 14 يومًا</h3>${barChart(weeklyAll(mine), ['حفظ جديد', 'مراجعة'])}</div><div class="card"><h3>🗓️ الحضور</h3>${donut(all)}</div></div>
      <div class="grid two"><div class="card"><h3>🏆 المتميزون (30 يومًا)</h3>${leaderboard(mine)}</div><div class="card"><h3>🕒 حضور اليوم</h3>${todayBoard(mine)}</div></div>`);
  },
  students() {
    const mine = students().filter(s => s.teacherId === S.me.id), free = students().filter(s => !s.teacherId);
    return shell('🎓 طلابي', `<div class="card">${studentsTable(mine, false)}</div>
      ${free.length ? `<div class="card"><h3>🆕 طلاب بلا معلم</h3>${studentsTable(free, false)}</div>` : ''}`);
  },
  ann() { return shell('📢 الإعلانات', `<div class="card">${annList()}</div>`); },
  settings() { return shell('⚙️ حسابي', `<div class="grid two">${accountCard()}${themeCard()}</div>`); },
};

// ================= صفحات الطالب =================
const STUDENT = {
  dash() {
    const es = entriesOf(S.me.id), all = stats(es), w = stats(es, addDays(today(), -6)), td = es.find(e => e.date === today());
    const t = userById(S.me.teacherId), goal = S.me.goal;
    const done = td?.attendance === 'present';
    return shell(`السلام عليكم، ${esc(S.me.name.split(' ')[0])} 👋`, `
      <p class="muted" style="margin:-.8rem 0 1rem">${esc(S.settings.welcome)}${t ? ` · معلمك: ${esc(t.name)}` : ' · لم يُحدَّد لك معلم بعد (من «حسابي»)'}</p>
      <div class="checkin"><div class="t"><h3>${done ? '✅ تم تحضيرك اليوم' : '🕌 حضّر نفسك اليوم'}</h3><span>${fmtDay(today())}</span></div>
        ${done ? `<button class="btn" data-checkin="absent">تراجع</button>` : `<button class="btn" data-checkin="present">أنا حاضر ✋</button><button class="btn" data-checkin="excused" style="background:transparent;color:inherit;border:1px solid #fff8">معتذر</button>`}
        <button class="btn" data-e-new style="background:transparent;color:inherit;border:1px solid #fff8">📝 سجّل حفظي</button></div>
      <div class="grid">${statCard('🔥', streak(es), 'أيام حضور متتالية')}${statCard('✅', all.rate + '%', 'نسبة حضوري')}${statCard('📗', all.newA, 'آية حفظ جديد')}${statCard('🔁', all.revA, 'آية مراجعة')}${statCard('⭐', all.avg ? all.avg.toFixed(1) + '/5' : '—', 'متوسط تقييمي')}</div>
      ${goal ? `<div class="card"><h3>🎯 هدف الأسبوع</h3><div class="bar"><i style="width:${Math.min(100, Math.round(w.newA / goal * 100))}%"></i></div><p class="small muted" style="margin-top:.4rem">حفظت ${w.newA} من ${goal} آية خلال آخر 7 أيام (${Math.min(100, Math.round(w.newA / goal * 100))}%)</p></div>` : ''}
      <div class="grid two"><div class="card"><h3>📈 إنجازي — آخر 14 يومًا</h3>${barChart(dailyData(es, 14), ['حفظ جديد', 'مراجعة'])}</div><div class="card"><h3>🗓️ حضوري</h3>${donut(all)}</div></div>
      ${S.announcements.length ? `<div class="card"><h3>📢 آخر الإعلانات <span class="spacer"></span><button class="btn sm" data-nav="ann">الكل</button></h3>${S.announcements.slice(0, 2).map(a => `<div class="ann ${a.important ? 'important' : ''}"><h4>${esc(a.title)}</h4><p>${esc(a.body)}</p></div>`).join('')}</div>` : ''}`);
  },
  table() {
    const es = entriesOf(S.me.id), m = ctx.month || '';
    const list = m ? es.filter(e => e.date.startsWith(m)) : es;
    const months = [...new Set(es.map(e => e.date.slice(0, 7)))].sort().reverse();
    return shell('📋 جدول متابعتي', `<div class="card"><div class="toolbar no-print"><select id="mf"><option value="">كل الشهور</option>${months.map(x => `<option ${m === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <button class="btn" data-csv="${S.me.id}">⬇️ CSV</button><button class="btn" onclick="print()">🖨️ طباعة</button></div>
      ${entriesTable(list, { student: true, emptyMsg: 'ابدأ بتسجيل أول يوم في جدولك بزر «➕ سجل جديد»' })}</div>
      <p class="muted small">💡 ما تسجّله هنا يظهر مباشرة لمعلمك وللمشرف، ويستطيع المعلم إضافة تقييمه وملاحظاته.</p>`,
      `<button class="btn primary" data-e-new>➕ سجل جديد</button>`);
  },
  ann() { return shell('📢 الإعلانات', `<div class="card">${annList()}</div>`); },
  settings() { return shell('⚙️ حسابي', `<div class="grid two">${accountCard()}${themeCard()}</div>`); },
};

// ================= الأحداث (تفويض) =================
document.addEventListener('click', e => {
  const t = e.target.closest('button,[data-open],[data-accent]'); if (!t || !S) return;
  const d = t.dataset;
  if (d.nav) return go(d.nav);
  if (d.open) return go('student', { studentId: d.open });
  if (d.themeMode) { setTheme({ mode: d.themeMode }); return render(); }
  if (d.accent) { setTheme({ accent: d.accent }); return render(); }
  if (d.themeSize) { setTheme({ size: +d.themeSize }); return render(); }
  if (t.hasAttribute('data-toggle-dark')) { setTheme({ mode: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }); return render(); }
  if (t.hasAttribute('data-logout')) { api('logout', 'POST').catch(() => { }); token = ''; localStorage.removeItem('token'); S = null; return renderAuth(); }
  if (d.uAdd) return userForm(d.uAdd);
  if (d.uEdit) { const u = userById(d.uEdit); return userForm(u.role, u); }
  if (d.uDel) { const u = userById(d.uDel); return confirmBox(`حذف «${esc(u.name)}» نهائيًا مع كل سجلاته؟`, () => api('users/' + u.id, 'DELETE')); }
  if (d.claim) return act(() => api('users/' + d.claim, 'PUT', { teacherId: S.me.id }), 'ضُمّ الطالب إلى حلقتك');
  if (t.hasAttribute('data-ann-new')) return annForm();
  if (d.annEdit) return annForm(S.announcements.find(a => a.id === d.annEdit));
  if (d.annDel) return confirmBox('حذف هذا الإعلان؟', () => api('announcements/' + d.annDel, 'DELETE'));
  if (t.hasAttribute('data-e-new')) return studentEntryForm();
  if (d.eEdit) return studentEntryForm(d.eEdit);
  if (d.eDel) return confirmBox('حذف هذا السجل؟', () => api('entries/' + d.eDel, 'DELETE'));
  if (d.tEdit) return teacherEntryForm(ctx.studentId, d.tEdit);
  if (d.csv) return csvExport(userById(d.csv));
  if (d.checkin) return act(() => api('entries', 'POST', { date: today(), attendance: d.checkin, checkin: d.checkin === 'present' }),
    d.checkin === 'present' ? 'تقبّل الله، تم تحضيرك ✅' : d.checkin === 'excused' ? 'تم تسجيل اعتذارك' : 'تم التراجع');
  if (t.hasAttribute('data-backup')) return api('backup').then(j => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' }));
    a.download = `maeen-backup-${today()}.json`; a.click();
  }).catch(err => toast(err.message, true));
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { ctx.q = e.target.value; const pos = e.target.selectionStart; render(); const q = $('#q'); q?.focus(); q?.setSelectionRange(pos, pos); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'tf') { ctx.teacher = e.target.value; render(); }
  if (e.target.id === 'mf') { ctx.month = e.target.value; render(); }
});
document.addEventListener('submit', e => {
  const f = e.target, d = Object.fromEntries(new FormData(f));
  if (f.id === 'setf') { e.preventDefault(); act(() => api('settings', 'PUT', d), 'تم الحفظ ✅'); }
  if (f.id === 'proff') { e.preventDefault(); act(() => api('profile', 'PUT', d), 'تم الحفظ ✅'); }
  if (f.id === 'passf') { e.preventDefault(); act(async () => { await api('password', 'POST', d); f.reset(); }, 'تم تغيير كلمة المرور ✅'); }
});

applyTheme();
boot();
