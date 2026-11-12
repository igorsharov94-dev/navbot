/**
 * Навігатор без GPS — Telegram-бот на Google Apps Script (як «ЛМ10 Світло»)
 *
 *  • Збирає користувачів: «Старт» у боті → лист «Підписники».
 *    Ті, хто відкрив навігатор, теж позначаються (через посередника Cloudflare, з перевіркою підпису Telegram).
 *  • Розсилки від адміна: /post текст, фото чи відео з підписом «/post текст»; /undo — видалити помилкову (до 48 год).
 *  • «✉️ Написати нам»: людина пише в бот → повідомлення приходить адміну → адмін робить Reply → відповідь іде людині.
 *  • Уночі (23:00–07:00) розсилки приходять без звуку. Хто заблокував бота — автоматично видаляється зі списку.
 *
 * Властивості скрипта (Налаштування проєкту → Властивості скрипта):
 *   TG_TOKEN     – токен бота від @BotFather
 *   TG_ADMIN_ID  – ваш особистий ID (дізнатися: напишіть боту /id)
 *   WEBAPP_URL   – адреса цього веб-застосунку (…/exec), після «Розгорнути»
 *   PROXY_URL    – адреса посередника Cloudflare (…workers.dev) — рекомендовано
 *   CF_KEY       – секретний ключ (той самий, що SEND_KEY у Cloudflare)
 *   BROADCAST_VIA_CF – 1, щоб розсилати через Cloudflare (швидше, не витрачає ліміт Google)
 *
 * Запуск: setup() → «Розгорнути» як веб-застосунок (доступ: усі) → connectWebhook().
 */

/****************** НАЛАШТУВАННЯ ******************/
const CFG = {
  TZ: 'Europe/Kiev',
  NAME: 'Навігатор без GPS',
  BOT_URL: 'https://t.me/kyiv_nav2026_bot',
  APP_URL: 'https://igorsharov94-dev.github.io/navbot/',
  SUBS_SHEET: 'Підписники',
  NIGHT_FROM: 23, NIGHT_TO: 7,          // уночі розсилки — без звуку
};
/**************************************************/

// ===== 1. Запустити один раз: створює листи =====
function setup() {
  subsSheet_(); fbSheet_(); logSheet_();
  const p = PropertiesService.getScriptProperties();
  ['TG_TOKEN', 'TG_ADMIN_ID'].forEach(k => { if (!(p.getProperty(k) || '').trim()) console.warn('Додайте властивість ' + k); });
  console.log('Листи створено. Далі: «Розгорнути» → «Нове розгортання» → Веб-застосунок (доступ: усі), ' +
    'впишіть адресу у WEBAPP_URL (або PROXY_URL посередника) і запустіть connectWebhook().');
}

// Перевірка: надсилає адміну тестове повідомлення
function test() {
  const admin = adminId_();
  if (!admin) throw new Error('Задайте TG_ADMIN_ID');
  console.log('Telegram: ' + send_(admin, '✅ Бот навігатора працює. Підписників: ' + subs_().length));
}

// ===== Вебхук =====
function doPost(e) {
  try {
    let u = JSON.parse(e.postData.contents);
    const k = (prop_('CF_KEY') || '').trim();
    // через посередника: оновлення Telegram загорнуте в { tg, key } — чужі запити (без ключа) ігноруємо
    if (u.tg !== undefined) {
      if (!k || u.key !== k) return ContentService.createTextOutput('forbidden');
      u = u.tg;
    } else if ((prop_('PROXY_URL') || '').trim() && u.app_event === undefined) {
      return ContentService.createTextOutput('forbidden');   // є посередник, а запит прийшов напряму — підробка
    }
    // позначка з міні-застосунку (переслав посередник; підпис Telegram перевіряємо тут)
    if (u.app_event !== undefined) {
      if (k && u.key === k) appEvent_(u.app_event, u.init_data);
      return ContentService.createTextOutput('ok');
    }
    const cache = CacheService.getScriptCache();
    const key = 'u' + u.update_id;
    if (!cache.get(key)) { // Telegram може повторити запит — не відповідаємо двічі
      cache.put(key, '1', 21600);
      try { handleUpdate_(u); }
      catch (err) { cache.remove(key); throw err; }
    }
  } catch (err) { console.error('doPost: ' + err); }
  return ContentService.createTextOutput('ok');
}

