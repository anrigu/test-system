import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [,, mom, dad, out, agesArg, optsArg] = process.argv;
const ages = (agesArg || '0,1,3,6,10,14,18,30,50,70,85').split(',').map(Number);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text()); });
p.on('pageerror', e => console.log('pageerror:', e.message));
await p.goto('http://localhost:8173/dev/grid.html');
const r = await p.evaluate(([a, b, ages, o]) => window.run(a, b, ages, o), ['/_test/' + mom, '/_test/' + dad, ages, JSON.parse(optsArg || '{}')]);
console.log('ms/render', r.dt.toFixed(1));
for (const who of ['mom', 'dad']) { const s = r[who]; console.log(who, 'eye', s.eyeGuess, s.irisLab?.map(v=>v.toFixed(0)), 'hair', s.hairGuess, s.hairLab?.map(v=>v.toFixed(0)), 'beard', s.beard.toFixed(2), 'lipstick', s.lipstick.toFixed(2), 'skin', s.skin.map(v=>v.toFixed(0)), s.warnings); }
await p.locator('#sheet').screenshot({ path: out });
await b.close();
