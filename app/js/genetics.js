// Simple, openly approximate inheritance estimates. Real traits are polygenic; these are
// the textbook simplified models, shown as rough odds rather than predictions.

export const EYE_LABEL = { darkbrown: 'Dark brown', brown: 'Brown', hazel: 'Hazel', green: 'Green', blue: 'Blue', gray: 'Grey' };
export const HAIR_LABEL = { black: 'Black', darkbrown: 'Dark brown', brown: 'Brown', lightbrown: 'Light brown', blonde: 'Blonde', red: 'Red', gray: 'Grey' };

const eyeGroup = (c) => (c === 'brown' || c === 'darkbrown') ? 'brown' : (c === 'green' || c === 'hazel') ? 'green' : 'blue';

// Two-gene (bey2/gey) teaching model: brown > green > blue.
const EYE_TABLE = {
  'brown|brown': { brown: 0.75, green: 0.1875, blue: 0.0625 },
  'brown|green': { brown: 0.5, green: 0.375, blue: 0.125 },
  'blue|brown': { brown: 0.5, green: 0, blue: 0.5 },
  'green|green': { brown: 0.01, green: 0.74, blue: 0.25 },
  'blue|green': { brown: 0, green: 0.5, blue: 0.5 },
  'blue|blue': { brown: 0, green: 0.01, blue: 0.99 },
};

/** Returns [{key, p}] sorted by probability; key is a renderable eye colour. */
export function eyeOdds(mom, dad) {
  const a = eyeGroup(mom), b = eyeGroup(dad);
  const t = EYE_TABLE[[a, b].sort().join('|')];
  const brownKey = (mom === 'darkbrown' && dad === 'darkbrown') ? 'darkbrown' : 'brown';
  const greenKey = (mom === 'hazel' || dad === 'hazel') ? 'hazel' : 'green';
  const blueKey = (mom === 'gray' && dad === 'gray') ? 'gray' : 'blue';
  return [
    { key: brownKey, p: t.brown }, { key: greenKey, p: t.green }, { key: blueKey, p: t.blue },
  ].filter((o) => o.p > 0.004).sort((x, y) => y.p - x.p);
}

const DARK = { black: 4, darkbrown: 3, brown: 2, lightbrown: 1, blonde: 0 };
const LEVELS = ['blonde', 'lightbrown', 'brown', 'darkbrown', 'black'];

/** Hair colour odds: darkness blends with a slight dark bias; red is recessive. */
export function hairOdds(mom, dad) {
  const d = (c) => DARK[c] ?? 2;
  const mean = (d(mom) + d(dad)) / 2 + 0.25;
  const sigma = 0.85;
  let probs = LEVELS.map((k, i) => ({ key: k, p: Math.exp(-0.5 * ((i - mean) / sigma) ** 2) }));
  const reds = (mom === 'red') + (dad === 'red');
  const pRed = reds === 2 ? 0.8 : reds === 1 ? 0.22 : 0.03;
  const sum = probs.reduce((s, o) => s + o.p, 0);
  probs = probs.map((o) => ({ ...o, p: (o.p / sum) * (1 - pRed) }));
  probs.push({ key: 'red', p: pRed });
  return probs.filter((o) => o.p > 0.02).sort((x, y) => y.p - x.p);
}

// CDC 50th-percentile stature (cm) for ages 0-20, used only for the curve's shape.
const MEDIAN_BOY = [[0, 50], [0.5, 67.5], [1, 76], [2, 87], [3, 95], [4, 102.5], [5, 109], [6, 115.5], [7, 121.5], [8, 127.5], [9, 133], [10, 138.5], [11, 143.5], [12, 149.5], [13, 156.5], [14, 164], [15, 170], [16, 173.5], [17, 175.5], [18, 176.5], [20, 177]];
const MEDIAN_GIRL = [[0, 49], [0.5, 65.7], [1, 74], [2, 85.5], [3, 94], [4, 101], [5, 108], [6, 115], [7, 121], [8, 127], [9, 133], [10, 138.5], [11, 144.5], [12, 151], [13, 156.5], [14, 159.5], [15, 161.5], [16, 162.5], [17, 163], [18, 163.5], [20, 163.5]];

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/** Mid-parental target height (cm) and the usual +/- 8.5 cm range. */
export function adultHeight(momCm, dadCm, sex) {
  const target = (momCm + dadCm + (sex === 'boy' ? 13 : -13)) / 2;
  return { target, low: target - 8.5, high: target + 8.5 };
}

/** Expected height at an age, scaling the median curve to the family's target. */
export function heightAt(age, sex, target) {
  const table = sex === 'boy' ? MEDIAN_BOY : MEDIAN_GIRL;
  const adult = table[table.length - 1][1];
  const childScale = 1 + (target / adult - 1) * Math.min(1, Math.max(0, (age - 0.5) / 12));
  let h = interp(table, Math.min(age, 20)) * (age >= 20 ? target / adult : childScale);
  if (age > 50) h -= (age - 50) * 0.08 + Math.max(0, age - 70) * 0.12; // gradual shrinking later in life
  return h;
}

export const cmToFtIn = (cm) => {
  const inches = cm / 2.54;
  const ft = Math.floor(inches / 12);
  return `${ft}′${Math.round(inches - ft * 12)}″`;
};

/** Short, factual notes for each life stage. */
export function stageNote(age, sex) {
  const boy = sex === 'boy';
  if (age < 0.25) return 'Newborn. Light eyes often start out slate blue; final colour settles between 1 and 3.';
  if (age < 0.8) return 'Infant. Cheeks fill out, hair is fine and light, first teeth are on the way.';
  if (age < 1.6) return 'Around 1. Baby fat peaks; the forehead is large and the nose small and upturned.';
  if (age < 2.6) return 'Toddler. Hair thickens and usually darkens over the next few years.';
  if (age < 4.5) return 'Preschool. Round cheeks, small chin, big eyes for the face.';
  if (age < 8) return 'Early school years. Baby teeth fall out; the nose and jaw start to lengthen.';
  if (age < 11) return 'Middle childhood. The face lengthens and narrows ahead of puberty.';
  if (age < 14) return boy ? 'Early puberty. Growth spurt is close; the first upper-lip fuzz appears.' : 'Puberty. Peak growth spurt; lips fill out and baby fat leaves the cheeks.';
  if (age < 17) return boy ? 'Peak puberty. Jaw, chin and nose grow fastest; the brow ridge firms up.' : 'Late teens. Most growth is done and the adult face shape settles.';
  if (age < 24) return boy ? 'Young adult. Facial bones finish growing; beard fills in.' : 'Young adult. Facial bones finish growing.';
  if (age < 38) return 'Adult. Fine lines start at the eyes and forehead.';
  if (age < 52) return 'Midlife. Laugh lines deepen and the first grey hairs show.';
  if (age < 68) return 'Sixties. Skin thins and loses volume; lines around the mouth deepen.';
  if (age < 82) return 'Seventies. Hair mostly grey or white; age spots appear.';
  return 'Late life. Softer jawline, thinner lips, a lifetime of family resemblance.';
}

export function ageLabel(age) {
  if (age < 0.08) return 'Newborn';
  if (age < 1) return `${Math.max(1, Math.round(age * 12))} months`;
  if (age < 1.5) return '1 year';
  return `${Math.round(age)} years`;
}