function connectWebhook() {
  const url = (prop_('PROXY_URL') || prop_('WEBAPP_URL') || '').trim();
  if (!/^https:\/\//.test(url)) throw new Error('Впишіть PROXY_URL (…workers.dev) або WEBAPP_URL (…/exec)');
  const proxy = !!(prop_('PROXY_URL') || '').trim(), key = (prop_('CF_KEY') || '').trim();
  if (proxy && !/^[A-Za-z0-9_-]{16,256}$/.test(key)) throw new Error('CF_KEY: щонайменше 16 латинських літер/цифр');
  // секрет у заголовку — посередник пропускає лише справжні запити Telegram
  const r = tgCall_('setWebhook', Object.assign({ url: url, allowed_updates: ['message', 'callback_query'] }, proxy ? { secret_token: key } : {}));
  if (!r.ok) throw new Error(r.description);
  setCommands_();
  console.log('Готово: бот відповідає миттєво.');
}

function disconnectWebhook() { console.log(JSON.stringify(tgCall_('deleteWebhook', {}))); }
function webhookInfo() { console.log(JSON.stringify(tgCall_('getWebhookInfo', {}))); }

// ===== Обробка повідомлень =====
// текст кнопки без емодзі й пробілів → команда
const BUTTONS = { 'написатинам': 'write', 'яккористуватися': 'help', 'допомога': 'help', 'підписники': 'subs' };

function handleUpdate_(u) {
  if (u.callback_query) {
    const d = u.callback_query.data || '';
    return /^f/.test(d) ? fbCallback_(u.callback_query) : /^u/.test(d) ? undoCallback_(u.callback_query)
      : tgCall_('answerCallbackQuery', { callback_query_id: u.callback_query.id });
  }
  const m = u.message;
  if (!m || m.chat.type !== 'private') return;
  const id = String(m.chat.id);
  const isAdmin = id === adminId_();
  const capOrText = m.caption || m.text || '';

  // адмін відповідає на звернення: Reply на повідомлення від бота
  if (isAdmin && m.reply_to_message && !/^\/post\b/i.test(capOrText) && fbReply_(m)) return;

  // оголошення з фото / відео: адмін надсилає медіа з підписом «/post текст»
  if (isAdmin && /^\/post\b/i.test(m.caption || '') && (m.photo || m.video || m.animation)) {
    const cap = (m.caption || '').replace(/^\/post(@\S+)?\s*/i, '');
    const html = cap ? '📢 ' + esc_(cap) : '';
    const n = m.photo ? broadcastMedia_('sendPhoto', 'photo', m.photo[m.photo.length - 1].file_id, html, 'Фото')
      : m.video ? broadcastMedia_('sendVideo', 'video', m.video.file_id, html, 'Відео')
      : broadcastMedia_('sendAnimation', 'animation', m.animation.file_id, html, 'GIF');
    return send_(id, '✅ Розіслано: ' + n + ' підписникам.', false, keyboardFor_(id));
  }

  // режим «Написати нам»: наступне повідомлення (текст, фото, голос…) іде адміну
  const plainBtn = (m.text || '').toLowerCase().replace(/[^\p{L}]/gu, '');
  if (CacheService.getScriptCache().get('fb_' + id) && !/^\//.test(m.text || '') && !BUTTONS[plainBtn]) return fbSend_(m);
  if (!m.text) return;

  const text = m.text.trim();
  const word = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const cmd = word.startsWith('/') ? word.slice(1) : BUTTONS[plainBtn] || '';
  CacheService.getScriptCache().remove('fb_' + id); // будь-яка команда скасовує «Написати нам»
  if (!isAdmin && cmd !== 'stop') { touchUser_(m.chat, 'bot'); stat_('b', cmd || 'text'); }
  const reply = msg => send_(id, msg, false, keyboardFor_(id));
  const adminOnly = () => { if (!isAdmin) reply('⛔ Ця команда лише для адміністратора.'); return isAdmin; };

  if (cmd === 'start') {
    const payload = text.split(/\s+/)[1] || '';
    const isNew = addSub_(m.chat, payload === 'write' ? 'app' : 'start');
    if (isNew) stat_('n', 'start');
    if (payload === 'write') return fbStart_(id);
    send_(id, '🚗 <b>' + esc_(CFG.NAME) + '</b>\n\n' +
      'Веде маршрутом, навіть коли під час тривоги GPS глушать або підміняють: фальшиві координати відкидаються, ' +
      'а положення рахується за поворотами, вигинами дороги, зупинками й світлофорами.\n\n' +
      '<b>Як почати:</b>\n1. Натисніть «🗺 Відкрити навігатор».\n2. Дозвольте геопозицію, натисніть ⚙ і перевірте датчики (один раз).\n' +
      '3. Телефон — у тримач. Введіть адресу → «Поїхали».\n\n' +
      'Новини й оновлення навігатора приходитимуть сюди. ✉️ Питання чи ідея — «Написати нам».',
      false, { inline_keyboard: [[{ text: '🗺 Відкрити навігатор', web_app: { url: CFG.APP_URL } }]] });
    send_(id, 'Кнопки — внизу 👇', true, keyboardFor_(id));
  } else if (cmd === 'write') {
    fbStart_(id);
  } else if (cmd === 'help') {
    reply('❓ <b>Як користуватися</b>\n\n' +
      '• Будуйте маршрут, <b>поки GPS ще працює</b> — навігатор запамʼятає вашу швидкість.\n' +
      '• Телефон — у тримачі, не згортайте навігатор і не вимикайте екран.\n' +
      '• Без GPS: «Проїхав поворот», «Я тут», швидкість «−/+».\n' +
      '• ⚙ у навігаторі — перевірка датчиків, точність і 📄 журнал поїздки.\n' +
      '• Повна інструкція — кнопка ❓ у навігаторі.' + footer_());
  } else if (cmd === 'stop') {
    removeSub_(id); stat_('n', 'stop');
    send_(id, '🔕 Ви відписалися від новин. Навігатор працює й далі. Повернутися — /start', false, { remove_keyboard: true });
  } else if (cmd === 'id') {
    reply('Ваш ID: <code>' + id + '</code>');
  } else if (cmd === 'post') {
    if (!adminOnly()) return;
    const msg = text.replace(/^\/post(@\S+)?\s*/i, '');
    if (!msg) return reply('Напишіть так: /post Текст оголошення\nАбо надішліть фото чи відео з підписом «/post текст».');
    reply('✅ Розіслано: ' + broadcast_('📢 ' + esc_(msg)) + ' підписникам.');
  } else if (cmd === 'reply') {
    if (!adminOnly()) return;
    const mm = text.match(/^\/reply(?:@\S+)?\s+(\d+)\s+([\s\S]+)/);
    if (!mm) return reply('Напишіть так: /reply ID текст\n(або просто зробіть Reply на звернення)');
    reply(fbAnswer_(mm[1], mm[2]) ? '✅ Відповідь надіслано.' : '⚠️ Не вдалося доставити — можливо, людина заблокувала бота.');
  } else if (cmd === 'subs') {
    if (!adminOnly()) return;
    reply(subsText_());
  } else if (cmd === 'activity') {
    if (!adminOnly()) return;
    reply(activityText_());
  } else if (cmd === 'undo') {
    if (!adminOnly()) return;
    undoMenu_(id);
  } else if (cmd === 'admin') {
    if (!adminOnly()) return;
    reply('🛠 <b>Команди адміністратора</b>\n\n' +
      '/post текст — розіслати оголошення всім\n' +
      'Фото чи відео з підписом «/post текст» — розіслати медіа\n' +
      '/undo — видалити помилкову розсилку в усіх (до 48 год)\n' +
      '/subs — підписники\n' +
      '/activity — нові користувачі, відкриття навігатора, звернення\n' +
      'Відповісти на звернення — Reply на нього або /reply ID текст\n' +
      '/id — ваш ID');
  } else {
    reply('Натисніть «🗺 Відкрити навігатор» внизу 👇\n✉️ Питання чи ідея — «Написати нам».');
  }
}

// ===== Кнопки й меню =====
function keyboard_() {
  return {
    keyboard: [[{ text: '🗺 Відкрити навігатор', web_app: { url: CFG.APP_URL } }],
      [{ text: '✉️ Написати нам' }, { text: '❓ Як користуватися' }]],
    resize_keyboard: true, is_persistent: true,
  };
}
function keyboardFor_(id) {
  const kb = keyboard_();
  if (id === adminId_()) kb.keyboard.push([{ text: '👥 Підписники' }]);
  return kb;
}

function setCommands_() {
  tgCall_('setMyCommands', { commands: [
    { command: 'start', description: 'Відкрити навігатор' },
    { command: 'help', description: '❓ Як користуватися' },
    { command: 'write', description: '✉️ Написати нам' },
    { command: 'stop', description: 'Відписатися від новин' },
  ] });
  const admin = adminId_();
  if (admin) tgCall_('setMyCommands', { scope: { type: 'chat', chat_id: Number(admin) }, commands: [
    { command: 'post', description: '👑 Розіслати оголошення' },
    { command: 'undo', description: '👑 Видалити помилкову розсилку' },
    { command: 'subs', description: '👑 Підписники' },
    { command: 'activity', description: '👑 Активність' },
    { command: 'admin', description: '👑 Усі команди адміна' },
    { command: 'start', description: 'Відкрити навігатор' },
  ] });
  tgCall_('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Навігатор', web_app: { url: CFG.APP_URL } } });
}

