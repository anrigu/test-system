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
  vec3 col = mix(cm.rgb * uGainM, cd.rgb * uGainD, wD);
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
  float strand = vnoise(vec2(p.x * 0.09, p.y * 0.03) + uSeed) * 0.55 + vnoise(vec2(p.x * 0.6, p.y * 0.15)) * 0.25 + vnoise(p * 0.02) * 0.2;
  float grayMix = clamp(uGray * 1.1 + (strand - 0.5) * 0.9 * (1.0 - uGray * 0.6), 0.0, 1.0) * step(0.01, uGray);
  vec3 grayC = vec3(0.78, 0.77, 0.75) * (0.84 + 0.16 * clamp(log2(max(l, 0.05)), -1.5, 1.5) / 1.5);
  rec = mix(rec, grayC, grayMix);
  col = mix(col, rec, clamp(hair * 1.15, 0.0, 1.0));

  // Toddler hair length: clip long hair below a line.
  if (uHairClipY > 0.0) {
    float clipW = smoothstep(uHairClipY, uHairClipY + uU * 0.25, p.y) * smoothstep(0.35, 0.6, hair) * (1.0 - face);
    person *= 1.0 - clipW;
  }
  float skin = face * (1.0 - smoothstep(0.3, 0.8, hair));

  // ---- Baby head: the parent's head with a bigger cranium, fine thin hair, small body ----
  if (uBaby > 0.001) {
    vec2 hq = (p - uHead.xy) / uHead.zw;
    float hd = length(hq);
    float aa = 1.5 / uHead.z;
    float dx = abs(p.x - uCX);
    hd += (vnoise(p * 0.35 + uSeed) - 0.5) * 0.02 + (vnoise(p * 0.08) - 0.5) * 0.02;
    float cut = 1.0 - smoothstep(uEyeY + uU * 0.35, uEyeY + uU * 0.6, p.y);
    float headIn = (1.0 - smoothstep(1.0 - 3.0 * aa, 1.0 + 2.0 * aa, hd)) * cut;
    vec3 n = vec3(hq, sqrt(max(0.0, 1.0 - dot(hq, hq))));
    float light = clamp(0.55 + 0.45 * dot(n, normalize(vec3(-0.25, -0.45, 0.85))), 0.0, 1.0);
    vec3 fh = vec3(0.0); float fw = 0.0;
    for (int k = 0; k < 5; k++) {
      vec2 uv = uFh[k] / uSize;
      float hh = max(texture(uMaskM, uv).r, texture(uMaskD, uv).r);
      float w = 1.0 - smoothstep(0.2, 0.5, hh);
      fh += blendAt(uFh[k]) * w; fw += w;
    }
    vec3 fore = fw > 0.2 ? fh / fw : uSkinT;
    vec3 scalp = fore * (0.9 + 0.3 * (light - 0.75));
    float crown = smoothstep(0.15, -0.7, hq.y);
    float fuzzN = vnoise(vec2(p.x * 0.4 + p.y * 0.08, p.y * 0.1) + uSeed) * 0.6 + fbm(p * 0.03) * 0.4;
    vec3 babyHair = uHairT * (0.8 + 0.4 * light);
    vec3 fuzzScalp = mix(scalp, babyHair, clamp(uFuzz * crown * (0.35 + 0.9 * fuzzN), 0.0, 1.0));
    float show = clamp((1.0 - uFuzz) * (0.8 + 0.4 * vnoise(p * 0.7 + uSeed)), 0.0, 1.0);

    vec3 bcol = col; float bper = person;
    // long hair beyond the small head goes
    float notFace = 1.0 - smoothstep(0.3, 0.7, face);
    bper *= 1.0 - smoothstep(0.3, 0.7, hair) * (1.0 - headIn) * notFace;
    bper *= 1.0 - (1.0 - smoothstep(uEyeY + uU * 0.15, uEyeY + uU * 0.4, p.y)) * (1.0 - headIn) * notFace;
    // ears where the parent's are hidden
    for (int k = 0; k < 2; k++) {
      vec4 E = k == 0 ? uEarR : uEarL;
      float on = k == 0 ? uEarProc.x : uEarProc.y;
      vec2 eq = (p - E.xy) / E.zw;
      float ed = length(eq);
      float earIn = (1.0 - smoothstep(0.93, 1.05, ed)) * on * (1.0 - smoothstep(0.3, 0.7, bper));
      float outward = (k == 0 ? -eq.x : eq.x);
      float rim = smoothstep(0.6, 0.95, ed);
      float concha = 1.0 - smoothstep(0.2, 0.62, length((eq - vec2(k == 0 ? 0.2 : -0.2, 0.08)) * vec2(1.5, 1.0)));
      vec3 ear = fore * vec3(1.03, 0.93, 0.91) * (0.7 + 0.22 * smoothstep(-0.6, 0.7, outward) + 0.1 * rim) * (1.0 - 0.22 * concha);
      bcol = mix(bcol, ear, earIn); bper = max(bper, earIn);
    }
    // cranium: thin the hair, fill where the cranium is bigger than the parent's head
    vec3 headCol = mix(col, mix(col, fuzzScalp, show), smoothstep(0.2, 0.7, hair));
    headCol = mix(fuzzScalp, headCol, smoothstep(0.3, 0.8, person) * (1.0 - smoothstep(0.3, 0.7, hair) * (1.0 - smoothstep(0.85, 0.95, hd))));
    float headOnly = headIn * (1.0 - smoothstep(0.3, 0.7, face));
    bcol = mix(bcol, headCol, headOnly); bper = max(bper, headIn);
    // bangs on the forehead become skin
    bcol = mix(bcol, fore * (0.95 + 0.08 * vnoise(p * 0.05)), smoothstep(0.12, 0.5, hair) * smoothstep(0.3, 0.7, face) * (1.0 - headOnly));
    // Below the chin keep the parent's real neck and clothing folds, recoloured as a baby outfit.
    float below = smoothstep(uChinY - uU * 0.05, uChinY + uU * 0.12, p.y) * notFace;
    vec3 cn = col / max(luma(col), 0.02), sn = uSkinT / max(luma(uSkinT), 0.02);
    float skinLike = (1.0 - smoothstep(0.12, 0.3, length(cn - sn))) * smoothstep(0.35, 0.6, luma(col) / max(luma(uSkinT), 0.02));
    float clothes = below * (1.0 - skinLike * (1.0 - smoothstep(0.3, 0.7, hair)));
    float rel = clamp(luma(col) / max(uClothesL, 0.03), 0.3, 2.0);
    vec3 fab = knit(uFabric, p, uU) * clamp(0.78 + 0.28 * (rel - 1.0), 0.5, 1.15);
    bcol = mix(bcol, fab, clothes * smoothstep(0.2, 0.6, bper));
    float bskin = max(skin, headOnly * (1.0 - show * hair));

    if (uWrap > 0.5) {
      // knit newborn hat
      float hx = (p.x - uHead.x) / uHead.z;
      float brim = uHatBrim + uHatCurve * hx * hx;
      float hq2 = length((p - uHead.xy) / (uHead.zw * vec2(1.06, 1.05)));
      float hatIn = (1.0 - smoothstep(0.985, 1.0 + 3.0 * aa, hq2 + 0.02 * vnoise(p * 0.5))) * (1.0 - smoothstep(brim - 1.5, brim + 1.5, p.y));
      float v = (brim - p.y) / uU;
      vec3 hn = vec3(hx, (p.y - uHead.y) / uHead.w, 0.0); hn.z = sqrt(max(0.0, 1.0 - dot(hn.xy, hn.xy)));
      float hl = clamp(0.5 + 0.5 * dot(hn, normalize(vec3(-0.3, -0.5, 0.8))), 0.0, 1.0);
      float s1 = smoothstep(0.06, 0.075, v) * (1.0 - smoothstep(0.115, 0.13, v));
      float s2 = smoothstep(0.16, 0.175, v) * (1.0 - smoothstep(0.215, 0.23, v));
      vec3 hc = mix(vec3(0.95, 0.94, 0.92), uStripe1, s1); hc = mix(hc, uStripe2, s2);
      float ribs = 0.5 + 0.5 * sin(hx * 70.0);
      hc *= (0.6 + 0.44 * hl) * (0.93 + 0.07 * ribs);
      hc *= 1.0 - 0.22 * (smoothstep(0.24, 0.28, v) * (1.0 - smoothstep(0.28, 0.33, v)));
      hc += (vnoise(p * 0.8) - 0.5) * 0.04;
      float shadow = smoothstep(brim + uU * 0.12, brim, p.y) * (1.0 - hatIn);
      bcol *= 1.0 - 0.2 * shadow * smoothstep(0.02, 0.5, face);
      bcol = mix(bcol, hc, hatIn); bper = max(bper, hatIn);
      bskin *= 1.0 - hatIn;
      // hospital blanket wrapped up to the cheeks
      float ysw = uChinY - uU * 0.03 - uU * 1.05 * pow(smoothstep(uU * 0.4, uU * 1.75, dx), 1.3);
      float wob = (fbm(p * 0.02 + 5.0) - 0.5) * uU * 0.12;
      float sw = smoothstep(ysw + wob - 2.0, ysw + wob + 2.0, p.y) * (1.0 - smoothstep(0.55, 0.9, face) * (1.0 - smoothstep(uChinY - uU * 0.1, uChinY + uU * 0.1, p.y)));
      float bf = fbm(vec2(p.x * 0.012 + p.y * 0.008, p.y * 0.02 - p.x * 0.004) * 1.5);
      vec3 blank = vec3(0.96, 0.95, 0.93) * (0.75 + 0.35 * bf);
      float st = (p.y - ysw) / uU;
      float band1 = smoothstep(0.55, 0.58, st) * (1.0 - smoothstep(0.66, 0.69, st));
      float band2 = smoothstep(0.78, 0.81, st) * (1.0 - smoothstep(0.84, 0.87, st));
      blank = mix(blank, uStripe2 * (0.8 + 0.3 * bf), band1 * 0.85); blank = mix(blank, uStripe1 * (0.8 + 0.3 * bf), band2 * 0.85);
      blank *= 1.0 - 0.25 * smoothstep(uU * 0.18, 0.0, abs(p.y - ysw - wob)) * step(ysw + wob, p.y + 1.0);
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
uniform float uVignette, uGrain;

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
    vec3 nat = uSkinT * vec3(1.0, 0.72, 0.72);
    float L = luma(col);
    float Lt = mix(L, luma(uSkinT) * 0.8, 0.4);
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
    float dots = smoothstep(0.45, 0.85, hash12(floor(p * 0.85) + uSeed)) * 0.6 + vnoise(p * 0.5) * 0.4;
    float amt = bz * uStubble;
    col = mix(col, col * mix(vec3(0.86, 0.87, 0.9), uBeardColor * 1.2, 0.35), amt * (0.55 + 0.45 * dots));
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
  col *= 1.0 - wr.r * 0.3 * wm * vec3(1.0, 1.06, 1.12);
  col += wr.g * 0.045 * wm;

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
