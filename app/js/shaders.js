// GLSL ES 3.00 shaders for the portrait renderer. All textures use image space: v=0 is the top row.

export const COMMON = `#version 300 es
precision highp float;
precision highp int;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; } return s; }
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float spots(vec2 p, float cell, float density, float seed, float rmin, float rmax){
  vec2 c = floor(p / cell); float acc = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 cc = c + vec2(float(i), float(j));
    if (hash12(cc + seed) > density) continue;
    vec2 o = vec2(hash12(cc + seed + 17.1), hash12(cc + seed + 31.7));
    vec2 sp = (cc + o) * cell;
    float r = cell * mix(rmin, rmax, hash12(cc + seed + 7.3));
    float v = 1.0 - smoothstep(r * 0.35, r, length(p - sp));
    acc = max(acc, v * (0.55 + 0.45 * hash12(cc + seed + 3.9)));
  }
  return acc;
}
`;

export const FULL_VS = `#version 300 es
in vec2 aPos; out vec2 vUV; uniform float uFlip;
void main(){ vUV = aPos * 0.5 + 0.5; if (uFlip > 0.5) vUV.y = 1.0 - vUV.y; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const WARP_VS = `#version 300 es
in vec2 aPos; in vec2 aSrc; uniform vec2 uSize; out vec2 vSrc;
void main(){ vSrc = aSrc / uSize; gl_Position = vec4(aPos / uSize * 2.0 - 1.0, 0.0, 1.0); }`;

export const WARP_FS = `#version 300 es
precision highp float;
in vec2 vSrc; uniform sampler2D uCol; uniform sampler2D uMask;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
void main(){
  if (vSrc.x < 0.0 || vSrc.y < 0.0 || vSrc.x > 1.0 || vSrc.y > 1.0) { o0 = vec4(0.0); o1 = vec4(0.0); return; }
  o0 = texture(uCol, vSrc); o1 = texture(uMask, vSrc);
}`;

export const ATTR_VS = `#version 300 es
in vec2 aPos; in vec4 aA0; in vec4 aA1; in vec4 aA2; uniform vec2 uSize;
out vec4 v0; out vec4 v1; out vec4 v2;
void main(){ v0 = aA0; v1 = aA1; v2 = aA2; gl_Position = vec4(aPos / uSize * 2.0 - 1.0, 0.0, 1.0); }`;

export const ATTR_FS = `#version 300 es
precision highp float;
in vec4 v0; in vec4 v1; in vec4 v2; uniform float uFan;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1; layout(location=2) out vec4 o2;
void main(){
  if (uFan > 2.5) { o0 = vec4(0.0, 0.0, 0.0, 1.0); o1 = vec4(0.0); o2 = vec4(0.0); return; }
  if (uFan > 1.5) { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0, 0.0, 0.0, 1.0); return; }
  if (uFan > 0.5) { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(1.0, 0.0, 0.0, 0.0); return; }
  o0 = v0; o1 = v1; o2 = v2;
}`;

// Pass: blend both parents, recolour hair, rebuild a baby head, replace the background.
export const COMPOSE_FS = COMMON + `
in vec2 vUV; out vec4 o;
uniform sampler2D uColM, uColD, uMaskM, uMaskD, uAttr0, uAttr1, uAttr2;
uniform vec2 uSize; uniform float uU;
uniform vec3 uGainM, uGainD, uSkinT;
uniform float uBaseW; uniform vec3 uBgSrc;
uniform vec3 uHairSrc, uHairT; uniform float uHairRecolor, uGray, uSeed;
uniform vec3 uBg1, uBg2; uniform float uBgMode;
uniform float uBaby, uFuzz, uWrap, uHatBrim, uHatCurve;
uniform vec4 uHead; uniform vec4 uEarR; uniform vec4 uEarL; uniform vec2 uEarProc;
uniform float uChinY, uCX, uEyeY;
uniform vec3 uFabric, uFabric2, uStripe1, uStripe2;
uniform float uHairClipY, uClothesL;
uniform vec2 uFh[5];
uniform sampler2D uMidM, uLowM, uMidD, uLowD;
uniform float uLightFromBase, uFineBias, uHairTop, uBrowTop, uBabySoft;

vec3 backdrop(vec2 uv){
  float r = length((uv - vec2(0.5, 0.42)) * vec2(1.0, 1.15));
  vec3 c = mix(uBg1, uBg2, smoothstep(0.05, 0.85, r));
  c += (fbm(uv * 6.0 + 3.1) - 0.5) * 0.035;
  return c;
}