// ===== Підписники (лист «Підписники») =====
// A ID | B Імʼя | C Username | D Дата підписки | E Джерело | F Остання активність | G Відкрив навігатор | H Можна писати
function subsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CFG.SUBS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CFG.SUBS_SHEET);
    sh.appendRow(['ID', 'Імʼя', 'Username', 'Дата підписки', 'Джерело', 'Остання активність', 'Відкрив навігатор', 'Можна писати']);
    sh.setFrozenRows(1);
    sh.getRange('A1:H1').setFontWeight('bold');
  }
  return sh;
}

function subsRows_() {
  const sh = subsSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().map((r, i) => ({ row: i + 2, id: String(r[0]), r: r }));
}

// кому можна розсилати: натиснули «Старт» або дозволили боту писати з навігатора
function subs_() {
  return subsRows_().filter(x => x.id && String(x.r[7]) !== '0').map(x => x.id);
}

// додає людину; повертає true, якщо новий
function addSub_(u, source, canWrite) {
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const me = subsRows_().find(x => x.id === String(u.id));
    const now = Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM.yyyy HH:mm');
    const sh = subsSheet_();
    if (me) {
      if (canWrite !== false && String(me.r[7]) === '0') sh.getRange(me.row, 8).setValue(1);
      return false;
    }
    // дати пишемо як текст ('…), щоб таблиця не перетворювала їх на свій формат
    sh.appendRow(["'" + u.id, [u.first_name, u.last_name].filter(Boolean).join(' '), u.username ? '@' + u.username : '',
      "'" + now, source, "'" + Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'), source === 'app' ? "'" + now : '', canWrite === false ? 0 : 1]);
    return true;
  } finally { lock.releaseLock(); }
}

function removeSub_(id) {
  const me = subsRows_().find(x => x.id === String(id));
  if (me) subsSheet_().deleteRow(me.row);
}

// остання активність — не частіше разу на 6 год на людину
function touchUser_(u, how) {
  try {
    const cache = CacheService.getScriptCache(), ck = 'act_' + u.id + how;
    if (cache.get(ck)) return;
    cache.put(ck, '1', 21600);
    const me = subsRows_().find(x => x.id === String(u.id));
    if (!me) return;
    const sh = subsSheet_();
    sh.getRange(me.row, 6).setValue("'" + Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd'));
    if (how === 'app') sh.getRange(me.row, 7).setValue("'" + Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM.yyyy HH:mm'));
  } catch (e) { console.error('touch: ' + e); }
}

function subsText_() {
  const rows = subsRows_();
  if (!rows.length) return '👥 Підписників поки немає.';
  const can = rows.filter(x => String(x.r[7]) !== '0').length;
  const app = rows.filter(x => x.r[6]).length;
  const last = rows.slice(-5).reverse().map(x => '• ' + esc_(x.r[1] || 'без імені') + (x.r[2] ? ' ' + esc_(x.r[2]) : '') +
    ' — ' + esc_(fmtCell_(x.r[3])) + (x.r[4] === 'app' ? ' (з навігатора)' : ''));
  return '👥 Користувачів: <b>' + rows.length + '</b>\n📬 Отримують розсилки: <b>' + can + '</b>\n🗺 Відкривали навігатор: <b>' + app +
    '</b>\n\nОстанні:\n' + last.join('\n');
}

// ===== Події з міні-застосунку (через посередника) =====
// event: 'open' — відкрили навігатор; 'write_ok' — дозволили боту писати
function appEvent_(event, initData) {
  const u = verifyInitData_(initData);
  if (!u) return console.warn('app: підпис Telegram не збігся');
  if (event === 'open') {
    stat_('a', 'open');
    const isNew = addSub_(u, 'app', false);   // писати можна лише після «Старт» або дозволу
    if (isNew) stat_('n', 'app');
    touchUser_(u, 'app');
  } else if (event === 'write_ok') {
    addSub_(u, 'app', true);
  }
}

// Перевірка initData за правилами Telegram: secret = HMAC_SHA256("WebAppData", token); hash = HMAC_SHA256(secret, рядок)
function verifyInitData_(initData) {
  if (!initData || typeof initData !== 'string') return null;
  const pairs = initData.split('&').map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1).replace(/\+/g, ' '))]; });
  const hash = (pairs.find(x => x[0] === 'hash') || [])[1];
  if (!hash) return null;
  const dcs = pairs.filter(x => x[0] !== 'hash').sort((a, b) => a[0] < b[0] ? -1 : 1).map(x => x[0] + '=' + x[1]).join('\n');
  const bytes = s => Utilities.newBlob(s).getBytes();
  const secret = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, bytes(prop_('TG_TOKEN').trim()), bytes('WebAppData'));
  const sig = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, bytes(dcs), secret);
  const hex = sig.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return null;
  const authDate = Number((pairs.find(x => x[0] === 'auth_date') || [])[1] || 0);
  if (Date.now() / 1000 - authDate > 86400) return null;   // старіше доби — не приймаємо
  try { return JSON.parse((pairs.find(x => x[0] === 'user') || [])[1]); } catch (e) { return null; }
}

