// Перевірка зіставлення з вигинами дороги: node tests/test_profile.js
// Дорога лише з плавними вигинами (без різких поворотів), розрахункова швидкість завищена на 30%.
const NC = require('../core.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fails++; };

const lat0 = 50.45, lon0 = 30.52, K = 111195 * Math.cos(lat0 * Math.PI / 180);
// ділянки: [довжина м, зміна курсу ° (за год. стрілкою)]
const plan = [[300, 0], [100, 30], [400, 0], [150, -45], [300, 0], [120, 25], [400, 0], [100, -35], [350, 0], [140, 40], [300, 0]];
const pts = []; let x = 0, y = 0, h = 10;
pts.push([y, x]);
for (const [len, dh] of plan) {
  const n = Math.round(len / 5);
  for (let i = 0; i < n; i++) {
    h += dh / n;
    x += 5 * Math.sin(h * Math.PI / 180); y += 5 * Math.cos(h * Math.PI / 180);
    pts.push([y, x]);
  }
}
const coords = pts.map(([yy, xx]) => [lon0 + xx / K, lat0 + yy / 111195]);
const rt = NC.buildRoute({ code: 'Ok', routes: [{ legs: [{ steps: [
  { name: 'Набережна', geometry: { coordinates: coords }, maneuver: { type: 'depart', bearing_before: 0, bearing_after: 10 } },
  { name: '', geometry: { coordinates: [coords[coords.length - 1], coords[coords.length - 1]] }, maneuver: { type: 'arrive', bearing_before: 0, bearing_after: 0 } }
] }] }] }, {});
ok(rt.turns.length === 0, 'на маршруті немає різких поворотів (знайдено: ' + rt.turns.length + ')');
const prof = NC.headingProfile(rt, 5);
ok(Math.abs((prof.H[prof.H.length - 1] - prof.H[0]) - (30 - 45 + 25 - 35 + 40)) < 4, 'профіль курсу: сумарна зміна ≈ 15°');

// Симуляція: справжня швидкість 10 м/с, розрахункова 13 м/с; гіроскоп з шумом і дрейфом
function simulate(useProfile) {
  let lastK = 0, trueS = 0, s = 0, odo = 0, anchor = 0, k = 1, maxErr = 0, sumErr = 0, n = 0, fixes = 0;
  const meas = []; let lastD = -1e9, th = 0, seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const dt = 0.2;
  let prevH = NC.headingAt(prof, 0);
  for (let t = 0; trueS < rt.total - 60; t += dt) {
    trueS += 10 * dt;
    const Ht = NC.headingAt(prof, trueS);
    th += -(Ht - prevH) + rnd() * 0.15 + 0.01 * dt;   // гіроскоп: проти год. стрілки +, шум, дрейф 0.01°/с
    prevH = Ht;
    const v = 13 * k;
    s += v * dt; odo += v * dt;                        // одометр — та ж швидкість, що рухає позицію
    if (odo - lastD >= 5) { meas.push({ d: odo, th }); lastD = odo; if (meas.length > 140) meas.shift(); }
    if (useProfile && Math.round(t / dt) % 10 === 0) {
      const unc = Math.max(150, 0.35 * (s - anchor));
      const m = NC.matchProfile(prof, s, unc, meas);
      if (m && m.ok && Math.abs(m.s - s) > 8) { s += 0.7 * (m.s - s); anchor = s; fixes++; }
      // alpha усереднена за вікном 300 м — оновлюємо k не частіше, ніж раз на 250 м, інакше перебір
      if (m && m.ok && odo - lastK >= 250) { k = Math.min(2.5, Math.max(0.5, k * (1 + 0.7 * (m.alpha - 1)))); lastK = odo; }
    }
    const e = Math.abs(s - trueS); maxErr = Math.max(maxErr, e); sumErr += e; n++;
  }
  return { maxErr, meanErr: sumErr / n, endErr: Math.abs(s - trueS), fixes, k };
}
const base = simulate(false), withP = simulate(true);
console.log('  без зіставлення: макс ' + base.maxErr.toFixed(0) + ' м, середня ' + base.meanErr.toFixed(0) + ' м, наприкінці ' + base.endErr.toFixed(0) + ' м');
console.log('  із зіставленням: макс ' + withP.maxErr.toFixed(0) + ' м, середня ' + withP.meanErr.toFixed(0) + ' м, наприкінці ' + withP.endErr.toFixed(0) + ' м, уточнень ' + withP.fixes + ', k=' + withP.k.toFixed(2));
ok(base.endErr > 500, 'без зіставлення помилка росте (' + base.endErr.toFixed(0) + ' м)');
ok(withP.endErr < 60, 'із зіставленням помилка наприкінці < 60 м');
ok(withP.meanErr < base.meanErr / 4, 'середня помилка зменшилась щонайменше вчетверо');
ok(Math.abs(withP.k - 10 / 13) < 0.12, 'навчений коефіцієнт швидкості ≈ 0,77 (' + withP.k.toFixed(2) + ')');

// Пряма дорога: зіставлення має чесно відмовитись, а не вигадувати
const straight = []; for (let i = 0; i < 60; i++) straight.push({ d: i * 5, th: 0.3 * Math.sin(i) });
const r = NC.matchProfile(prof, 50, 150, straight);
ok(r && r.ok === false && r.why === 'flat', 'на прямій зіставлення не застосовується');

console.log(fails ? '\nПомилок: ' + fails : '\nВсі перевірки пройдено');
process.exit(fails ? 1 : 0);
