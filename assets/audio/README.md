# assets/audio — local only, never committed

**This directory is gitignored.** Nothing in it is part of the repository, and
nothing in it is required to run the game.

The score you hear by default is **synthesised at runtime** by
`src/core/music.js` from oscillators — original, offline, and consistent with the
project's asset policy: this repository contains no third-party art or audio.

## Want real recordings instead?

```bash
node tools/fetch_audio.mjs --list     # show the catalogue and every licence
node tools/fetch_audio.mjs            # download what this network allows
```

It only ever fetches **public domain** or **CC0** material — nothing requiring
attribution, nothing share-alike, nothing non-commercial — so a local copy cannot
contaminate the repository's MIT licence. It writes a `manifest.json` here, and
`src/core/music.js` will prefer those files over the synthesised score.

Delete this directory (or just `manifest.json`) to go back to the synth score.

## Why the obvious choices are not in the catalogue

- **The Yamato score** (Hiroshi Miyagawa) is copyrighted. It is exactly the
  third-party asset the policy exists to keep out, and it is not a grey area.
- **"Public domain" compositions are not automatically safe.** Holst, Tchaikovsky
  and Saint-Saens are long out of copyright, but a *recording* of their work is a
  separate copyright owned by whoever made it. The catalogue therefore records
  the recording's status, not just the composer's death date.
- **Most game-audio libraries are CC-BY**, which would require an attribution
  block in the README and a licence file shipped alongside — extra obligations
  for a demo that does not need them.

## Reachability

Some networks block the file hosts (Wikimedia's `upload.wikimedia.org` and
`archive.org` are commonly blocked). The tool reports each failure individually
and never aborts. If everything fails, the synthesised score still works — it
needs no network at all.