// ===== Розсилки =====
function isNight_() {
  const h = Number(Utilities.formatDate(new Date(), CFG.TZ, 'H'));
  return h >= CFG.NIGHT_FROM || h < CFG.NIGHT_TO;
}

function footer_() {
  return '\n\n<a href="' + CFG.BOT_URL + '">🗺 ' + esc_(CFG.NAME) + '</a>';
}

function broadcast_(html) {
  const admin = adminId_();
  const base = { text: html + footer_(), parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: isNight_() };
  const r = massSend_(subs_().filter(x => x !== admin), 'sendMessage', Object.assign({ reply_markup: keyboard_() }, base));
  if (admin && tgCall_('sendMessage', Object.assign({ chat_id: admin, reply_markup: keyboardFor_(admin) }, base)).ok) r.n++;
  recordBroadcast_('Повідомлення', html, r);
  stat_('d', 'post', r.n);
  return r.n;
}

function broadcastMedia_(method, field, fileId, captionHtml, type) {
  const admin = adminId_();
  const base = { caption: (captionHtml || '') + footer_(), parse_mode: 'HTML', disable_notification: isNight_() };
  base[field] = fileId;
  const r = massSend_(subs_().filter(x => x !== admin), method, Object.assign({ reply_markup: keyboard_() }, base));
  if (admin && tgCall_(method, Object.assign({ chat_id: admin, reply_markup: keyboardFor_(admin) }, base)).ok) r.n++;
  recordBroadcast_(type, captionHtml || '(без підпису)', r);
  stat_('d', 'post', r.n);
  return r.n;
}