vec3 knit(vec3 base, vec2 p, float scale){
  float ribs = 0.5 + 0.5 * sin(p.x * 6.2831 / (scale * 0.045));
  float rows = 0.5 + 0.5 * sin(p.y * 6.2831 / (scale * 0.03) + ribs * 1.5);
  return base * (0.93 + 0.05 * ribs * rows + 0.04 * (vnoise(p * 0.5) - 0.5));
}

vec3 blendAt(vec2 px){
  vec2 uv = px / uSize;
  return 0.5 * (texture(uColM, uv).rgb * uGainM + texture(uColD, uv).rgb * uGainD);
}

void main(){
  vec2 p = vUV * uSize;
  vec4 a0 = texture(uAttr0, vUV); vec4 a1 = texture(uAttr1, vUV); vec4 a2 = texture(uAttr2, vUV);
  vec4 cm = texture(uColM, vUV), cd = texture(uColD, vUV);
  vec4 mm = texture(uMaskM, vUV), md = texture(uMaskD, vUV);
  float poly = a0.a;
  float face = a0.r * poly;
  float wD = mix(uBaseW, a0.g, poly);
  // Along the face outline, lean on whichever parent actually has face (not background) there.
  if (face > 0.001) {
    float wf = (wD * md.g) / max((1.0 - wD) * mm.g + wD * md.g, 1e-3);
    wD = mix(wD, wf, 1.0 - smoothstep(0.55, 0.95, face));
  }
  // Hair, fringe included, always comes from the parent whose hairstyle is used.
  float anyHair = max(mm.r, md.r);
  wD = mix(wD, uBaseW, smoothstep(0.2, 0.65, anyHair));

  // --- Band-separated merge of the two parents ---
  // 1. Lighting transfer: relight both parents to one low-frequency field (mostly the
  //    hairstyle parent's light, so face, hair and neck share the same illumination).
  vec3 XM = cm.rgb * uGainM, XD = cd.rgb * uGainD;
  vec3 LM = texture(uLowM, vUV).rgb * uGainM, LD = texture(uLowD, vUV).rgb * uGainD;
  vec3 QM = texture(uMidM, vUV).rgb * uGainM, QD = texture(uMidD, vUV).rgb * uGainD;
  vec3 LB = uBaseW > 0.5 ? LD : LM;
  vec3 Lt = mix(mix(LM, LD, wD), LB, uLightFromBase);
  float relight = smoothstep(0.0, 0.5, face) * (1.0 - smoothstep(0.25, 0.65, anyHair));
  vec3 rM = mix(vec3(1.0), clamp(Lt / max(LM, vec3(0.02)), 0.55, 1.8), relight);
  vec3 rD = mix(vec3(1.0), clamp(Lt / max(LD, vec3(0.02)), 0.55, 1.8), relight);
  // 2. Split into low (shading/colour), mid (feature edges, creases) and fine (pores, lashes) bands.
  vec3 lowM = LM * rM, lowD = LD * rD;
  vec3 midM = QM * rM - lowM, midD = QD * rD - lowD;
  vec3 fineM = XM * rM - QM * rM, fineD = XD * rD - QD * rD;
  // 3. Low band mixes smoothly; detail bands use sharper weights so edges don't double up.
  float wMid = clamp((wD - 0.5) * 1.6 + 0.5, 0.0, 1.0);
  float wFine = clamp((wD - 0.5) * 2.4 + 0.5 + uFineBias * smoothstep(0.0, 0.4, face), 0.0, 1.0);
  vec3 lowX = mix(lowM, lowD, wD);
  vec3 midX = mix(midM, midD, wMid);
  vec3 fineX = mix(fineM, fineD, wFine);
  // 4. Restore texture contrast lost by averaging (Tiddeman et al. texture enhancement).
  float aMid = mix(abs(luma(midM)), abs(luma(midD)), wMid), cMid = abs(luma(midX));
  float aFine = mix(abs(luma(fineM)), abs(luma(fineD)), wFine), cFine = abs(luma(fineX));
  midX *= clamp((aMid + 0.004) / (cMid + 0.004), 1.0, 1.35);
  fineX *= clamp((aFine + 0.003) / (cFine + 0.003), 1.0, 1.6);
  vec3 col = clamp(lowX + midX + fineX, 0.0, 1.0);
  vec4 bm = uBaseW > 0.5 ? md : mm;
  float hair = bm.r;
  float person = max(bm.g, smoothstep(0.0, 0.35, face));
  // Matting: remove the old background colour from soft edges.
  if (face < 0.3 && person > 0.3 && person < 0.98) {
    col = mix(col, clamp((col - (1.0 - person) * uBgSrc) / max(person, 0.5), 0.0, 1.0), 1.0 - face / 0.3);
  }
  person = smoothstep(0.12, 0.9, person);

  // Hair colour + greying (luminance-preserving recolour).
  float l = clamp(luma(col) / max(luma(uHairSrc), 0.03), 0.0, 3.0);
  vec3 rec = mix(col, uHairT * pow(l, 0.85), uHairRecolor);
  float strand = vnoise(vec2(p.x * 0.05, p.y * 0.02) + uSeed) * 0.6 + vnoise(p * 0.015) * 0.4;
  float grayMix = clamp(uGray * 1.15 + (strand - 0.5) * 0.5 * (1.0 - uGray * 0.7), 0.0, 1.0) * step(0.01, uGray);
  // Grey keeps the hair's own light and shadow (strands, parting, volume), only the pigment goes.
  vec3 grayC = vec3(0.85, 0.83, 0.79) * clamp(0.78 + 0.13 * log2(max(l, 0.05)), 0.5, 1.0);
  rec = mix(rec, grayC, grayMix);
  col = mix(col, rec, clamp(hair * 1.15, 0.0, 1.0));

  // Toddler hair length: clip long hair below a line.
  if (uHairClipY > 0.0) {
    float clipW = smoothstep(uHairClipY, uHairClipY + uU * 0.25, p.y) * smoothstep(0.35, 0.6, hair) * (1.0 - face);
    person *= 1.0 - clipW;
  }
  float skin = face * (1.0 - smoothstep(0.3, 0.8, hair));

  // ---- Babies and toddlers from the parent's real head: soft fine hair, baby-length, soft clothes ----
  if (uBabySoft > 0.001) {
    float notFaceS = 1.0 - smoothstep(0.3, 0.7, face);
    vec3 QB = uBaseW > 0.5 ? QD : QM;
    vec3 LBb = uBaseW > 0.5 ? LD : LM;
    // Fine baby hair: the hairstyle's own shading, blurred (no styled strands), lighter and softer.
    float lb = clamp(luma(QB) / max(luma(uHairSrc), 0.03), 0.0, 3.0);
    vec3 softHair = mix(QB, uHairT * pow(lb, 0.7), uHairRecolor);
    softHair = mix(softHair, softHair * 0.85 + uHairT * 0.25 + 0.02, 0.5);
    vec3 scalpS = uSkinT * clamp(luma(LBb) / max(luma(uSkinT), 0.05), 0.6, 1.15);
    // sparse at the hairline, fuller toward the crown
    float hairEdge = smoothstep(0.35, 0.95, hair);
    float thin = (1.0 - uFuzz) * (0.75 + 0.25 * (1.0 - hairEdge));
    vec3 babyHair = mix(softHair, scalpS, thin * 0.5);
    col = mix(col, babyHair, clamp(hair * 1.2, 0.0, 1.0) * uBabySoft);
    // Long hair stops at about ear level, and big hairdos shrink to a soft baby-head outline.
    float longHair = smoothstep(0.3, 0.6, hair) * smoothstep(uEyeY + uU * 0.12, uEyeY + uU * 0.42, p.y) * notFaceS;
    float hdS = length((p - uHead.xy) / (uHead.zw * 1.06)) + (fbm(p * 0.02 + uSeed) - 0.5) * 0.06;
    float volume = smoothstep(0.3, 0.6, hair) * smoothstep(0.97, 1.1, hdS) * notFaceS;
    person *= 1.0 - max(longHair, volume) * uBabySoft;
    // Clothes: soft-focus pastel cotton keeping the real fold shading.
    float belowS = smoothstep(uChinY - uU * 0.06, uChinY + uU * 0.08, p.y) * (1.0 - smoothstep(0.65, 0.95, face));
    vec3 cnS = col / max(luma(col), 0.02), snS = uSkinT / max(luma(uSkinT), 0.02);
    float skinLikeS = (1.0 - smoothstep(0.12, 0.3, length(cnS - snS))) * smoothstep(0.35, 0.6, luma(col) / max(luma(uSkinT), 0.02));
    float clothS = belowS * (1.0 - skinLikeS) * (1.0 - smoothstep(0.3, 0.7, hair));
    float relS = clamp(luma(QB) / max(uClothesL, 0.03), 0.4, 1.8);
    float foldS = fbm(vec2(p.x * 0.006 - p.y * 0.003, p.y * 0.005 + p.x * 0.002) + 7.0);
    vec3 cotton = uFabric * clamp(0.84 + 0.18 * (relS - 1.0) + 0.12 * (foldS - 0.5), 0.6, 1.08);
    col = mix(col, cotton, clothS * uBabySoft);
  }

  // ---- Baby (0-2.5): build a baby head instead of shrinking the parent's hairstyle ----
  // Round cranium lit like the face, soft fine hair growing from a crown whorl with a diffuse
  // hairline, small ears, short neck, cotton onesie. Optional newborn knit hat and swaddle.
  if (uBaby > 0.001) {
    vec2 hq = (p - uHead.xy) / uHead.zw;
    float hd = length(hq);
    float aa = 2.0 / uHead.z;
    float dx = abs(p.x - uCX);
    float faceM = smoothstep(0.02, 0.5, face);
    float notFace = 1.0 - smoothstep(0.3, 0.7, face);
    // Skin and light direction sampled from the merged forehead (hair-free taps only).
    vec3 fh = vec3(0.0); float fw = 0.0; float lx = 0.0;
    for (int k = 0; k < 5; k++) {
      vec2 uv = uFh[k] / uSize;
      float hh = max(texture(uMaskM, uv).r, texture(uMaskD, uv).r);
      float w = 1.0 - smoothstep(0.2, 0.5, hh);
      vec3 c = blendAt(uFh[k]);
      fh += c * w; fw += w;
      if (k == 1) lx -= luma(c) * w; if (k == 2) lx += luma(c) * w;
    }
    vec3 fore = fw > 0.2 ? fh / fw : uSkinT;
    float lightX = clamp(lx / max(luma(fore), 0.05) * 1.5, -0.6, 0.6);
    vec3 L = normalize(vec3(lightX, -0.45, 0.85));
    vec3 n = normalize(vec3(hq, sqrt(max(0.02, 1.0 - dot(hq, hq)))));
    float shade = clamp((0.56 + 0.5 * dot(n, L)) * (0.84 + 0.16 * n.z), 0.3, 1.08);
    float cut = 1.0 - smoothstep(uEyeY + uU * 0.25, uEyeY + uU * 0.55, p.y);
    float headIn = (1.0 - smoothstep(1.0 - aa, 1.0 + aa, hd)) * cut;
    vec3 scalp = fore * (0.94 + 0.34 * (shade - 0.8)) * vec3(1.0, 0.985, 0.98);
    // fine baby hair: strands radiate from a crown whorl, hairline soft and low at the temples
    vec2 crown = uHead.xy + vec2(uHead.z * 0.12, -uHead.w * 0.72);
    vec2 dir = normalize(p - crown + vec2(0.001));
    vec2 across = vec2(-dir.y, dir.x);
    float wisp = vnoise(vec2(dot(p, across) * 0.45, dot(p, dir) * 0.035) + uSeed) * 0.5 + vnoise(vec2(dot(p, across) * 1.2, dot(p, dir) * 0.08)) * 0.2 + fbm(p * 0.012 + uSeed) * 0.3;
    float hl = min(uHairTop + uU * (0.06 + 0.42 * pow(dx / uU, 2.0)), uEyeY - uU * 0.1);
    float zone = smoothstep(hl + uU * 0.16, hl - uU * 0.12, p.y) * smoothstep(1.06, 0.9, hd);
    float hairA = clamp(uFuzz * zone * (0.35 + 0.75 * wisp), 0.0, 0.92);
    vec3 hairC = mix(uHairT, scalp, 0.15) * (0.72 + 0.45 * shade) * (0.94 + 0.1 * wisp);
    vec3 headCol = mix(scalp, hairC, hairA);
    float fuzzRim = uFuzz * zone * smoothstep(0.98, 1.02, hd) * (1.0 - smoothstep(1.02, 1.06, hd)) * step(0.55, wisp) * cut;

    vec3 bcol = backdrop(vUV); float bper = 0.0;
    // onesie: soft cotton, sloping shoulders, ribbed crew neck; slightly soft focus
    float sh = max(0.0, dx - uU * 0.42);
    float bodyTop = uChinY + uU * 0.06 + uU * 0.62 * pow(smoothstep(uU * 0.3, uU * 2.0, dx), 1.15);
    float bodyIn = smoothstep(bodyTop - 2.5, bodyTop + 2.5, p.y) * (1.0 - smoothstep(uU * 2.3, uU * 2.45, dx));
    float f1 = fbm(vec2(p.x * 0.006 - p.y * 0.003, p.y * 0.005 + p.x * 0.002) + 7.0);
    float f2 = 0.5 + 0.5 * sin((p.x * 0.6 + p.y) / uU * 3.0 + f1 * 6.0);
    vec3 fab = uFabric * (0.86 + 0.1 * f1 + 0.07 * f2) * (0.78 + 0.22 * cos(clamp(dx / (uU * 2.3), 0.0, 1.0) * 1.5708));
    fab *= 1.0 + (vnoise(p * 0.8) - 0.5) * 0.03;
    float rib = (1.0 - smoothstep(bodyTop + uU * 0.06, bodyTop + uU * 0.075, p.y)) * (1.0 - smoothstep(uU * 0.75, uU * 0.95, dx));
    fab = mix(fab, uFabric2 * (0.88 + 0.06 * sin(p.x * 0.9)), rib * 0.85);
    fab *= 1.0 - 0.28 * smoothstep(uU * 0.18, 0.0, p.y - bodyTop) * (1.0 - smoothstep(uU * 0.45, uU * 0.9, dx));
    // short chubby neck in the shadow of the chin
    float neckIn = (1.0 - smoothstep(uU * 0.3, uU * 0.42, dx)) * smoothstep(uChinY - uU * 0.3, uChinY - uU * 0.22, p.y);
    vec3 neck = fore * mix(0.6, 0.82, smoothstep(uChinY, uChinY + uU * 0.12, p.y));
    bcol = mix(bcol, neck, neckIn); bper = max(bper, neckIn);
    bcol = mix(bcol, fab, bodyIn); bper = max(bper, bodyIn);
    // ears
    for (int k = 0; k < 2; k++) {
      vec4 E = k == 0 ? uEarR : uEarL;
      vec2 eq = (p - E.xy) / E.zw;
      float ed = length(eq);
      float earIn = 1.0 - smoothstep(0.92, 1.06, ed);
      float outward = (k == 0 ? -eq.x : eq.x);
      float rim = smoothstep(0.55, 0.95, ed);
      float concha = 1.0 - smoothstep(0.15, 0.6, length((eq - vec2(k == 0 ? 0.22 : -0.22, 0.1)) * vec2(1.5, 1.0)));
      vec3 ear = fore * vec3(1.04, 0.92, 0.9) * (0.66 + 0.24 * smoothstep(-0.6, 0.7, outward) + 0.12 * rim * shade) * (1.0 - 0.25 * concha);
      bcol = mix(bcol, ear, earIn); bper = max(bper, earIn);
    }
    // cranium, then the merged face on top with the same soft hair over the hairline
    bcol = mix(bcol, headCol, headIn); bper = max(bper, headIn);
    bcol = mix(bcol, hairC, fuzzRim * 0.55); bper = max(bper, fuzzRim * 0.55);
    faceM *= smoothstep(uBrowTop - uU * 0.62, uBrowTop - uU * 0.32, p.y) * (1.0 - headIn * (1.0 - smoothstep(0.3, 0.9, face))) + headIn * 0.0;
    faceM = max(faceM, smoothstep(0.55, 0.9, face) * smoothstep(uBrowTop - uU * 0.62, uBrowTop - uU * 0.32, p.y));
    vec3 fcol = mix(col, scalp, smoothstep(0.12, 0.5, hair));
    fcol = mix(fcol, hairC, hairA * smoothstep(0.2, 0.8, face) * smoothstep(hl + uU * 0.1, hl - uU * 0.05, p.y));
    bcol = mix(bcol, fcol, faceM); bper = max(bper, faceM);
    float bskin = max(faceM * (1.0 - hairA), headIn * (1.0 - hairA) * (1.0 - faceM));

    if (uWrap > 0.5) {
      // stretchy knit newborn cap with two soft stripes on the folded cuff
      float hx = (p.x - uHead.x) / uHead.z;
      float brim = uHatBrim + uHatCurve * hx * hx;
      vec2 hq2 = (p - uHead.xy) / (uHead.zw * vec2(1.05, 1.04));
      float edgeN = (vnoise(p * 0.6) - 0.5) * 0.015;
      float hatIn = (1.0 - smoothstep(1.0 - aa, 1.0 + 2.0 * aa, length(hq2) + edgeN)) * (1.0 - smoothstep(brim - 2.0, brim + 2.0, p.y));
      float v = (brim - p.y) / uU;
      vec3 hn = normalize(vec3(hq2, sqrt(max(0.02, 1.0 - dot(hq2, hq2)))));
      float hs = clamp(0.55 + 0.5 * dot(hn, L), 0.3, 1.05);
      float stitch = abs(fract(hx * 38.0) - 0.5) * 2.0;
      float row = abs(fract(v * 26.0 + stitch * 0.35) - 0.5) * 2.0;
      vec3 hc = vec3(0.95, 0.94, 0.91) * (0.96 + 0.035 * stitch + 0.02 * row);
      float s1 = smoothstep(0.07, 0.085, v) * (1.0 - smoothstep(0.115, 0.13, v));
      float s2 = smoothstep(0.16, 0.175, v) * (1.0 - smoothstep(0.205, 0.22, v));
      hc = mix(hc, uStripe1 * (0.95 + 0.04 * stitch), s1 * 0.75); hc = mix(hc, uStripe2 * (0.95 + 0.04 * stitch), s2 * 0.75);
      float cuffLine = smoothstep(0.25, 0.27, v) * (1.0 - smoothstep(0.27, 0.31, v));
      hc *= hs * (1.0 - 0.12 * cuffLine);
      float shadow = smoothstep(brim + uU * 0.1, brim, p.y) * (1.0 - hatIn);
      bcol *= 1.0 - 0.18 * shadow * faceM;
      bcol = mix(bcol, hc, hatIn); bper = max(bper, hatIn);
      bskin *= 1.0 - hatIn;
      // flannel receiving blanket wrapped up to the cheeks
      float ysw = uChinY - uU * 0.03 - uU * 1.05 * pow(smoothstep(uU * 0.4, uU * 1.75, dx), 1.3);
      float wob = (fbm(p * 0.015 + 5.0) - 0.5) * uU * 0.1;
      float sw = smoothstep(ysw + wob - 2.5, ysw + wob + 2.5, p.y) * (1.0 - smoothstep(0.55, 0.9, face) * (1.0 - smoothstep(uChinY - uU * 0.1, uChinY + uU * 0.1, p.y)));
      float g1 = fbm(vec2(p.x * 0.004 + p.y * 0.003, p.y * 0.004 - p.x * 0.002) + 3.0);
      float fold = 0.5 + 0.5 * sin((p.x * 0.8 - p.y * 0.6) / uU * 2.4 + g1 * 7.0);
      float fold2 = 0.5 + 0.5 * sin((p.x * 0.3 + p.y) / uU * 3.1 + g1 * 5.0);
      float bshade = 0.78 + 0.16 * fold + 0.08 * fold2 + 0.06 * (g1 - 0.5);
      vec3 blank = vec3(0.95, 0.94, 0.92) * bshade * (1.0 + (vnoise(p * 0.7) - 0.5) * 0.02);
      float st = (p.y - ysw) / uU + (g1 - 0.5) * 0.15;
      float band1 = smoothstep(0.55, 0.58, st) * (1.0 - smoothstep(0.65, 0.68, st));
      float band2 = smoothstep(0.76, 0.79, st) * (1.0 - smoothstep(0.83, 0.86, st));
      blank = mix(blank, uStripe2 * bshade, band1 * 0.6); blank = mix(blank, uStripe1 * bshade, band2 * 0.6);
      blank *= 1.0 - 0.22 * smoothstep(uU * 0.16, 0.0, abs(p.y - ysw - wob)) * step(ysw + wob, p.y + 1.0);
      bcol = mix(bcol, blank, sw); bper = max(bper, sw);
      bskin *= 1.0 - sw;
    }
    col = mix(col, bcol, uBaby);
    person = mix(person, bper, uBaby);
    skin = mix(skin, bskin, uBaby);
  }

  vec3 bg = uBgMode > 0.5 ? backdrop(vUV) : col;
  vec3 outc = mix(bg, col, clamp(person, 0.0, 1.0));
  o = vec4(outc, skin * (1.0 - a2.r));
}
`;

export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 o; uniform sampler2D uTex; uniform vec2 uDir;
void main(){
  vec4 s = texture(uTex, vUV) * 0.2270270270;
  s += (texture(uTex, vUV + uDir * 1.3846153846) + texture(uTex, vUV - uDir * 1.3846153846)) * 0.3162162162;
  s += (texture(uTex, vUV + uDir * 3.2307692308) + texture(uTex, vUV - uDir * 3.2307692308)) * 0.0702702703;
  o = s;
}`;

