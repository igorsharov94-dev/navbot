// Проверка логики ядра: node tests/test_core.js
const NC = require('../core.js');
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fails++; };

// Синтетический маршрут в Киеве: 500 м на север → направо 400 м на восток → налево 300 м на север
const lat0 = 50.45, lon0 = 30.52;
const dLat = m => m / 111195;
const dLon = m => m / (111195 * Math.cos(lat0 * Math.PI / 180));
function line(a, b, n) { const r = []; for (let i = 0; i <= n; i++) r.push([a[1] + (b[1] - a[1]) * i / n, a[0] + (b[0] - a[0]) * i / n]); return r; }
const A = [lat0, lon0], B = [lat0 + dLat(500), lon0], C = [lat0 + dLat(500), lon0 + dLon(400)], D = [lat0 + dLat(800), lon0 + dLon(400)];
const osrm = {
  code: 'Ok',
  routes: [{
    duration: 200,
    legs: [{
      steps: [
        { name: 'Крещатик', geometry: { coordinates: line(A, B, 25) }, maneuver: { type: 'depart', bearing_before: 0, bearing_after: 0 } },
        { name: 'Хмельницкого', geometry: { coordinates: line(B, C, 20) }, maneuver: { type: 'turn', modifier: 'right', bearing_before: 0, bearing_after: 90 } },
        { name: 'Владимирская', geometry: { coordinates: line(C, D, 15) }, maneuver: { type: 'turn', modifier: 'left', bearing_before: 90, bearing_after: 0 } },
        { name: '', geometry: { coordinates: [[D[1], D[0]], [D[1], D[0]]] }, maneuver: { type: 'arrive', bearing_before: 0, bearing_after: 0 } }
      ]
    }]
  }]
};

const rt = NC.buildRoute(osrm, { turnMinDeg: 40 });
ok(Math.abs(rt.total - 1200) < 5, 'длина маршрута ≈ 1200 м (' + rt.total.toFixed(1) + ')');
ok(rt.steps.length === 4, 'шагов 4');
ok(Math.abs(rt.steps[1].s - 500) < 3 && Math.abs(rt.steps[2].s - 900) < 3, 'манёвры на 500 и 900 м');
ok(rt.steps[1].text === 'Поверніть праворуч на Хмельницкого', 'текст: ' + rt.steps[1].text);
ok(rt.turns.length === 2, 'найдено поворотов по геометрии: ' + rt.turns.length);
ok(rt.turns[0] && Math.abs(rt.turns[0].s - 500) < 20 && Math.abs(rt.turns[0].ccw + 90) < 10, 'поворот 1: направо ≈ 500 м (' + JSON.stringify(rt.turns[0]) + ')');
ok(rt.turns[1] && Math.abs(rt.turns[1].s - 900) < 20 && Math.abs(rt.turns[1].ccw - 90) < 10, 'поворот 2: налево ≈ 900 м (' + JSON.stringify(rt.turns[1]) + ')');

// Проекция
const p = NC.pointAt(rt, 700);
const pr = NC.project(rt, [p[0] + dLat(15), p[1]], 700);
ok(Math.abs(pr.s - 700) < 3 && Math.abs(pr.d - 15) < 2, 'проекция точки в 15 м от маршрута: s=' + pr.s.toFixed(1) + ' d=' + pr.d.toFixed(1));

// Сопоставление поворотов гироскопа (deg > 0 — налево)
let pos = { s: 420, anchorS: 0, lastTurnS: -1e9 };
let m = NC.matchTurn(rt.turns, pos, -85);
ok(m === rt.turns[0], 'правый поворот при расчётной позиции 420 м → поворот на 500 м');
m = NC.matchTurn(rt.turns, pos, 88);
ok(m === rt.turns[1], 'левый поворот (первый пропущен) → поворот на 900 м');
pos = { s: 520, anchorS: 520, lastTurnS: rt.turns[0].s };
m = NC.matchTurn(rt.turns, pos, -90);
ok(m === null, 'правый поворот там, где маршрут идёт налево → «съезд с маршрута»');