// Масова розсилка: через Cloudflare (BROADCAST_VIA_CF=1) або напряму пачками по 25. Повертає { n, blocked, sent }
const CF = { CHUNK: 40 };
function cfReady_() {
  return prop_('BROADCAST_VIA_CF') === '1' && !!(prop_('PROXY_URL') || '').trim() && !!(prop_('CF_KEY') || '').trim();
}
function cfCall_(ids, method, base, extra) {
  try {
    const r = UrlFetchApp.fetch(prop_('PROXY_URL').trim().replace(/\/+$/, '') + '/send', { method: 'post', contentType: 'application/json',
      muteHttpExceptions: true, payload: JSON.stringify({ key: prop_('CF_KEY').trim(), token: prop_('TG_TOKEN').trim(), method: method,
        ids: ids, payload: base, items: extra ? ids.map(id => Object.assign({ chat_id: id }, extra[id] || {})) : undefined }) });
    if (r.getResponseCode() !== 200) { console.error('Cloudflare ' + r.getResponseCode()); return null; }
    const j = JSON.parse(r.getContentText());
    return j && j.results ? j.results : null;
  } catch (e) { console.error('Cloudflare: ' + e); return null; }
}
function massSend_(ids, method, base, extra) {
  const out = { n: 0, blocked: [], sent: [] };
  ids = ids.filter(Boolean);
  let direct = ids;
  if (ids.length && cfReady_()) {
    direct = [];
    for (let i = 0; i < ids.length; i += CF.CHUNK) {
      const chunk = ids.slice(i, i + CF.CHUNK), res = cfCall_(chunk, method, base, extra);
      if (!res) { direct = direct.concat(chunk); continue; }
      const by = {}; res.forEach(x => { by[String(x.id)] = x; });
      chunk.forEach(id => {
        const x = by[id] || {};
        if (x.code === 200) { out.n++; if (x.mid) out.sent.push([id, x.mid]); }
        else if (x.code === 403) out.blocked.push(id);
        else if (x.code !== 400) direct.push(id);
      });
    }
  }
  for (let i = 0; i < direct.length; i += 25) {
    const batch = direct.slice(i, i + 25);
    const res = UrlFetchApp.fetchAll(batch.map(id => ({ url: tgUrl_(method), method: 'post', contentType: 'application/json',
      muteHttpExceptions: true, payload: JSON.stringify(Object.assign({ chat_id: id }, base, extra ? extra[id] : {})) })));
    res.forEach((r, j) => {
      const c = r.getResponseCode();
      if (c === 200) {
        out.n++;
        try { const mid = JSON.parse(r.getContentText()).result.message_id; if (mid) out.sent.push([batch[j], mid]); } catch (e) {}
      } else if (c === 403) out.blocked.push(batch[j]);
      else console.error('Telegram ' + batch[j] + ': ' + r.getContentText().slice(0, 200));
    });
    if (i + 25 < direct.length) Utilities.sleep(1000);
  }
  if (method !== 'deleteMessage') out.blocked.forEach(removeSub_);   // заблокували бота — прибираємо
  return out;
}

