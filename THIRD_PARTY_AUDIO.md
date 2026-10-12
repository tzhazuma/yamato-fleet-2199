# Third-party audio — attribution and licence record

**This repository ships no audio files.** The score you hear by default is
synthesised at runtime by `src/core/music.js` from oscillators, and is original
to this project. This file exists so that if you run `tools/fetch_audio.mjs` and
download real recordings locally, the attribution they require is already
recorded here.

`assets/audio/` is **gitignored**. Nothing listed below is in the repository.

Run `node tools/fetch_audio.mjs --list` for the same catalogue with live URLs.

---

## Downloaded by `tools/fetch_audio.mjs` — cleared for use

### Public domain — no obligations

| File | Work | Credit |
|---|---|---|
| `Dance_to_the_Spirits_of_Fire_-_Stellar_Brass_-_United_States_Air_Force_Academy_Band.mp3` | *Dance to the Spirits of Fire* | Stellar Brass, United States Air Force Academy Band |
| `First_Suite_in_E-flat_for_Military_Band_-_I._Chaconne_-_Concert_Band_-_United_States_Air_Force_Heritage_of_America_Band.mp3` | Holst, *First Suite in E-flat*, I. Chaconne | United States Air Force Heritage of America Band |
| `First_Suite_in_E-flat_for_Military_Band_-_III._March_-_Concert_Band_-_United_States_Air_Force_Heritage_of_America_Band.mp3` | Holst, *First Suite in E-flat*, III. March | United States Air Force Heritage of America Band |

These are works of the United States federal government, which are not subject
to copyright in the United States. Gustav Holst died in 1934, so the
compositions are also public domain worldwide. Credit is given because it is
correct to credit performers, not because it is required.

Source: Wikimedia Commons. Licence verified per file through the Commons API
(`LicenseShortName` = "Public domain"), not assumed from the composer's death
date.

### CC BY — attribution required

| File | Work | Credit |
|---|---|---|
| `Gustav_Holst_-_the_planets%2C_op._32_-_i._mars%2C_the_bringer_of_war.ogg` | Holst, *The Planets*, Op. 32 — I. Mars, the Bringer of War | See the file page below |

**This one carries an obligation.** The composition is public domain (Holst died
1934) but this *recording* is licensed CC BY, and a recording is a separate
copyright from the work it records. If you use this file anywhere public you
must credit the performer and link the licence.

File page and full attribution:
<https://commons.wikimedia.org/wiki/File:Gustav_Holst_-_the_planets,_op._32_-_i._mars,_the_bringer_of_war.ogg>

`tools/fetch_audio.mjs` writes this credit into the `manifest.json` it
generates, so it travels with the file. Do not strip it.

---

## `assets/audio/uncleared/` — NOT licensed, do not distribute

This directory holds material downloaded for **private local evaluation only**,
at the project owner's request and on the stated intention of seeking a licence.
It is gitignored, and it must stay that way.

| File | Work | Rights holder |
|---|---|---|
| `ささきいさお♪「宇宙戦艦ヤマト」 Isao Sasaki 「Anime song」.m4a` | *宇宙戦艦ヤマト* (the original series opening theme) | Music by Hiroshi Miyagawa; performed by Isao Sasaki |
| `Space Battleship Yamato 2199 宇宙戦艦ヤマト 2199 OP 2.m4a` | *宇宙戦艦ヤマト2199* opening theme | © Yamato 2199 Production Committee |
| `宇宙戦艦ヤマト2202【Yamato 2026】アンドロメダ⧸新たなる旅立ち.m4a` | *宇宙戦艦ヤマト2202* music | © Yamato 2202 Production Committee |
| `真っ赤なスカーフ 宇宙戦艦ヤマトエンディングテーマ 昭和53(1978)年版 フルコーラス　(アナログレコード音源).m4a` | *真赤なスカーフ* (ending theme) | Music by Hiroshi Miyagawa |

**These are copyrighted works used without a licence.** They are here for
private evaluation while a licence application is prepared.

Rules that apply to this directory:

1. **Never commit it.** It is gitignored; do not override that.
2. **Never redistribute it** — not in a build, a release, a fork, a screenshot
   with audio, or a public deployment of the demo.
3. **The synthesised score is the shippable default.** `src/core/music.js` falls
   back to it whenever the uncleared files are absent, which is the case in any
   fresh clone.
4. **If the licence application fails, delete the directory.** Nothing in the
   project depends on it.

The engine does not distinguish "cleared" from "uncleared" audio — it just plays
whatever `manifest.json` points at. The separation is enforced by the directory
layout and by this document, so if you add files here, add them to the table
above.

---

## Why the obvious choice is absent

The natural soundtrack for a Yamato tribute is the Yamato score. It is
copyrighted, it is not public domain in any territory, and including it would
break the promise in `README.md` and `docs/SPEC.md` §8 that this repository
contains no third-party art or audio. The synthesised score exists so that the
demo has music with no licence question at all.

If you obtain a licence for the real score, this file is where to record it —
add the licence reference, the licensor, the scope (which works, which
territories, which media), and the expiry. Until then the rule above stands.