// Симуляция поездки по датчикам: расчётная скорость на 30% выше реальной
{
  let s = 0, anchor = 0, last = -1e9;
  const vTrue = 8, vEst = 10.4;
  let trueS = 0;
  const events = [{ at: 500, deg: -88 }, { at: 900, deg: 86 }];
  let ei = 0, maxErr = 0;
  for (let t = 0; t < 200 && trueS < 1190; t += 0.2) {
    trueS += vTrue * 0.2;
    s += vEst * 0.2;
    const nt = rt.turns.find(x => x.s > last + 20);
    if (nt && s > nt.s + 60) s = nt.s + 60;
    if (ei < events.length && trueS >= events[ei].at + 10) {
      const hit = NC.matchTurn(rt.turns, { s, anchorS: anchor, lastTurnS: last }, events[ei].deg);
      if (hit) { s = hit.s + 15; anchor = s; last = hit.s; }
      ei++;
    }
    maxErr = Math.max(maxErr, Math.abs(s - trueS));
  }
  ok(last === rt.turns[1].s, 'симуляция: оба поворота распознаны');
  ok(maxErr < 160, 'симуляция: максимальная ошибка позиции ' + maxErr.toFixed(0) + ' м');
}

// Светофоры и подсказки
const sig1 = NC.pointAt(rt, 200), sig2 = NC.pointAt(rt, 498), sig2b = NC.pointAt(rt, 510);
rt.signals = NC.clusterSignals(rt, [
  { lat: sig1[0], lon: sig1[1] }, { lat: sig2[0], lon: sig2[1] }, { lat: sig2b[0], lon: sig2b[1] },
  { lat: lat0 + dLat(300), lon: lon0 + dLon(200) } // далеко от маршрута — не считать
]);
ok(rt.signals.length === 2, 'светофоров на маршруте: ' + rt.signals.length);
ok(NC.landmark(rt.signals, 0, 500) === 'на 2-му світлофорі', 'подсказка: ' + NC.landmark(rt.signals, 0, 500));
ok(NC.landmark(rt.signals, 300, 500) === 'на найближчому світлофорі', 'подсказка: ' + NC.landmark(rt.signals, 300, 500));
ok(NC.fmtDist(437, true) === '≈ 450 м' && NC.fmtDist(1530, false) === '1,5 км', 'формат расстояний');

// Круговое движение
const rtRb = NC.buildRoute({
  code: 'Ok', routes: [{ legs: [{ steps: [
    { name: 'A', geometry: { coordinates: line(A, B, 25) }, maneuver: { type: 'depart', bearing_before: 0, bearing_after: 0 } },
    { name: '', geometry: { coordinates: line(B, [B[0] + dLat(5), B[1] + dLon(5)], 2) }, maneuver: { type: 'roundabout', modifier: 'right', exit: 2, bearing_before: 0, bearing_after: 45 } },
    { name: 'B', geometry: { coordinates: line([B[0] + dLat(5), B[1] + dLon(5)], C, 20) }, maneuver: { type: 'exit roundabout', modifier: 'right', bearing_before: 45, bearing_after: 90 } },
    { name: '', geometry: { coordinates: [[C[1], C[0]], [C[1], C[0]]] }, maneuver: { type: 'arrive', bearing_before: 90, bearing_after: 0 } }
  ] }] }]
}, {});
const ring = rtRb.turns.filter(t => t.ring);
ok(ring.length === 1 && Math.abs(ring[0].ccw + 90) < 1, 'круг: итоговый поворот направо 90°');
ok(rtRb.steps[1].text === 'На колі 2-й з’їзд', 'текст круга: ' + rtRb.steps[1].text);

console.log(fails ? '\nОшибок: ' + fails : '\nВсе проверки пройдены');
process.exit(fails ? 1 : 0);
