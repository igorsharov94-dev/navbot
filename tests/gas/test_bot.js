const H = require('./harness.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };
const A = { id: 1000, first_name: 'Ігор' }, U1 = { id: 2001, first_name: 'Оля', username: 'olya' }, U2 = { id: 2002, first_name: 'Петро' }, U3 = { id: 2003, first_name: 'Ніна' };

// 1. Старт
H.reset(); H.msg(U1, { text: '/start' });
ok(H.api.subs_().includes('2001'), '/start додає в «Підписники»');
ok(H.sent(c => c.method === 'sendMessage' && c.p.chat_id === '2001').length >= 2, 'вітання + кнопки надіслано');
const kb = H.calls.find(c => c.p.reply_markup && c.p.reply_markup.keyboard);
ok(kb && kb.p.reply_markup.keyboard[0][0].web_app, 'кнопка «🗺 Відкрити навігатор» відкриває міні-застосунок');
H.msg(U1, { text: '/start' }); ok(H.sheets['Підписники'].d.length === 2, 'повторний /start не дублює');
H.msg(U2, { text: '/start' }); H.msg(A, { text: '/start' });

// 2. Облік із навігатора (підпис Telegram)
H.post({ app_event: 'open', key: 'secret', init_data: H.initData(U3) });
const row3 = H.sheets['Підписники'].d.find(r => String(r[0]) === '2003');
ok(row3 && row3[4] === 'app' && row3[7] === 0, 'відкрив навігатор без «Старт» → записаний, але розсилки йому не йдуть');
ok(!H.api.subs_().includes('2003'), 'без дозволу не потрапляє в розсилку');
H.post({ app_event: 'write_ok', key: 'secret', init_data: H.initData(U3) });
ok(H.api.subs_().includes('2003'), 'після «дозволити писати» — у розсилці');
const before = H.sheets['Підписники'].d.length;
H.post({ app_event: 'open', key: 'secret', init_data: H.initData({ id: 9999, first_name: 'Хакер' }).replace(/hash=\w+/, 'hash=' + '0'.repeat(64)) });
ok(H.sheets['Підписники'].d.length === before, 'підроблений підпис відхилено');
H.post({ app_event: 'open', key: 'wrong', init_data: H.initData({ id: 9998, first_name: 'Х' }) });
ok(H.sheets['Підписники'].d.length === before, 'чужий ключ посередника відхилено');
H.post({ app_event: 'open', key: 'secret', init_data: H.initData({ id: 9997, first_name: 'Старий' }, 2 * 86400) });
ok(H.sheets['Підписники'].d.length === before, 'застарілий підпис (>доби) відхилено');

// 3. Розсилка тексту
H.reset(); H.blocked.add('2002');
H.msg(A, { text: '/post Оновлення навігатора: нова карта!' });
const posts = H.sent(c => c.method === 'sendMessage' && /Оновлення навігатора/.test(c.p.text || ''));
ok(posts.length === 4, 'оголошення пішло всім 4 отримувачам (разом з адміном): ' + posts.length);
ok(posts.every(p => /📢/.test(p.p.text) && /Навігатор без GPS<\/a>/.test(p.p.text)), 'з 📢 і підписом-посиланням на бот');
ok(!H.api.subs_().includes('2002'), 'хто заблокував бота — прибраний зі списку');
ok(H.sent(c => c.p.chat_id === '1000' && /Розіслано: 3/.test(c.p.text || '')).length === 1, 'адмін отримав звіт «Розіслано: 3»');
ok(H.sheets['Розсилки'].d.length === 2, 'розсилку записано для /undo');

// 4. Не адмін не може розсилати
H.reset(); H.msg(U1, { text: '/post спам' });
ok(H.sent(c => /лише для адміністратора/.test(c.p.text || '')).length === 1 && !H.sent(c => /спам/.test(c.p.text || '')).length, '/post від звичайного користувача заборонено');

// 5. Фото й відео
H.reset(); H.msg(A, { photo: [{ file_id: 's' }, { file_id: 'BIG' }], caption: '/post Як працює новий режим' });
const ph = H.sent(c => c.method === 'sendPhoto');
ok(ph.length === 3 && ph.every(c => c.p.photo === 'BIG' && /Як працює/.test(c.p.caption)), 'фото з підписом розіслано (найбільший розмір)');
H.reset(); H.msg(A, { video: { file_id: 'VID' }, caption: '/post Відео-інструкція' });
ok(H.sent(c => c.method === 'sendVideo' && c.p.video === 'VID').length === 3, 'відео розіслано');

// 6. «Написати нам» → адмін → Reply → людина
H.reset(); H.msg(U1, { text: '✉️ Написати нам' });
ok(H.sent(c => c.p.chat_id === '2001' && /Напишіть нам/.test(c.p.text || '')).length === 1, 'кнопка «Написати нам» вмикає режим звернення');
H.msg(U1, { text: 'Точка тікає вперед на Хрещатику' });
const toAdmin = H.sent(c => c.p.chat_id === '1000' && /Звернення/.test(c.p.text || ''))[0];
ok(toAdmin && /Точка тікає/.test(toAdmin.p.text) && /@olya/.test(toAdmin.p.text), 'звернення прийшло адміну з іменем і текстом');
ok(H.sheets['Звернення'].d.length === 2, 'звернення записано в лист «Звернення»');
const adminMsgId = 500 + H.calls.indexOf(toAdmin) + (require('./harness.js').calls.length ? 0 : 0);
// знаходимо message_id, який повернув «Telegram» для повідомлення адміну
const map = JSON.parse(H.props.FB_MAP); const replyTo = Number(Object.keys(map).find(k => map[k] === '2001'));
H.reset(); H.msg(A, { text: 'Дякуємо! Виправили в новій версії.', reply_to_message: { message_id: replyTo } });
ok(H.sent(c => c.p.chat_id === '2001' && /Відповідь від/.test(c.p.text || '') && /Виправили/.test(c.p.text)).length === 1, 'Reply адміна дійшов людині');
ok(/Виправили/.test(H.sheets['Звернення'].d[1][6]), 'відповідь записано в таблицю');
H.reset(); H.msg(U1, { photo: [{ file_id: 'p' }] });
ok(!H.sent(c => c.method === 'copyMessage').length, 'фото без режиму звернення адміну не пересилається');
H.msg(U1, { text: '/start write' }); H.msg(U1, { photo: [{ file_id: 'p' }], caption: 'скрін' });
ok(H.sent(c => c.method === 'copyMessage' && c.p.chat_id === '1000').length === 1, 'з навігатора (?start=write) фото-звернення переслано адміну');
for (let i = 0; i < 6; i++) { H.msg(U1, { text: '/write' }); H.msg(U1, { text: 'ще ' + i }); }
ok(H.sent(c => /Забагато повідомлень/.test(c.p.text || '')).length >= 1, 'обмеження 5 звернень на годину');

// 7. /undo
H.reset(); H.msg(A, { text: '/undo' });
const menu = H.sent(c => c.p.reply_markup && c.p.reply_markup.inline_keyboard && /Яку розсилку/.test(c.p.text || ''))[0];
ok(!!menu, '/undo показує список розсилок');
const cb = menu.p.reply_markup.inline_keyboard[0][0].callback_data.replace('ux', 'uy');
H.reset(); H.post({ callback_query: { id: 'c1', from: A, data: cb, message: { chat: { id: 1000 }, message_id: 1 } } });
ok(H.sent(c => c.method === 'deleteMessage').length >= 2, 'розсилку видалено в отримувачів');

// 8. Звіти
const st = H.api.subsText_(); ok(/Користувачів: <b>3<\/b>/.test(st) && /Відкривали навігатор: <b>1<\/b>/.test(st), '/subs: ' + st.split('\n').slice(0, 3).join(' | '));
const act = H.api.activityText_(); ok(/Нові з навігатора: <b>1<\/b>/.test(act) && /Звернення: <b>[1-9]/.test(act), '/activity рахує нових, відкриття, звернення');
H.reset(); H.msg(U1, { text: '/stop' }); ok(!H.api.subs_().includes('2001'), '/stop відписує');

console.log(fails ? '\nПомилок: ' + fails : '\nУсі перевірки пройдено');
process.exit(fails ? 1 : 0);