// Pass: skin, brows, eyes, lips, facial hair, wrinkles, spots, grading, grain.
export const FINAL_FS = COMMON + `
in vec2 vUV; out vec4 o;
uniform sampler2D uComp, uBlur1, uBlur2, uAttr0, uAttr1, uAttr2, uWrinkle;
uniform vec2 uSize; uniform float uU, uSeed;
uniform float uSmooth, uSmoothBig, uBrowFade, uBrowOff, uRosy, uBabySkin, uLipNat;
uniform vec3 uSkinT, uLipSrc;
uniform vec4 uIrisR, uIrisL; uniform float uIrisMag, uEyeRecolor; uniform vec3 uEyeColor; uniform float uIrisSrcL;
uniform float uStubble, uBeard, uMustache; uniform vec3 uBeardColor;
uniform float uWrinkleAmt, uFreckles, uAgeSpots, uAcne, uSkinAge, uUnderEye;
uniform float uVignette, uGrain, uAgeDetail, uSkinGrain;

vec3 sampleC(vec2 px){ return texture(uComp, px / uSize).rgb; }

void main(){
  vec2 p = vUV * uSize;
  vec4 c0 = texture(uComp, vUV);
  vec3 col = c0.rgb; float skin = c0.a;
  vec4 a0 = texture(uAttr0, vUV), a1 = texture(uAttr1, vUV), a2 = texture(uAttr2, vUV);
  vec3 b1 = texture(uBlur1, vUV).rgb, b2 = texture(uBlur2, vUV).rgb;

  // Skin smoothing (frequency separation, protect strong edges).
  vec3 det = col - b1;
  float keep = smoothstep(0.05, 0.2, length(det));
  col = col - det * uSmooth * skin * (1.0 - keep * 0.7);
  vec3 det2 = b1 - b2;
  float keep2 = smoothstep(0.06, 0.18, length(det2));
  col = col - det2 * uSmoothBig * skin * (1.0 - keep2);
  // Older skin: amplify the face's own mid-scale texture (creases, pores) rather than paint it on.
  col += det2 * uAgeDetail * skin * (1.0 - keep2 * 0.5);
  // Young skin keeps a fine photographic grain so smoothing never looks plastic.
  float pore = (vnoise(p * 0.75 + uSeed) - 0.5) * 0.6 + (hash12(floor(p) + uSeed) - 0.5) * 0.4;
  col *= 1.0 + pore * uSkinGrain * skin;

  // Fade eyebrows into the surrounding skin (babies have faint brows).
  float bw = a0.b * uBrowFade;
  if (bw > 0.002) {
    vec2 off = vec2(0.0, uBrowOff);
    vec3 up = texture(uBlur2, (p - off) / uSize).rgb, dn = texture(uBlur2, (p + off) / uSize).rgb;
    vec3 fill = mix(up, dn, 0.45);
    col = mix(col, fill + det * 0.15, clamp(bw, 0.0, 1.0));
  }

  // Lip colour: natural tone (removes lipstick on children / boys). Soft mask from the lip polygon.
  vec2 px1 = vec2(1.5) / uSize;
  float lipM = 0.2 * (a2.a + texture(uAttr2, vUV + px1).a + texture(uAttr2, vUV - px1).a
             + texture(uAttr2, vUV + vec2(px1.x, -px1.y)).a + texture(uAttr2, vUV - vec2(px1.x, -px1.y)).a);
  float lw = lipM * uLipNat;
  if (lw > 0.002) {
    vec3 nat = mix(uSkinT, uSkinT * vec3(1.0, 0.74, 0.76), 0.75);
    float L = luma(col);
    float Lt = mix(L, luma(uSkinT) * 0.78, 0.45);
    col = mix(col, nat * (Lt / max(luma(nat), 0.03)), clamp(lw, 0.0, 1.0));
  }

  // Eyes: enlarge irises (babies) and set the eye colour.
  float eo = a2.r;
  if (eo > 0.01) {
    for (int k = 0; k < 2; k++) {
      vec4 I = k == 0 ? uIrisR : uIrisL;
      vec2 d = p - I.xy;
      float rr = length(d) / (I.z * uIrisMag);
      if (rr < 1.25) {
        vec3 s = sampleC(I.xy + d / uIrisMag);
        float wMag = eo * (1.0 - smoothstep(0.92, 1.12, rr)) * step(1.001, uIrisMag);
        col = mix(col, s, wMag);
        float L = luma(col);
        float annulus = smoothstep(0.30, 0.42, rr) * (1.0 - smoothstep(0.86, 1.0, rr));
        float spec = smoothstep(0.55, 0.75, L);
        float tex = clamp(L / max(uIrisSrcL, 0.03), 0.35, 2.2);
        vec3 ic = uEyeColor * tex * (1.0 - 0.35 * smoothstep(0.78, 0.98, rr));
        col = mix(col, ic, annulus * eo * uEyeRecolor * (1.0 - spec));
      }
    }
  }

  // Rosy cheeks / baby skin tone.
  col = mix(col, col * vec3(1.07, 0.92, 0.92), a1.g * uRosy * skin);
  col = mix(col, col * vec3(1.03, 0.995, 0.985) + vec3(0.025, 0.012, 0.012), uBabySkin * skin);

  // Freckles (nose + cheeks), age spots, teenage breakouts.
  float fz = a1.a;
  if (uFreckles > 0.01) {
    float f = spots(p, uU * 0.055, 0.55 * uFreckles, 11.0 + uSeed, 0.18, 0.42);
    col *= 1.0 - f * fz * skin * vec3(0.18, 0.27, 0.36) * uFreckles;
  }
  if (uAgeSpots > 0.01) {
    float s = spots(p, uU * 0.22, 0.32 * uAgeSpots, 53.0 + uSeed, 0.15, 0.45);
    float zone = clamp(a1.b + a1.g + 0.4, 0.0, 1.0);
    col *= 1.0 - s * zone * skin * vec3(0.13, 0.19, 0.26) * uAgeSpots;
  }
  if (uAcne > 0.01) {
    float s = spots(p, uU * 0.13, 0.22 * uAcne, 91.0 + uSeed, 0.1, 0.22);
    float zone = clamp(a1.b * 1.2 + a1.r * 0.8 + a1.a * 0.5, 0.0, 1.0);
    col = mix(col, col * vec3(1.02, 0.84, 0.82), s * zone * skin * uAcne);
  }

  // Facial hair: teenage moustache fuzz, stubble or full beard.
  float bz = a1.r * smoothstep(0.1, 0.5, a0.r * a0.a) * (1.0 - lipM);
  float must = a2.b * (1.0 - lipM);
  if (uMustache > 0.01) {
    float n = vnoise(p * 0.8 + uSeed);
    col *= 1.0 - must * uMustache * (0.12 + 0.12 * n);
  }
  if (uStubble > 0.01) {
    // Beard shadow: a soft blue-grey cast with very fine, low-contrast follicle texture.
    float dots = vnoise(p * 0.9 + uSeed) * 0.5 + vnoise(p * 0.35) * 0.5;
    float amt = bz * uStubble;
    vec3 shadowTint = mix(vec3(0.84, 0.85, 0.88), uBeardColor * 1.3 + 0.25, 0.3);
    col = mix(col, col * shadowTint, amt * (0.75 + 0.25 * dots));
  }
  if (uBeard > 0.01) {
    float strands = vnoise(vec2(p.x * 0.45, p.y * 0.09) + uSeed) * 0.6 + vnoise(p * 0.7) * 0.4;
    float edge = smoothstep(0.15, 0.55, bz + 0.15 * (strands - 0.5));
    vec3 bc = uBeardColor * (0.55 + 0.8 * strands) * (0.85 + 0.25 * luma(b2));
    col = mix(col, bc, edge * uBeard * 0.92);
  }

  // Wrinkles (drawn per age on a separate layer): r = crease shadow, g = highlight.
  vec2 wp = vec2(2.0) / uSize;
  vec4 wr = 0.4 * texture(uWrinkle, vUV) + 0.15 * (texture(uWrinkle, vUV + wp) + texture(uWrinkle, vUV - wp)
          + texture(uWrinkle, vUV + vec2(wp.x, -wp.y)) + texture(uWrinkle, vUV - vec2(wp.x, -wp.y)));
  float wm = uWrinkleAmt * clamp(skin + 0.25 * a0.r * a0.a, 0.0, 1.0);
  col *= 1.0 - wr.r * 0.17 * wm * vec3(1.0, 1.05, 1.1);
  col += wr.g * 0.04 * wm;

  // Skin ageing: crepey texture, duller, slightly sallow, darker under the eyes, greying brows.
  float crepe = fbm(p * 0.33 + uSeed) - 0.5;
  float crepe2 = vnoise(vec2(p.x * 0.9 + p.y * 0.4, p.y * 0.25)) - 0.5;
  col *= 1.0 - uSkinAge * skin * (crepe * 0.1 + crepe2 * 0.06);
  col = mix(col, vec3(min(1.0, luma(col) * 1.45 + 0.08)), a0.b * smoothstep(0.35, 0.8, uSkinAge) * 0.55);
  col = mix(col, vec3(luma(col)), 0.22 * uSkinAge * skin);
  col *= mix(vec3(1.0), vec3(1.02, 0.99, 0.93), uSkinAge * skin);
  col *= 1.0 - a2.g * uUnderEye * vec3(0.16, 0.2, 0.17);

  // Photographic finish: gentle vignette + grain.
  float vr = length((vUV - vec2(0.5, 0.45)) * vec2(1.0, 0.85));
  col *= 1.0 - uVignette * smoothstep(0.35, 0.85, vr);
  col += (hash12(p + uSeed * 13.0) - 0.5) * uGrain;
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const COPY_FS = `#version 300 es
precision highp float; in vec2 vUV; out vec4 o; uniform sampler2D uTex;
void main(){ o = vec4(texture(uTex, vUV).rgb, 1.0); }`;
