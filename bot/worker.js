// Посередник для бота «Навігатор без GPS» (Cloudflare Worker) — як у ЛМ10:
//   • вебхук Telegram: одразу відповідає «ок», а оновлення передає в Apps Script у фоні;
//   • /send — масова розсилка пачками (не витрачає ліміт Google);
//   • /app  — позначки з міні-застосунку («відкрили навігатор», «дозволили писати»). Підпис Telegram перевіряє Apps Script.
//
// 1) Вставте адресу веб-застосунку Apps Script (закінчується на /exec):
const GAS_URL = 'https://script.google.com/macros/s/ВСТАВТЕ_СЮДИ/exec';
// 2) У Cloudflare: Settings → Variables and Secrets → Add → тип Secret, назва SEND_KEY, значення — ваш секретний ключ
//    (той самий, що у властивості скрипта CF_KEY).

const APP_ORIGIN = 'https://igorsharov94-dev.github.io';   // звідки дозволено надсилати позначки
const ALLOWED = ['sendMessage', 'sendPhoto', 'sendVideo', 'sendAnimation', 'copyMessage', 'deleteMessage', 'editMessageText'];
const MAX_IDS = 45;     // безкоштовний план Cloudflare — до 50 запитів за один виклик
const WAVE = 25;        // скільки повідомлень одночасно (ліміт Telegram ~30/с)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/app') return app(request, env, ctx);
    if (request.method === 'POST' && url.pathname === '/send') return sendMany(request, env);
    if (request.method !== 'POST') return new Response('ok');
    // лише справжній Telegram: він надсилає секрет у заголовку (задається в connectWebhook)
    if (!env.SEND_KEY || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.SEND_KEY) return new Response('forbidden', { status: 403 });
    const body = await request.text();
    ctx.waitUntil(fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ tg: JSON.parse(body), key: env.SEND_KEY }) }));
    return new Response('ok');
  },
};

// Позначка з міні-застосунку: { event: 'open' | 'write_ok', initData }
async function app(request, env, ctx) {
  const cors = { 'Access-Control-Allow-Origin': APP_ORIGIN, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST' || !env.SEND_KEY) return new Response('no', { status: 400, headers: cors });
  let b;
  try { b = await request.json(); } catch (e) { return new Response('bad json', { status: 400, headers: cors }); }
  const event = ['open', 'write_ok'].includes(b.event) ? b.event : null;
  if (!event || typeof b.initData !== 'string' || b.initData.length > 4096) return new Response('bad', { status: 400, headers: cors });
  ctx.waitUntil(fetch(GAS_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
    body: JSON.stringify({ app_event: event, init_data: b.initData, key: env.SEND_KEY }),
  }));
  return new Response('ok', { headers: cors });
}

// Розсилка пачки: { key, token, method, ids: [...], payload: {...}, items?: [{chat_id, ...}] } → { ok, results: [{id, code, mid}] }
async function sendMany(request, env) {
  let b;
  try { b = await request.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
  if (!env.SEND_KEY || b.key !== env.SEND_KEY) return new Response('forbidden', { status: 403 });
  if (!ALLOWED.includes(b.method) || !Array.isArray(b.ids) || !b.token) return new Response('bad request', { status: 400 });
  const items = (Array.isArray(b.items) ? b.items : b.ids.map(id => ({ chat_id: id }))).slice(0, MAX_IDS);
  const results = [];
  for (let i = 0; i < items.length; i += WAVE) {
    const part = items.slice(i, i + WAVE);
    const res = await Promise.all(part.map(it => sendOne(b.token, b.method, Object.assign({}, b.payload || {}, it))));
    part.forEach((it, j) => results.push({ id: it.chat_id, code: res[j].code, mid: res[j].mid }));
    if (i + WAVE < items.length) await new Promise(r => setTimeout(r, 1000));
  }
  return Response.json({ ok: true, results });
}

async function sendOne(token, method, payload) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    let mid;
    if (r.status === 200) { try { const j = await r.json(); mid = j.result && j.result.message_id; } catch (e) {} }
    return { code: r.status, mid };
  } catch (e) { return { code: 0 }; }
}
