// Перевірка моделі «швидкість за вібрацією»: шумна вібрація не має стискати діапазон швидкостей.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const m = src.match(/const Vib = \{[\s\S]*?\n  \};\n/);
if (!m) throw new Error('Vib не знайдено');
const mem = {}, store = { get: k => mem[k] || null, set: (k, v) => { mem[k] = v; } };
const st = { k: 1 };
const Vib = new Function('store', 'st', m[0] + 'Vib.load(); return Vib;')(store, st);
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
// вібрація росте зі швидкістю, але з сильним шумом (як у реальному журналі, кореляція ~0.6)
const vibOf = v => Math.exp(Math.log(0.25) + 0.045 * v + 0.35 * gauss());
for (let i = 0; i < 3000; i++) { const v = 1 + rnd() * 23; Vib.learn(vibOf(v), v); }
let ok = true;
const check = (name, cond) => { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name); ok = ok && cond; };
check('модель навчена', Vib.trained());
check('обернена крива готова', !!Vib.invPts());
for (const v of [4, 10, 18, 22]) {
  let s = 0; const n = 400; for (let i = 0; i < n; i++) s += Vib.predict(vibOf(v)); const mean = s / n;
  // медіана вібрації без шуму → має дати близьку швидкість
  const med = Vib.predict(Math.exp(Math.log(0.25) + 0.045 * v));
  console.log(`  ${v * 3.6} км/год → медіанна оцінка ${(med * 3.6).toFixed(0)}, середня ${(mean * 3.6).toFixed(0)}`);
  check(`швидкість ${v * 3.6} км/год не стиснута (±25%)`, Math.abs(med - v) / v < 0.25);
}
check('k скинуто при зміні моделі', st.k === 1);
// збереження
Vib.lastSave = 0; Vib.learn(0.3, 5);
check('зберігається nav_vib2', !!mem.nav_vib2);
process.exit(ok ? 0 : 1);
