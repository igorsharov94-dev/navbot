/*
 * Ядро навігації без GPS (для авто).
 * Чистые функции: геометрия, маршрут OSRM, точки поворотов, светофоры,
 * сопоставление поворотов, пойманных гироскопом, с маршрутом.
 */
(function (root) {
  'use strict';

  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;

  // p = [lat, lon]
  function dist(a, b) {
    const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    const f1 = toRad(a[0]), f2 = toRad(b[0]), dl = toRad(b[1] - a[1]);
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function norm180(x) { return ((x + 180) % 360 + 360) % 360 - 180; }

  // ---------- Тексты манёвров ----------
  const DIR = {
    left: 'ліворуч', 'sharp left': 'різко ліворуч', 'slight left': 'плавно ліворуч',
    right: 'праворуч', 'sharp right': 'різко праворуч', 'slight right': 'плавно праворуч',
    straight: 'прямо', uturn: 'розворот'
  };

  function maneuverText(st) {
    const m = st.mod || '';
    const nm = st.name || st.ref || '';
    const on = nm ? ' на ' + nm : '';
    const dir = DIR[m] || '';
    switch (st.type) {
      case 'depart': return 'Почніть рух' + (nm ? ' по ' + nm : '');
      case 'arrive': return 'Ви приїхали';
      case 'roundabout': case 'rotary': case 'roundabout turn':
        return 'На колі ' + (st.exit ? st.exit + '-й з’їзд' : 'з’їзд') + on;
      case 'merge': return 'Перелаштуйтеся ' + dir + on;
      case 'on ramp': return 'В’їзд ' + dir + on;
      case 'off ramp': return 'З’їзд ' + dir + on;
      case 'fork': return 'На розвилці тримайтеся ' + (m.includes('left') ? 'лівіше' : 'правіше') + on;
      case 'end of road': return 'Наприкінці дороги ' + dir + on;
      case 'continue': case 'new name':
        return (m === 'straight' || !m) ? 'Прямо' + (nm ? ' по ' + nm : '') : 'Тримайтеся ' + dir + on;
      default:
        if (m === 'uturn') return 'Розверніться' + (nm ? ' на ' + nm : '');
        if (m === 'straight') return 'Прямо' + (nm ? ' по ' + nm : '');
        return 'Поверніть ' + dir + on;
    }
  }

  function isAnnounced(st) {
    if (['depart', 'new name', 'notification', 'exit roundabout', 'exit rotary'].includes(st.type)) return false;
    if (st.type === 'continue' && (!st.mod || st.mod === 'straight')) return false;
    return true;
  }

  // ---------- Маршрут ----------
  function buildRoute(osrm, opts) {
    if (!osrm || osrm.code !== 'Ok' || !osrm.routes || !osrm.routes.length) {
      throw new Error('маршрут не знайдено');
    }
    const r = osrm.routes[0];
    const pts = [], steps = [];
    for (const leg of r.legs) {
      for (const s of leg.steps) {
        const c = ((s.geometry && s.geometry.coordinates) || []).map(p => [p[1], p[0]]);
        let idx;
        if (!pts.length) idx = 0;
        else if (c.length && dist(pts[pts.length - 1], c[0]) < 1) { c.shift(); idx = pts.length - 1; }
        else idx = pts.length;
        for (const p of c) pts.push(p);
        const m = s.maneuver || {};
        steps.push({
          idx, type: m.type, mod: m.modifier || '', exit: m.exit,
          bb: m.bearing_before, ba: m.bearing_after,
          name: s.name || '', ref: s.ref || ''
        });
      }
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const rt = { pts, cum, total: cum[cum.length - 1] || 0, steps, signals: [], duration: r.duration };
    for (const st of steps) {
      st.s = cum[Math.min(st.idx, cum.length - 1)] || 0;
      st.text = maneuverText(st);
      st.announce = isAnnounced(st);
    }
    rt.turns = computeTurns(rt, opts);
    return rt;
  }

  function pointAt(rt, s) {
    const { pts, cum } = rt;
    if (!pts.length) return null;
    if (s <= 0) return pts[0].slice();
    if (s >= rt.total) return pts[pts.length - 1].slice();
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const seg = cum[hi] - cum[lo];
    const f = seg > 0 ? (s - cum[lo]) / seg : 0;
    return [pts[lo][0] + f * (pts[hi][0] - pts[lo][0]), pts[lo][1] + f * (pts[hi][1] - pts[lo][1])];
  }

  // Проекция точки на маршрут. hint — ожидаемое положение (м), чтобы не прыгать на параллельный участок.
  function project(rt, p, hint) {
    const { pts, cum } = rt;
    if (pts.length === 1) return { s: 0, d: dist(pts[0], p) };
    const kx = 111320 * Math.cos(toRad(p[0])), ky = 110540;
    let best = { s: 0, d: Infinity, cost: Infinity };
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = (pts[i][1] - p[1]) * kx, ay = (pts[i][0] - p[0]) * ky;
      const bx = (pts[i + 1][1] - p[1]) * kx, by = (pts[i + 1][0] - p[0]) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      const s = cum[i] + t * (cum[i + 1] - cum[i]);
      const cost = d + (hint != null ? 0.03 * Math.abs(s - hint) : 0);
      if (cost < best.cost) best = { s, d, cost };
    }
    return { s: best.s, d: best.d };
  }

  // Все места маршрута, где машина заметно поворачивает (по геометрии), + круги.
  // ccw > 0 — поворот налево (против часовой), < 0 — направо.
  function computeTurns(rt, opts) {
    const minDeg = (opts && opts.turnMinDeg) || 40;
    const STEP = 10, W = 4;
    const turns = [];
    if (rt.total >= STEP * (2 * W + 2)) {
      const res = [];
      for (let s = 0; s <= rt.total; s += STEP) res.push(pointAt(rt, s));
      const hd = [];
      for (let i = 0; i < res.length - 1; i++) hd.push(bearing(res[i], res[i + 1]));
      let group = null;
      const flush = () => {
        if (!group) return;
        const mx = Math.max(...group.items.map(x => Math.abs(x.net)));
        const top = group.items.filter(x => Math.abs(x.net) >= mx - 5);
        const s = top.reduce((a, x) => a + x.i, 0) / top.length * STEP;
        const net = top.reduce((a, x) => a + x.net, 0) / top.length;
        turns.push({ s, ccw: -net });
        group = null;
      };
      for (let i = W; i < hd.length - W; i++) {
        const net = norm180(hd[i + W - 1] - hd[i - W]);
        if (Math.abs(net) >= minDeg) {
          if (group && Math.sign(net) === group.sign && i - group.last <= 1) {
            group.items.push({ i, net }); group.last = i;
          } else {
            flush(); group = { sign: Math.sign(net), last: i, items: [{ i, net }] };
          }
        } else flush();
      }
      flush();
    }
    // Круговое движение: считаем итоговый поворот от въезда до выезда
    const RB = ['roundabout', 'rotary', 'roundabout turn'];
    for (let k = 0; k < rt.steps.length; k++) {
      const st = rt.steps[k];
      if (!RB.includes(st.type)) continue;
      const ex = rt.steps[k + 1];
      if (!ex || st.bb == null || ex.ba == null) continue;
      const net = norm180(ex.ba - st.bb);
      for (let j = turns.length - 1; j >= 0; j--) {
        if (turns[j].s > st.s - 40 && turns[j].s < ex.s + 40) turns.splice(j, 1);
      }
      if (Math.abs(net) >= minDeg) turns.push({ s: ex.s, ccw: -net, ring: true });
    }
    turns.sort((a, b) => a.s - b.s);
    return turns;
  }

  // Найти, какому повороту маршрута соответствует поворот, пойманный гироскопом.
  // pos = {s, anchorS, lastTurnS}; deg > 0 — налево.
  function matchTurn(turns, pos, deg) {
    const unc = Math.max(150, 0.35 * Math.max(0, pos.s - pos.anchorS));
    const pending = turns.filter(t => t.s > pos.lastTurnS + 20);
    const nextTwo = new Set(pending.slice(0, 2));
    let best = null, bestCost = Infinity;
    for (const t of pending) {
      const inWindow = t.s >= pos.s - unc && t.s <= pos.s + unc * 1.5 + 100;
      if (!inWindow && !nextTwo.has(t)) continue;
      if (Math.sign(t.ccw) !== Math.sign(deg)) continue;
      const ad = Math.abs(deg - t.ccw);
      if (ad > Math.max(50, 0.45 * Math.abs(t.ccw))) continue;
      const cost = Math.abs(t.s - pos.s) / unc + ad / 60 + (inWindow ? 0 : 1);
      if (cost < bestCost) { bestCost = cost; best = t; }
    }
    return best;
  }

  // ---------- Светофоры ----------
  function clusterSignals(rt, nodes) {
    const arr = [];
    for (const n of nodes) {
      const pr = project(rt, [n.lat, n.lon]);
      if (pr.d < 25) arr.push(pr.s);
    }
    arr.sort((a, b) => a - b);
    const out = [];
    let grp = [];
    for (const s of arr) {
      if (grp.length && s - grp[grp.length - 1] > 50) {
        out.push(grp.reduce((a, b) => a + b, 0) / grp.length); grp = [];
      }
      grp.push(s);
    }
    if (grp.length) out.push(grp.reduce((a, b) => a + b, 0) / grp.length);
    return out;
  }

  function landmark(signals, from, to) {
    if (!signals || !signals.length) return '';
    const between = signals.filter(x => x > from + 25 && x <= to + 40);
    if (!between.length) return '';
    const n = between.length, last = between[n - 1];
    if (Math.abs(last - to) <= 40) return n === 1 ? 'на найближчому світлофорі' : 'на ' + n + '-му світлофорі';
    return n === 1 ? 'після найближчого світлофора' : 'після ' + n + '-го світлофора';
  }

  function fmtDist(d, approx) {
    let t;
    if (d < 1000) t = (approx ? Math.round(d / 50) * 50 : Math.round(d / 10) * 10) + ' м';
    else t = (d / 1000).toFixed(1).replace('.', ',') + ' км';
    return (approx ? '≈ ' : '') + t;
  }

  const api = {
    dist, bearing, norm180, maneuverText, isAnnounced, buildRoute, pointAt, project,
    computeTurns, matchTurn, clusterSignals, landmark, fmtDist
  };
  root.NavCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
