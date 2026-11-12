// Імітація середовища Google Apps Script + Telegram для перевірки navbot_bot.gs
const fs = require('fs'), crypto = require('crypto'), vm = require('vm');
const TOKEN = '123456:TEST_TOKEN', ADMIN = '1000';
let calls = []; let blocked = new Set(); let mid = 500;
class Range { constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
  getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push((this.sh.d[this.r - 1 + i] || [])[this.c - 1 + j] ?? ''); o.push(row); } return o; }
  getValue() { return this.getValues()[0][0]; }
  setValue(v) { const row = this.sh.d[this.r - 1] || (this.sh.d[this.r - 1] = []); row[this.c - 1] = typeof v === 'string' && v[0] === "'" ? v.slice(1) : v; return this; }
  setValues(vs) { vs.forEach((row, i) => row.forEach((v, j) => new Range(this.sh, this.r + i, this.c + j).setValue(v))); return this; }
  setFontWeight() { return this; } }
class Sheet { constructor(n) { this.n = n; this.d = []; }
  appendRow(r) { this.d.push(r.map(v => typeof v === 'string' && v[0] === "'" ? v.slice(1) : v)); }
  getLastRow() { return this.d.length; } getRange(a, b, c, d) { if (typeof a === 'string') { const m = a.match(/([A-Z])(\d+)/); return new Range(this, +m[2], m[1].charCodeAt(0) - 64); } return new Range(this, a, b, c, d); }
  setFrozenRows() {} deleteRow(r) { this.d.splice(r - 1, 1); } deleteRows(r, n) { this.d.splice(r - 1, n); } }
const sheets = {};
const props = { TG_TOKEN: TOKEN, TG_ADMIN_ID: ADMIN, CF_KEY: 'secret', PROXY_URL: 'https://navbot.test.workers.dev' };
const cache = {};
const ctx = {
  console, JSON, Date, Math, String, Number, Object, Array, RegExp, Error,
  SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new Sheet(n)) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); },
    deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { createTextOutput: t => t },
  Utilities: {
    formatDate: (d, tz, f) => { const z = new Date(d.getTime() + (globalThis.__nightShift || 0)); const p = n => String(n).padStart(2, '0');
      return f.replace('yyyy', z.getUTCFullYear()).replace('MM', p(z.getUTCMonth() + 1)).replace('dd', p(z.getUTCDate())).replace('HH', p((z.getUTCHours() + 2) % 24)).replace('mm', p(z.getUTCMinutes())).replace(/^H$/, String((z.getUTCHours() + 2) % 24)); },
    sleep() {}, newBlob: s => ({ getBytes: () => [...Buffer.from(s, 'utf8')].map(b => b > 127 ? b - 256 : b) }),
    MacAlgorithm: { HMAC_SHA_256: 'sha256' },
    computeHmacSignature: (alg, value, key) => [...crypto.createHmac('sha256', Buffer.from(key.map(b => (b + 256) % 256))).update(Buffer.from(value.map(b => (b + 256) % 256))).digest()].map(b => b > 127 ? b - 256 : b),
  },
  UrlFetchApp: {
    fetch: (url, o) => tg(url, o), fetchAll: reqs => reqs.map(r => tg(r.url, r)),
  },
};
function tg(url, o) {
  const method = url.split('/').pop(); const p = JSON.parse(o.payload || '{}'); calls.push({ method, p });
  const code = p.chat_id && blocked.has(String(p.chat_id)) ? 403 : 200;
  const body = code === 200 ? { ok: true, result: { message_id: ++mid } } : { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' };
  return { getResponseCode: () => code, getContentText: () => JSON.stringify(body) };
}
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[2] || require('path').join(__dirname, '../../bot/navbot_bot.gs'), 'utf8') + '\n;this.__api={doPost,handleUpdate_,subs_,subsText_,activityText_,verifyInitData_};', ctx);
const api = ctx.__api;
let uid = 1;
// через посередника: оновлення загорнуте в { tg, key }; позначки з навігатора — як є
const post = u => api.doPost({ postData: { contents: JSON.stringify(u.app_event !== undefined ? u : { tg: Object.assign({ update_id: uid++ }, u), key: 'secret' }) } });
const postRaw = obj => api.doPost({ postData: { contents: JSON.stringify(obj) } });
const msg = (from, extra) => post({ message: Object.assign({ message_id: 1000 + uid, chat: Object.assign({ type: 'private' }, from) }, extra) });
const sent = (filter) => calls.filter(filter);
const reset = () => { calls = []; };
function initData(user, ageSec) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000) - (ageSec || 0)), query_id: 'AAE', user: JSON.stringify(user) };
  const dcs = Object.keys(fields).sort().map(k => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.entries(fields).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') + '&hash=' + hash;
}
module.exports = { api, post, postRaw, msg, sent, reset, initData, sheets, props, blocked, ADMIN, get calls() { return calls; } };
