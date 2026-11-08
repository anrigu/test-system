# Baby Face Forecast

Take one photo of each parent on your phone and see your future daughter and son, from
newborn through toddlerhood, school age, puberty, adulthood and old age (0 to 90).

Everything runs in the phone's browser. Face detection, blending and rendering happen on the
device; photos are never uploaded. (The only exception is the optional "Read traits with Claude"
button, which sends two face crops to Claude once, and only when you tap it.)

## Features

- **Camera capture**: take each parent's photo with the phone camera or pick one from the library.
  Photo checks warn about a turned head, closed eyes, open mouth, big smile, dark or uneven light,
  small faces and cropped heads.
- **Girl and boy side by side** at any age, with a growth-chart age ruler and "Play a lifetime" animation.
- **Photographic merging** of the two faces, using techniques from face-morphing and face-swap research:
  both parents are relit to one shared low-frequency lighting field before mixing; the face is mixed
  band by band (shading and colour smoothly, feature edges and skin detail with sharper weights so
  nothing doubles up); texture contrast lost by averaging is restored, following Tiddeman, Burt and
  Perrett's wavelet texture method; and the merged face carries its skin tone into the hairline, ears
  and neck. Eye makeup and lipstick are detected and not passed on to children.
- **Babies from real photo content**: the hairstyle parent's real head, ears and neck are reshaped to
  infant proportions, with the hair softened to fine baby hair and clothing turned into soft cotton.
  A drawn hospital cap and blanket is available as an optional newborn style.
- **Realistic ageing model**: per-feature blending of 478 face landmarks; baby proportions (bigger
  forehead and eyes, short upturned nose, round cheeks, faint brows, enlarged irises, smooth rosy
  skin, fine baby hair); puberty (jaw, chin, nose and brow growth and moustache fuzz for boys, fuller
  lips and softer jaw for girls, optional teenage breakouts); adult ageing (sagging, jowls, thinner
  lips, drooping lids, forehead and laugh lines, crow's feet, greying hair, age spots, duller skin).
- **Life at a glance**: 14 portraits per child from birth to 90; tap any to jump there.
- **Genes**: sliders for eyes, brows, nose, mouth, face shape, skin tone and skin detail (Mom to Dad),
  plus "Shuffle genes".
- **Eye and hair colour odds** from the textbook two-gene model, with editable parent colours.
- **Possible siblings**: four random gene draws from the same parents; tap one to adopt its mix.
- **Height forecast**: mid-parental target height with a growth chart from birth to 20.
- **Style**: hairstyle source, background, baby outfit colour, newborn hat and blanket, facial hair,
  freckles, greying speed, and the parents' current age (calibrates ageing).
- **Save**: the current portrait, a "life poster" of both children across nine ages, or a 14-second
  ageing video (MP4 on iPhone, WebM elsewhere).
- Photos and settings are remembered on the phone only; "Forget saved photos" deletes them.

## Using it on a phone

The app is published as a private claude.ai Artifact (a web page). Open the link on the phone, in
the Claude app or any browser where you're signed in, tap **Add photo** under Mom and Dad, and wait a
few seconds for the faces to be read. The first load downloads about 16 MB (the face engine and models).

Best results: arm's length, phone at eye level, neutral face with mouth closed, no glasses, hair off
the face, soft front light, whole head and shoulders in the frame.

## How it works

| Stage | File | What happens |
|---|---|---|
| Detect | `app/js/detect.js` | MediaPipe Face Landmarker (478 points, blendshapes) plus hair and person segmentation, all WASM on the CPU |
| Analyse | `app/js/analyze.js` | Aligns each photo to a canonical frame by the eyes, measures skin, iris, hair, background and clothing colours, detects facial hair and lipstick, fills photo edges, runs quality checks |
| Shape | `app/js/shape.js` | Blends the parents' landmarks per feature, then applies sex differences (ramping through puberty), craniofacial growth and adult ageing |
| Render | `app/js/render.js`, `app/js/shaders.js` | WebGL2: warps both parents onto the child's mesh, builds per-parent band pyramids, relights both to a shared lighting field, mixes low/mid/fine bands with texture-contrast restoration, softens baby hair and clothing, recolours and greys hair, then band-selective skin ageing, brows, irises, lips, facial hair, lines, spots and film grain |
| Odds | `app/js/genetics.js` | Eye and hair colour odds, mid-parental height and CDC median growth curves, life-stage notes |
| UI | `app/index.html`, `app/js/main.js` | Phone-first page, capture flow, ruler, gallery, genes, siblings, chart, saving |

The forecast is for fun. Real children mix their parents in ways no photo can predict.

References for the blending approach:
[Pérez, Gangnet and Blake, *Poisson Image Editing* (2003)](https://www.cs.princeton.edu/courses/archive/fall14/cos526/papers/perez03.pdf);
[Tiddeman, Burt and Perrett, *Prototyping and Transforming Facial Textures for Perception Research* (2001)](https://research-portal.st-andrews.ac.uk/en/publications/prototyping-and-transforming-facial-textures-for-perception-resea/);
Burt and Adelson's multiresolution spline (Laplacian-pyramid blending).

## Development

```bash
npm install
npm run setup     # copies the MediaPipe runtime into app/vendor and downloads the models
npm run serve     # http://localhost:8173, with the same strict CSP an Artifact page gets
```

Checks (headless Chromium via Playwright; put two of your own test photos in `app/_test/`, which is git-ignored):

```bash
node tools/smoke-test.mjs app/_test/mom.jpg app/_test/dad.jpg /tmp/out        # phone-size flow + screenshots
node tools/action-test.mjs app/_test/mom.jpg app/_test/dad.jpg /tmp/out       # play, save, poster, video, reload
node tools/probe-grid.mjs mom.jpg dad.jpg /tmp/grid.png "0,1,3,6,10,14,18,30,50,70,85"   # age grid render
```

`app/vendor/` is generated and git-ignored. When publishing as an Artifact, the page is
`app/index.html` and every file under `app/js/` and `app/vendor/` ships alongside it. Artifact
hosting only serves web file types, so the three `.bin` models are published as `*.bin.wasm`
(same bytes); `detect.js` tries `.bin` first and falls back to that name.
