# 03 — Reference Video Analysis (fan fleet-battle animation)

> **What this file is for.** `docs/research/01-yamato-ships.md` tells the modeller what
> the ships *look like*. This file tells the **renderer, weapons and effects authors
> (Lead, engine-dev)** what a Yamato fleet battle *feels and looks like on screen* —
> and then converts that into a concrete list of things to imitate in our Three.js +
> UnrealBloom demo.
>
> **Licensing — read this first.** Every video analysed here is a **third-party work**
> (fan animation, MMD, and in one case official anime footage). **We copy nothing** —
> no frames, no textures, no audio, no model data. This document contains only
> *descriptions* and *measurements of colour and timing*, which is exactly the
> "research informs shapes/palettes/numbers only" carve-out in SPEC §8. The PNGs under
> `docs/research/img/` are **analysis evidence for our own team**, not shipped assets.
>
> **Method.** Videos were played in the shared browser, paused at chosen timestamps,
> and the video rectangle was cropped out of a 2× DPR screenshot. Colours below were
> then **measured from the pixels with Pillow** (HSV conversion, hue/sat/val filters),
> not eyeballed. Where a number is an estimate rather than a measurement, it says so.

---

## 1. Videos analysed

| # | BV id | Title | Duration | Uploader | Kind | Views | Evidence |
|---|---|---|---|---|---|---|---|
| **A** | [`BV16mK26EEpy`](https://www.bilibili.com/video/BV16mK26EEpy) | 『宇宙战舰大和号/同人动画』地球联邦VS波拉联邦舰队战 | **96.1 s** | 吾爱寻 | **fan animation (primary)** | 2 524 | `bv16mk26eepy-t003/015/027/039/051/063/075/087.png` |
| **B** | [`BV1ZRMK6MESn`](https://www.bilibili.com/video/BV1ZRMK6MESn) | 【MMD】「伊斯坎达尔式波动炮VS波拉炮」——宇宙战舰大和号 | **39.7 s** | 大和级BBY-01 | MMD fan work | — | `bv1zrmk6mesn-t005/018/032.png` |
| **C** | [`BV1yP411g7EK`](https://www.bilibili.com/video/BV1yP411g7EK) | 宇宙战舰大和号 星际舰队波动炮开火 | **248 s** | 多元宇宙星际漫游指南 | **official anime footage, compiled** | — | `bv1yp411g7ek-t025/070/115/160/205.png` |

Contact sheets (all frames side by side) are also in `docs/research/img/`:
`bv16mk26eepy-contactsheet.png`, `bv1zrmk6mesn-contactsheet.png`,
`bv1yp411g7ek-contactsheet.png`.

**Video A metadata** (from the page's own state object):
- Uploader 吾爱寻, self-described middle-schooler and Yamato fan; **0 danmaku**,
  122 likes, 26 coins, 45 favourites, **25 comments**, 2 shares.
- Tags: **宇宙战舰大和号2199 / 2202 / 2205 / 3199, 同人, 二创, 科幻, prisma3d, 必剪创作**.
  (`prisma3d` is the tool used — a phone 3D-animation app, which explains the simple
  flat-shaded look and the absence of textures.)
- Description: `-` (empty).
- Runtime **96.08 s**, single part.

**Related videos seen in A's sidebar** (titles are evidence of what the community
considers the reference visual grammar — and two of them *independently corroborate*
ship facts in `01-yamato-ships.md`):

| Related title | Corroborates |
|---|---|
| 宇宙战舰大和号仙女座级——**双联装波动炮**专治火力不足恐惧症 | Andromeda's **twin** wave motion gun (§1.2) ✔ |
| 我说**四联装扩散式波动炮**，你耳朵聋吗 | the **dispersal** (拡散) wave motion gun mode ✔ |
| 早期加米拉斯帝国舰队vs波拉联邦舰队 | Garmillas vs Bolar fleet battles are a standard subject |
| 【MMD】「伊斯坎达尔式波动炮VS波拉炮」 | the WM gun vs the **Bolar cannon** pairing (video B) |
| 波动炮舰队—地球联邦最令人畏惧的力量 | the "wave motion gun fleet" as Earth's identity |

> **Honest limitation.** Bilibili serves a maximum of **360p (640×360)** to a
> non-logged-in viewer; 480p/720p/1080p all require sign-in. The video rectangle was
> captured at 1658×932 device pixels but the underlying source is 640×360, so fine
> surface detail (small greebles, panel lines below ~2 px) is **not resolvable**.
> Everything below about *colour, silhouette, layout, timing and effect shape* is
> solid; anything about *fine detail* would need a logged-in session.

---

## 2. What video A actually shows (the primary reference)

A continuous 96-second engagement between an **Earth Federation (UNCF)** fleet and a
**Bolar Federation** fleet, shot in a flat-shaded low-poly 3D style. There is **no
dialogue, no HUD, no on-screen text** beyond the uploader watermark — it is pure
combat footage, effectively a moving storyboard.

### 2.1 Frame-by-frame observations

| t | What is on screen | Why it matters to us |
|---|---|---|
| **3 s** | A large UNCF capital ship broadside-on, firing **three long cyan beams** horizontally; several smaller UNCF escorts around it at different depths; black space | Establishes the UNCF "look": grey hulls, red lower band, **long straight cyan beams** |
| **15 s** | A single **Bolar** ship (purple-blue hull, glowing horizontal element) firing a **green comet-shaped bolt**; a small green Garmillas-style ship top-centre | First appearance of the Bolar weapon: **not a beam — a green comet** |
| **27 s** | **Three identical Bolar ships in a diagonal line-abreast**, same heading, deep indigo hulls with **bold white bands** and **dark charcoal bow caps**; two green comets in flight | Bolar formation + hull language + projectile shape |
| **39 s** | Mixed UNCF and Bolar ships at many orientations, green bolts crossing | Shows the fleets interpenetrating rather than holding neat lines |
| **51 s** | Bolar ships firing green comets; a large dark, angular Bolar capital ship at right | Bolar capital silhouette: slab-sided, dark, with a black bow cap |
| **63 s** | A large Bolar capital ship broadside, filling the frame, with a **huge flat PURE-WHITE multi-pointed star burst** erupting across it | **The explosion language.** Also the clearest view of Bolar hull detail: recessed rectangular weapon bays along the dorsal surface, bridge + mast at the **stern**, thin swept dorsal fins, small yellow running lights |
| **75 s** | A large UNCF capital ship broadside with a **triple-barrel turret firing three parallel cyan beams**; small UNCF destroyers below with outrigger booms and a red engine pod | **The single most useful frame in the set** — see §3.2 |
| **87 s** | Several thick cyan beams raking diagonally/vertically across frame; small UNCF ships seen from below at steep angles | Beams are used as *composition elements*, not just projectiles |

### 2.2 Pacing

Every one of the eight sampled timestamps contains ships and/or weapon fire. There is
**no downtime, no establishing shot, no empty starfield** — the 96 s is one continuous
engagement. Cuts are frequent (the framing changes substantially between every sample,
i.e. roughly every **2–5 s**), and each shot holds on a *specific* ship doing a
*specific* thing rather than pulling back to a wide tactical view. Camera moves within
a shot are slow drifts, not whips.

---

## 3. Measured visual language

All hex values below were **measured from the captured frames** with Pillow. Where the
same element appears in several frames I measured each and report the agreement, which
is how you can tell a real constant from an accident.

### 3.1 Space background — the most important, cheapest finding

| Frame | Share of pixels that are essentially `#000000` |
|---|---|
| A t=3 s | **73.0 %** |
| A t=27 s | **91.0 %** |
| A t=63 s | **57.9 %** |
| A t=75 s | **51.3 %** |

The background is **near-pure black**, with only a handful of very faint grey dots for
stars and the occasional soft grey smudge for a distant object. There is **no nebula,
no skybox gradient, no visible galactic band, no lens flare**.

**This is the single highest-leverage thing to copy.** Black space does three things at
once: (1) it makes hull silhouettes unmistakable, (2) it gives UnrealBloom a clean
dark canvas so a bloom at threshold ≈ 0.6–0.8 reads as genuinely *bright* rather than
washed out, and (3) it costs nothing. A pretty nebula backdrop would actively *hurt*
this demo.

### 3.2 Beams (UNCF shock cannons)

**Measured colour — and it is a rock-solid constant:**

| Frame | Dominant beam colour | HSV |
|---|---|---|
| A t=3 s | `#6ceafc` | h 188°, s 0.57, v 0.99 |
| A t=75 s | `#6ce9fc` | h 188°, s 0.57, v 0.99 |
| A t=87 s | `#6ce9fc` | h 188°, s 0.57, v 0.99 |

Three separate frames, thousands of pixels each, and the value is **identical to
within 1/255**. The beams are a **flat, unshaded, full-brightness cyan**.

**Shape and behaviour, from frame A t=75 s:**
- **Three beams, perfectly parallel, identical width and colour** — one per barrel of
  a triple turret. They do **not** converge, spread, or taper.
- **Constant width along their whole visible length** — no widening toward the muzzle,
  no narrowing at the tip. They are effectively **cylinders/quads**, not cones.
- Beam width ≈ **1/8 of the firing ship's height** — chunky, not hairline.
- Length: they **span the entire frame width**, i.e. they are drawn as long as the
  renderer will allow, so the player reads them as reaching far beyond the frame.
- **No gradient, no inner core/halo distinction** beyond bloom. There is a *slightly*
  paler tint in places (`#95dde9`, h 189, s 0.36, v 0.91) but the beam body is one
  flat colour.

### 3.3 Explosions

**Measured:** the star burst in A t=63 s is **pure `#ffffff`** — 16 732 pixels of
exactly `#ffffff` plus another ~23 000 pixels within 1/255 of it. **There is no
colour in the explosion at all.**

**Shape:** a **flat, 2-D, multi-pointed star** with roughly 5–8 long sharp spikes
radiating from a solid centre, drawn *over* the ship like a decal. No fireball, no
smoke, no debris, no expanding ring, no orange core, no shockwave.

**Timing (estimated from the edit, not measured frame-accurately):** the burst appears
at **full size almost instantly** and then fades over roughly **0.3–0.5 s**. It does not
grow from a point.

This is a stylised "flash" — and it is **the easiest high-impact effect in the whole
reference** to reproduce: a single additive quad with a star-shaped alpha texture,
pure white, no colour ramp.

### 3.4 Bolar ships and weapons

**Hull colour (measured):**

| Element | Hex range | HSV |
|---|---|---|
| Bolar escort hull (A t=27 s) | `#1a1650` – `#211f61` | h 242–244°, s 0.68–0.72, v 0.31–0.38 |
| Bolar capital hull (A t=63 s) | `#2c335b` – `#30365b` | h 231–232°, s 0.47–0.52, v 0.36 |
| Bolar white band | `#b6ccb8` | h 125°, s 0.11, v 0.80 |
| Bolar dark bow cap | near-black charcoal | — |

So on screen Bolar hulls are a **deep indigo-violet** — *darker and more violet than
the "purple-blue" the written sources describe*. Both are consistent; when you pick a
value, aim for **hue 235–245°, saturation ~0.6, value ~0.35** to match what the video
actually looks like, which is a dark navy-violet that reads almost black in shadow.

**Distinctive hull features visible in A t=63 s** (all corroborate `01-yamato-ships.md`
§3): a **dark charcoal rounded cap at the bow**, **bold white bands** wrapping the hull,
a **small bridge with a mast cluster at the STERN**, **recessed rectangular weapon bays**
running along the dorsal surface (the retractable armament!), thin swept dorsal fins,
and a few **small yellow running lights**.

**Bolar projectile — a green comet, NOT a beam:**

| Element | Measured |
|---|---|
| Body | `#65a664` (h 119°, s 0.40, v 0.65); range `#3c6a3c` → `#70ac71` |
| Bright head/core | `#9dd5a1` / `#97cf9b` (h 124°, s 0.26–0.27, v 0.81–0.84) |
| Hue across 4 frames | consistently **118–128°** |
| Saturation | only **0.26–0.46** |

Two things matter here:
1. **It is a comet/teardrop bolt, not a straight beam.** Roughly **3–4 : 1 length :
   width**, brightest and widest at the *leading* end, tapering to a point behind.
2. **The green is desaturated.** Hue ≈ 120° but saturation only ~0.3–0.45 and the core
   goes pale (`#9dd5a1`). If you use a neon `#00ff00` it will look wrong and cheap.
   Aim for **≈ `#6ab86a` body with a `#b9e8bb` head**.

### 3.5 Wave motion gun — charge and fire

Video A does not clearly feature a WM-gun firing, so this is drawn from **B and C**.

**Charge (video C t=70 s — official anime):** a **row of bright white-blue spherical
blooms** at the muzzles, glowing like over-exposed lamps. Measured palette:
`#fdfeff`, `#d6e2ea`, `#bac5cc`, `#eff8fc` — i.e. **white with a faint blue tint, very
low saturation**, with a medium-blue accent at `#5aa6d5` (h 203°, s 0.58, v 0.84).
The bloom is **soft-edged and round**, not a hard disc.

**Fire (video C t=205 s):** the interior of the beam reads as a **soft, hazy,
blue-white cloud field** with **no hard edges** — you are looking *inside* a
wave-motion-gun beam. The other frames of C show the muzzle flash as a **line of
bright white-blue orbs** and, separately, **huge orange/amber explosion fields**
(t=115 s) where a wave motion gun has hit a fleet.

**The Bolar cannon is the visual opposite (video B t=18 s and t=32 s).** In the MMD it
is named 「アプロ・ランディル砲」 with the on-screen note *"阿普罗·兰迪尔炮 = 波拉炮"*
(="Apollo Landil cannon" is the "Bolar cannon"):

| Element | Measured |
|---|---|
| Emitter on the hull (t=18 s) | glowing **orange-yellow slot**; hull is **brick/vermilion red** `#a33d1d` (h 14°, s 0.82, v 0.64) |
| Beam core (t=32 s) | `#fefed7` / `#f1e19f` — **pale yellow, white-hot** (h 48–60°, low sat, v 0.95–1.00) |
| Beam surround | `#a17957`, `#42220b`, `#603c16` — **orange-brown turbulence** (h 25–31°, s 0.77–0.83) |
| Overall shape | a **roaring, turbulent, flame-like column** with ragged edges — *not* a clean line |

**So: UNCF wave motion gun = clean blue-white; Bolar cannon = ragged fiery orange-gold.**
That contrast is a free, unmistakable "whose superweapon is this" signal, and it maps
directly onto SPEC §6.4's `wmgun` vs `bolar_beam` weapon entries.

### 3.6 UNCF hull appearance on screen

| Element | Measured |
|---|---|
| Lit hull | `#8a99a4`, `#adb9c5`, `#dee4e9` (h 205–210°, s 0.05–0.16) |
| Shadowed hull | `#434b57`, `#4c5660`, `#5c6570` (h 210–216°, s 0.18–0.23) |
| **Red lower band** | **`#a51f17`** (h 3°, s 0.86, v 0.65) ✔ confirms `01-yamato-ships.md` `hull_red` |
| Thin hull trim | bright cyan, same family as the beams (`#6bd8de`, h 183°, s 0.52, v 0.87) |

Note the **very wide value range** between lit (`#dee4e9`, v 0.91) and shadowed
(`#434b57`, v 0.27) hull faces. That is a strong single-key-light look, and it is what
makes flat-shaded low-poly ships read as solid volumes. **Do not light our ships
flatly** — one strong directional key with a low ambient is doing a lot of work here.

---

## 4. What to imitate in our demo

> Mapped to our actual stack: **Three.js r160**, `MeshBasicMaterial` /
> `MeshStandardMaterial`, **UnrealBloomPass**, `EffectComposer`, and the interfaces in
> SPEC §6. Numbers are suggestions for `src/core/config.js`, which owns all balance.

**Effects & colour**

1. **Keep space black.** Background `#000000` (optionally a very dark `#04060a`).
   Stars: a few hundred points, dim (`#8a8f96` at low opacity), no nebula, no skybox
   gradient, no galactic band. 51–91 % of the reference frames are literally pure
   black — copy that and everything else gets easier.
2. **Shock cannon beams = flat `#6ce9fc`, unlit.** Use `MeshBasicMaterial` (or a
   ShaderMaterial that ignores lighting) so the beam is *always* full brightness and
   **never shades**. Bloom supplies all the glow. This one measured constant is the
   most reliable single number in this document.
3. **Beams are constant-width cylinders, not cones.** No taper, no widening at the
   muzzle. Width ≈ 1/8 of the firing ship's height (for the 333 m Yamato that is
   ≈ 4–5 m at game scale — but note SPEC §5 keeps real metres, so use ≈ 4 m).
4. **Fire shock cannons as parallel volleys of 3** — one beam per barrel, all
   identical, all parallel, spawned in the same frame. SPEC §6.4 already has a `salvo`
   field; set `shock_cannon.salvo = 3` and give the three beams zero spread.
5. **Beams persist.** `life` ≈ 0.15–0.30 s of visible beam after firing, drawn at full
   length (a few km) rather than as a short segment travelling to the target. The
   reference draws them across the entire frame.
6. **Explosions = pure white flat star sprites.** Additive quad, pure `#ffffff`,
   star-shaped alpha (5–8 sharp spikes), **instant to full size, fade over ≈ 0.4 s**,
   no orange, no smoke, no debris, no expanding fireball. Big ships get a bigger star,
   not a different effect.
7. **Faction glow separation, taken from measurement:**
   - UNCF beam / trim / engine: **cyan `#6ce9fc`**
   - Garmillas drive: **amber `#ffd27a`** (from `01-yamato-ships.md`)
   - Bolar bolt: **green `#6ab86a`** body with **`#b9e8bb`** head; drive **red**
   In a 30-ship brawl this is what lets the player parse the battle at a glance.
8. **Bolar weapons are comets, not beams.** `bolar_beam` should be an elongated
   additive billboard (≈ 3–4 : 1), bright pale-green head, tapering green tail —
   **not** a cylinder. This is a 20-line difference in `src/weapons/weapons.js` and it
   instantly makes wave 3 look like a different enemy.
9. **Wave motion gun charge = a growing white-blue sphere at the muzzle.**
   `#fdfeff` core, `#5aa6d5` rim, soft-edged, radius growing over `chargeTime`
   (SPEC §6.4). Add a slow pulse. Fire as a **wide white-blue column** with a hazy,
   soft-edged interior — the reference's beam interior is a cloud field, not a hard
   cylinder.
10. **Give the Bolar boss a fiery orange cannon.** Core `#fefed7`, surround
    `#a17957`/`#42220b`, ragged turbulent edges — visually the *opposite* of the
    clean cyan/white UNCF guns. Perfect telegraph for a wave-3 heavy attack, and it
    matches the `bolar_carrier` palette in `01-yamato-ships.md` §3.1.

**Materials & lighting**

11. **Light with one strong key + low ambient.** The reference shows lit hull faces at
    v ≈ 0.91 and shadowed faces at v ≈ 0.27 — a ~3.4 : 1 value ratio. A single
    `DirectionalLight` at moderate intensity with `AmbientLight` around 0.15–0.25
    reproduces this. Flat ambient-only lighting will make our ships look like
    cardboard.
12. **Add thin cyan trim stripes to UNCF hulls** (`#6ce9fc` family, unlit). The
    reference hulls are covered in hairline glowing cyan lines. This is very cheap
    (a handful of thin quads) and is the fastest way to make a grey hull read as
    "Earth Federation" rather than "generic spaceship".
13. **Keep hull materials matte and desaturated.** Measured hull saturations are
    0.05–0.23. Resist the urge to add strong speculars or saturated faction colours to
    the *hull*; the saturation budget belongs to the **effects**.
14. **Unlit for effects, lit for hulls.** Every measured effect colour is at v ≈ 0.99
    (beams, explosions) while hulls span v 0.27–0.91. That split is deliberate and is
    what makes bloom look like emission rather than overexposure.

**Camera & pacing**

15. **Bias the chase camera toward broadside/three-quarter framing.** The reference
    almost always shows ships in **profile**, filling **40–60 % of the frame width**,
    with several ships overlapping at different depths. For SPEC §1's third-person
    chase camera, that means: don't let the camera get too far back, and let the
    player's ship occupy a good fraction of frame. Also consider a brief **side-on
    cinematic sweep** when the WM gun fires.
16. **Overlap ships at multiple depths rather than spacing them evenly.** The fleet
    feel in the reference comes from layered silhouettes, not from a tidy grid. If
    `src/ai/fleetai.js` formation slots are perfectly regular, add a small random
    depth/lateral jitter per slot.
17. **Pace it as continuous engagement.** The 96 s reference has **no downtime** and
    cuts roughly every 2–5 s. For our 3-wave, ~5-minute scenario, keep inter-wave gaps
    short and always leave something visible happening — a wave banner plus a few
    seconds of repositioning, not a long lull.
18. **Use beams as composition, not just projectiles.** The reference fires long beams
    that rake across the frame and cross each other. Letting a few beams miss and
    streak past the camera is more cinematic than only drawing beams that hit.

---

## 5. What NOT to imitate

- **Do not copy the reference's resolution or texture-less look.** It is 360p phone
  output; the flat look is a constraint, not a style goal. Our flat PBR materials with
  proper lighting will read better.
- **Do not copy video B's red hull as a general Bolar colour.** In `01-yamato-ships.md`
  §3 the **red is reserved for flagships**; the standard Bolar hull is indigo-violet.
  Video B happens to show a red one (likely a flagship).
- **Do not copy video C's content.** It is **official anime footage**; it is used here
  only to read the wave-motion-gun charge/fire grammar. No frames, palettes-as-assets,
  or audio may be taken from it.
- **Do not add lens flares, chromatic aberration, film grain, or heavy vignette.**
  None of the reference material has them; they would muddy the flat, high-contrast
  look and eat frame budget.

---

## 6. Evidence index

All under `docs/research/img/`:

| File | Contents |
|---|---|
| `bv16mk26eepy-contactsheet.png` | Video A — all 8 sampled frames, 4×2 grid |
| `bv16mk26eepy-t003.png` | A t=3 s — UNCF fleet, three long cyan beams |
| `bv16mk26eepy-t015.png` | A t=15 s — single Bolar ship firing a green comet |
| `bv16mk26eepy-t027.png` | A t=27 s — Bolar line-abreast, white bands, green comets |
| `bv16mk26eepy-t039.png` | A t=39 s — mixed fleet, interpenetrating |
| `bv16mk26eepy-t051.png` | A t=51 s — Bolar firing; dark angular capital ship |
| `bv16mk26eepy-t063.png` | A t=63 s — **Bolar capital ship + pure-white star explosion** |
| `bv16mk26eepy-t075.png` | A t=75 s — **triple turret, three parallel cyan beams** |
| `bv16mk26eepy-t087.png` | A t=87 s — beams raking across frame |
| `bv1zrmk6mesn-contactsheet.png` | Video B — 3 frames |
| `bv1zrmk6mesn-t005.png` | B t=5 s — black frame |
| `bv1zrmk6mesn-t018.png` | B t=18 s — **Bolar cannon emitter on a red hull** |
| `bv1zrmk6mesn-t032.png` | B t=32 s — **Bolar cannon firing: orange plasma column** |
| `bv1yp411g7ek-contactsheet.png` | Video C — 5 frames |
| `bv1yp411g7ek-t025.png` | C t=25 s — anime bridge close-up (context) |
| `bv1yp411g7ek-t070.png` | C t=70 s — **WM-gun charge blooms (white-blue)** |
| `bv1yp411g7ek-t115.png` | C t=115 s — large orange explosion field |
| `bv1yp411g7ek-t160.png` | C t=160 s — a large spherical fortress |
| `bv1yp411g7ek-t205.png` | C t=205 s — hazy blue-white beam interior |

---

## 7. Summary — the five numbers that matter most

If everything else in this file were lost, these five measured values carry most of
the visual identity:

| # | Value | Meaning |
|---|---|---|
| 1 | **`#6ce9fc`** | UNCF shock-cannon beam — a constant, identical across 3 separate frames |
| 2 | **`#ffffff`** | Explosions — pure white, flat, star-shaped, zero colour |
| 3 | **`#000000`** | Space — 51–91 % of every frame; no nebula |
| 4 | **`#6ab86a` body / `#b9e8bb` head** | Bolar bolt — a *desaturated* green comet, not a neon beam |
| 5 | **h 235–245°, s ≈ 0.6, v ≈ 0.35** | Bolar hull — dark indigo-violet, darker than "purple-blue" suggests |