// ===== /undo: видалити помилкову розсилку (Telegram дозволяє лише 48 год) =====
const UNDO = { SHEET: 'Розсилки', KEEP: 30, HOURS: 47 };
function logSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(UNDO.SHEET);
  if (!sh) {
    sh = ss.insertSheet(UNDO.SHEET);
    sh.appendRow(['ID', 'Дата', 'Час', 'Тип', 'Текст', 'Отримувачів', 'Повідомлення (для видалення)']);
    sh.setFrozenRows(1); sh.getRange('A1:G1').setFontWeight('bold');
  }
  return sh;
}
function recordBroadcast_(type, preview, r) {
  try {
    if (!r || !r.sent || !r.sent.length) return;
    const sh = logSheet_(), now = new Date();
    const plain = String(preview || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
    sh.appendRow(["'" + now.getTime(), "'" + Utilities.formatDate(now, CFG.TZ, 'dd.MM.yyyy'), "'" + Utilities.formatDate(now, CFG.TZ, 'HH:mm'),
      type, plain, r.sent.length, r.sent.map(x => x[0] + ':' + x[1]).join(',')]);
    const extra = sh.getLastRow() - 1 - UNDO.KEEP;
    if (extra > 0) sh.deleteRows(2, extra);
  } catch (e) { console.error('Журнал розсилок: ' + e); }
}
function undoList_() {
  const sh = logSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().map((r, i) => ({ id: String(r[0]), date: fmtCell_(r[1]).slice(0, 5),
    time: fmtCell_(r[2]), type: String(r[3]), text: String(r[4]), n: Number(r[5]), list: String(r[6] || ''), row: i + 2 }))
    .filter(x => x.list && Date.now() - Number(x.id) < UNDO.HOURS * 3600e3).reverse().slice(0, 6);
}
function undoMenu_(id) {
  const list = undoList_();
  if (!list.length) return send_(id, '🗑 Немає розсилок, які можна видалити.\n<i>Telegram дозволяє видаляти повідомлення бота лише 48 годин.</i>');
  send_(id, '🗑 <b>Яку розсилку видалити в усіх?</b>\n\n' + list.map((x, i) => (i + 1) + '. ' + x.date + ' ' + x.time + ' · ' + esc_(x.type) +
    ' · ' + x.n + ' отр.\n<i>' + esc_(x.text.slice(0, 70)) + '</i>').join('\n\n'), false,
    { inline_keyboard: list.map((x, i) => [{ text: '🗑 ' + (i + 1) + '. ' + x.time + ' ' + x.text.slice(0, 25), callback_data: 'ux:' + x.id }])
      .concat([[{ text: 'Скасувати', callback_data: 'un:0' }]]) });
}
function undoCallback_(cq) {
  const answer = t => tgCall_('answerCallbackQuery', { callback_query_id: cq.id, text: t || '' });
  if (String(cq.from.id) !== adminId_()) return answer('Лише для адміністратора');
  const edit = (text, kb) => tgCall_('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    parse_mode: 'HTML', text: text, reply_markup: kb });
  const m = (cq.data || '').match(/^u([xyn]):(\d+)$/);
  if (!m || m[1] === 'n') { answer(''); return edit('Скасовано.'); }
  const item = undoList_().find(x => x.id === m[2]);
  if (!item) { answer(''); return edit('⚠️ Цю розсилку вже видалено або минуло 48 годин.'); }
  if (m[1] === 'x') {
    answer('');
    return edit('🗑 Видалити в <b>' + item.n + '</b> отримувачів?\n\n<i>' + esc_(item.text) + '</i>',
      { inline_keyboard: [[{ text: '✅ Так, видалити', callback_data: 'uy:' + item.id }, { text: 'Скасувати', callback_data: 'un:0' }]] });
  }
  answer('Видаляю…');
  logSheet_().getRange(item.row, 7).setValue('');   // щоб не видалити двічі
  const extra = {}, ids = [];
  item.list.split(',').forEach(pair => { const [c, mid] = pair.split(':'); if (c && mid) { ids.push(c); extra[c] = { message_id: Number(mid) }; } });
  const r = massSend_(ids, 'deleteMessage', {}, extra);
  logSheet_().getRange(item.row, 4).setValue(item.type + ' — видалено');
  edit('✅ Видалено в <b>' + r.n + '</b> з ' + ids.length + '.');
}

// ===== «✉️ Написати нам» =====
const FB = { WAIT_SEC: 900, MAX_PER_HOUR: 5, SHEET: 'Звернення' };
function fbStart_(id) {
  CacheService.getScriptCache().put('fb_' + id, '1', FB.WAIT_SEC);
  send_(id, '✉️ <b>Напишіть нам</b>\n\nОдним повідомленням: питання, ідея, помилка в навігаторі — можна з фото, відео чи голосовим. ' +
    'Якщо щось пішло не так у дорозі — додайте 📄 журнал поїздки (⚙ у навігаторі). Відповімо тут, у боті.',
    false, { inline_keyboard: [[{ text: '✖️ Скасувати', callback_data: 'fx:0' }]] });
}
function fbCallback_(cq) {
  const id = String(cq.from.id);
  tgCall_('answerCallbackQuery', { callback_query_id: cq.id, text: '' });
  if (cq.data === 'fx:0') {
    CacheService.getScriptCache().remove('fb_' + id);
    tgCall_('editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: 'Скасовано.' });
  } else if (cq.data === 'fw:0') fbStart_(id);
}
function fbSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(FB.SHEET);
  if (!sh) {
    sh = ss.insertSheet(FB.SHEET);
    sh.appendRow(['Дата', 'Час', 'ID', 'Імʼя', 'Username', 'Повідомлення', 'Відповідь']);
    sh.setFrozenRows(1); sh.getRange('A1:G1').setFontWeight('bold');
  }
  return sh;
}
function fbMapPut_(msgIds, uid) {
  const p = PropertiesService.getScriptProperties();
  const map = JSON.parse(p.getProperty('FB_MAP') || '{}');
  msgIds.filter(Boolean).forEach(x => { map[x] = uid; });
  const keys = Object.keys(map);
  keys.slice(0, Math.max(0, keys.length - 300)).forEach(k => delete map[k]);
  p.setProperty('FB_MAP', JSON.stringify(map));
}
function fbSend_(m) {
  const id = String(m.chat.id), cache = CacheService.getScriptCache();
  cache.remove('fb_' + id);
  const n = Number(cache.get('fbn_' + id) || 0);
  if (n >= FB.MAX_PER_HOUR) return send_(id, '⏳ Забагато повідомлень за годину. Спробуйте трохи пізніше.', false, keyboardFor_(id));
  cache.put('fbn_' + id, String(n + 1), 3600);
  addSub_(m.chat, 'start');
  const admin = adminId_(), body = m.text || m.caption || '';
  const kind = m.photo ? '📷 фото' : m.voice ? '🎤 голосове' : m.video ? '🎬 відео' : m.document ? '📎 файл' : m.sticker ? 'стікер' : '';
  const r1 = tgCall_('sendMessage', { chat_id: admin, parse_mode: 'HTML', disable_web_page_preview: true,
    text: '✉️ <b>Звернення</b> від ' + userLink_(m.chat) + '\nID: <code>' + id + '</code>' + (body ? '\n\n' + esc_(body) : '') +
      (kind ? '\n\n<i>(' + kind + ' — нижче)</i>' : '') + '\n\n<i>↩️ Щоб відповісти — зробіть Reply на це повідомлення.</i>' });
  let r2 = null;
  if (!m.text) r2 = tgCall_('copyMessage', { chat_id: admin, from_chat_id: id, message_id: m.message_id });
  fbMapPut_([r1.ok && r1.result.message_id, r2 && r2.ok && r2.result.message_id], id);
  fbSheet_().appendRow([Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM.yyyy'), Utilities.formatDate(new Date(), CFG.TZ, 'HH:mm'), "'" + id,
    [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' '), m.chat.username ? '@' + m.chat.username : '',
    (kind ? '[' + kind + '] ' : '') + body, '']);
  stat_('f', 'msg');
  send_(id, r1.ok ? '✅ Дякуємо! Повідомлення надіслано. Відповідь прийде сюди, у бот.' : '⚠️ Не вдалося надіслати. Спробуйте пізніше.',
    false, keyboardFor_(id));
}
function fbReply_(m) {
  const map = JSON.parse(prop_('FB_MAP') || '{}');
  const uid = map[m.reply_to_message.message_id];
  if (!uid) return false;
  const ok = m.text ? fbAnswer_(uid, m.text) : fbAnswer_(uid, m.caption || '', m.message_id);
  send_(String(m.chat.id), ok ? '✅ Відповідь надіслано.' : '⚠️ Не вдалося доставити — можливо, людина заблокувала бота.');
  return true;
}
function fbAnswer_(uid, text, copyMsgId) {
  const kb = { inline_keyboard: [[{ text: '✉️ Відповісти', callback_data: 'fw:0' }]] };
  let ok;
  if (copyMsgId) {
    send_(uid, '💬 <b>Відповідь від «' + esc_(CFG.NAME) + '»:</b>');
    ok = tgCall_('copyMessage', { chat_id: uid, from_chat_id: adminId_(), message_id: copyMsgId, reply_markup: kb }).ok;
  } else ok = send_(uid, '💬 <b>Відповідь від «' + esc_(CFG.NAME) + '»:</b>\n\n' + esc_(text), false, kb) === 200;
  if (ok) {
    const sh = fbSheet_();
    const ids = sh.getLastRow() < 2 ? [] : sh.getRange(2, 3, sh.getLastRow() - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === String(uid)) {
      const c = sh.getRange(i + 2, 7);
      c.setValue((c.getValue() ? c.getValue() + '\n' : '') + (text || '[медіа]'));
      break;
    }
  }
  return ok;
}

// ===== Статистика (/activity) — за днями у властивостях скрипта =====
function statKey_(d) { return 'ST_' + Utilities.formatDate(d || new Date(), CFG.TZ, 'yyyyMMdd'); }
function stat_(group, key, add) {
  try {
    const lock = LockService.getScriptLock(); lock.waitLock(5000);
    const p = PropertiesService.getScriptProperties(), k = statKey_();
    const st = JSON.parse(p.getProperty(k) || '{}');
    st[group] = st[group] || {};
    st[group][key] = (st[group][key] || 0) + (add == null ? 1 : add);
    p.setProperty(k, JSON.stringify(st));
    lock.releaseLock();
    // старше 8 днів — прибираємо
    const old = statKey_(new Date(Date.now() - 8 * 864e5));
    Object.keys(p.getProperties()).filter(x => /^ST_\d{8}$/.test(x) && x < old).forEach(x => p.deleteProperty(x));
  } catch (e) { console.error('stat: ' + e); }
}
function activityText_() {
  const p = PropertiesService.getScriptProperties();
  const days = []; for (let i = 0; i < 7; i++) days.push(JSON.parse(p.getProperty(statKey_(new Date(Date.now() - i * 864e5))) || '{}'));
  const g = (st, a, b) => (st[a] && st[a][b]) || 0;
  const week = (a, b) => days.reduce((s, st) => s + g(st, a, b), 0);
  const rows = subsRows_(), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
  const activeToday = rows.filter(x => fmtCell_(x.r[5]) === today).length;
  return '📈 <b>Активність</b> (сьогодні / 7 днів)\n\n' +
    '🆕 Нові через «Старт»: <b>' + g(days[0], 'n', 'start') + '</b> / ' + week('n', 'start') + '\n' +
    '🆕 Нові з навігатора: <b>' + g(days[0], 'n', 'app') + '</b> / ' + week('n', 'app') + '\n' +
    '🗺 Відкриття навігатора: <b>' + g(days[0], 'a', 'open') + '</b> / ' + week('a', 'open') + '\n' +
    '✉️ Звернення: <b>' + g(days[0], 'f', 'msg') + '</b> / ' + week('f', 'msg') + '\n' +
    '🔕 Відписалися: <b>' + g(days[0], 'n', 'stop') + '</b> / ' + week('n', 'stop') + '\n' +
    '📢 Доставлено розсилок: <b>' + g(days[0], 'd', 'post') + '</b> / ' + week('d', 'post') + '\n\n' +
    '👥 Усього: <b>' + rows.length + '</b>, активні сьогодні: <b>' + activeToday + '</b>';
}

// ===== Допоміжні =====
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function adminId_() { return prop_('TG_ADMIN_ID').trim(); }
function tgUrl_(method) { return 'https://api.telegram.org/bot' + prop_('TG_TOKEN').trim() + '/' + method; }
function tgCall_(method, payload) {
  try {
    const r = UrlFetchApp.fetch(tgUrl_(method), { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify(payload) });
    return JSON.parse(r.getContentText());
  } catch (e) { console.error(method + ': ' + e); return { ok: false }; }
}
function send_(chatId, html, silent, markup) {
  const r = tgCall_('sendMessage', Object.assign({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
    disable_notification: !!silent }, markup ? { reply_markup: markup } : {}));
  if (!r.ok) console.error('Telegram ' + chatId + ': ' + JSON.stringify(r).slice(0, 200));
  return r.ok ? 200 : (r.error_code || 0);
}
function esc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function userLink_(u) {
  const name = esc_([u.first_name, u.last_name].filter(Boolean).join(' ') || 'користувач');
  return u.username ? name + ' (@' + esc_(u.username) + ')' : '<a href="tg://user?id=' + u.id + '">' + name + '</a>';
}
function fmtCell_(v) {
  if (!(v instanceof Date)) return String(v);
  if (v.getFullYear() < 1900) return Utilities.formatDate(v, CFG.TZ, 'HH:mm');          // лише час
  return Utilities.formatDate(v, CFG.TZ, v.getHours() || v.getMinutes() ? 'dd.MM.yyyy HH:mm' : 'yyyy-MM-dd');
}
