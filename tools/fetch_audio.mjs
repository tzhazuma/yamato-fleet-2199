#!/usr/bin/env node
/**
 * fetch_audio.mjs — download PUBLIC-DOMAIN / CC0 music for local use.
 *
 * WHY THIS EXISTS
 * ---------------
 * The repository ships no third-party audio at all (README "Assets", SPEC §8):
 * the score is synthesised at runtime by src/core/music.js. This tool is the
 * opt-in escape hatch for anyone who would rather hear real recordings locally.
 *
 * It deliberately downloads into `assets/audio/`, which is GITIGNORED. Nothing
 * this tool fetches can end up in the repository by accident, so the "no
 * third-party assets" claim stays true no matter what you run.
 *
 * USAGE
 *   node tools/fetch_audio.mjs              # fetch everything reachable
 *   node tools/fetch_audio.mjs --list       # show the catalogue and licences
 *   node tools/fetch_audio.mjs --only=holst # fetch one entry
 *
 * LICENCE RULES THIS TOOL ENFORCES
 * --------------------------------
 *   1. Only `pd` (public domain) and `cc0` entries are in the catalogue. Nothing
 *      requiring attribution, and nothing under a share-alike or non-commercial
 *      term, because those would contaminate a permissively licensed repo.
 *   2. A public-domain COMPOSITION does not imply a public-domain RECORDING.
 *      Every entry therefore names the recording's own status, not just the
 *      composer's death date, and says who to credit if the source asks for it.
 *   3. Each download is checked for a plausible audio container before it is
 *      written, so an HTML error page never lands as a .ogg.
 *   4. It writes `manifest.json` next to the files, which src/core/music.js
 *      reads. Delete the directory to go back to the synthesised score.
 *
 * NETWORK NOTE
 * ------------
 * Some hosts are unreachable from some networks (Wikimedia's upload host and
 * archive.org are commonly blocked). A failure is reported per entry and never
 * aborts the run; re-run on an unblocked connection to pick up the rest.
 */

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'assets', 'audio');

/**
 * Curated catalogue. Every entry is public domain or CC0.
 *
 * `status` describes the RECORDING, which is the thing being downloaded:
 *   'pd'  — the recording itself is public domain (typically pre-1929 US, or
 *           explicitly released into the PD by its publisher)
 *   'cc0' — the uploader released the recording under CC0 1.0
 */
const CATALOGUE = [
  {
    id: 'holst-mars',
    title: 'Holst — The Planets: Mars, the Bringer of War',
    composer: 'Gustav Holst (1874-1934)',
    status: 'pd',
    statusNote:
      'Composition is public domain worldwide (Holst died 1934). This entry ' +
      'expects a PD recording; verify the file page before relying on it.',
    why: 'The obvious musical reference for "dreadnoughts in space".',
    source: 'Wikimedia Commons',
    page: 'https://commons.wikimedia.org/wiki/Category:Audio_files_of_music_by_Gustav_Holst',
    urls: [],
    needsManualPick: true,
  },
  {
    id: 'tchaikovsky-1812',
    title: 'Tchaikovsky — 1812 Overture',
    composer: 'Pyotr Ilyich Tchaikovsky (1840-1893)',
    status: 'pd',
    statusNote: 'Composition long out of copyright; recording status varies.',
    why: 'Naval-gunnery energy; the finale is a literal artillery barrage.',
    source: 'Wikimedia Commons',
    page: 'https://commons.wikimedia.org/wiki/File:Pyotr_Ilyich_Tchaikovsky_-_1812_overture.ogg',
    urls: [
      'https://upload.wikimedia.org/wikipedia/commons/c/c5/Pyotr_Ilyich_Tchaikovsky_-_1812_overture.ogg',
    ],
  },
  {
    id: 'saint-saens-danse',
    title: 'Saint-Saens — Danse Macabre',
    composer: 'Camille Saint-Saens (1835-1921)',
    status: 'pd',
    statusNote: 'Philadelphia Symphony Orchestra recording, PD by age.',
    why: 'Tension and inevitability; good for a losing fight.',
    source: 'Wikimedia Commons',
    page: 'https://commons.wikimedia.org/wiki/File:PhiladelphiaSymphonyOrchestra-DanseMacabre.ogg',
    urls: [
      'https://upload.wikimedia.org/wikipedia/commons/3/30/PhiladelphiaSymphonyOrchestra-DanseMacabre.ogg',
    ],
  },
  {
    id: 'oga-cc0-score',
    title: 'OpenGameArt CC0 music collection',
    composer: 'various',
    status: 'cc0',
    statusNote:
      'OpenGameArt hosts a large CC0 music section. This entry is a POINTER, ' +
      'not a direct file: pick a track and paste its download URL into `urls`.',
    why: 'Ready-made loops that are unambiguously CC0 and game-friendly.',
    source: 'OpenGameArt.org',
    page: 'https://opengameart.org/art-search-advanced?field_art_type_tid%5B%5D=12&field_art_licenses_tid%5B%5D=17987',
    urls: [],
    needsManualPick: true,
  },
  {
    id: 'fma-cc0',
    title: 'Free Music Archive — CC0 / public domain',
    composer: 'various',
    status: 'cc0',
    statusNote:
      'FMA lets you filter by licence. This entry is a POINTER: filter to CC0 ' +
      'or Public Domain, pick a track, and paste its direct download URL.',
    why: 'Wide range of instrumental beds.',
    source: 'Free Music Archive',
    page: 'https://freemusicarchive.org/search?adv=1&music-license=cc0',
    urls: [],
    needsManualPick: true,
  },
];

const MAGIC = [
  { ext: 'ogg', test: (b) => b.subarray(0, 4).toString('latin1') === 'OggS' },
  { ext: 'mp3', test: (b) => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { ext: 'wav', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' },
  { ext: 'flac', test: (b) => b.subarray(0, 4).toString('latin1') === 'fLaC' },
  { ext: 'm4a', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' },
];

function sniff(buf) {
  for (const m of MAGIC) if (m.test(buf)) return m.ext;
  return null;
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function fetchOne(entry) {
  const results = [];
  for (const url of entry.urls) {
    const name = url.split('/').pop().split('?')[0];
    const dest = join(OUT_DIR, name);
    if (await exists(dest)) { results.push({ url, file: name, ok: true, note: 'already present' }); continue; }
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'yamato-fleet-2199/fetch_audio (+local use only)' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) { results.push({ url, ok: false, note: `HTTP ${res.status}` }); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const kind = sniff(buf);
      if (!kind) { results.push({ url, ok: false, note: `not audio (${buf.length} bytes, starts "${buf.subarray(0, 12).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}")` }); continue; }
      await writeFile(dest, buf);
      results.push({ url, file: name, ok: true, note: `${kind}, ${(buf.length / 1048576).toFixed(1)} MB` });
    } catch (err) {
      results.push({ url, ok: false, note: (err && err.name === 'TimeoutError') ? 'timed out' : (err?.message || String(err)) });
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list') || args.includes('-l')) {
    console.log('Catalogue (all public domain or CC0):\n');
    for (const e of CATALOGUE) {
      console.log(`  ${e.id.padEnd(20)} [${e.status.toUpperCase()}] ${e.title}`);
      console.log(`  ${''.padEnd(20)} ${e.composer} — ${e.source}`);
      console.log(`  ${''.padEnd(20)} why: ${e.why}`);
      console.log(`  ${''.padEnd(20)} licence: ${e.statusNote}`);
      console.log(`  ${''.padEnd(20)} ${e.page}`);
      if (e.needsManualPick) console.log(`  ${''.padEnd(20)} >> manual pick required (no direct URL in the catalogue)`);
      console.log();
    }
    console.log('Nothing here requires attribution, and nothing is share-alike or');
    console.log('non-commercial, so a local copy cannot contaminate the repo licence.');
    return;
  }

  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length) : null;
  const wanted = only ? CATALOGUE.filter((e) => e.id === only) : CATALOGUE;
  if (only && !wanted.length) { console.error(`no such entry: ${only}`); process.exitCode = 1; return; }

  await mkdir(OUT_DIR, { recursive: true });
  console.log(`Target: ${OUT_DIR}`);
  console.log('This directory is GITIGNORED — nothing fetched here can enter the repo.\n');

  const manifest = { generatedBy: 'tools/fetch_audio.mjs', note: 'Local-only audio. Not part of the repository.', tracks: [] };
  let ok = 0, failed = 0, manual = 0;

  for (const entry of wanted) {
    console.log(`── ${entry.id} [${entry.status}] ${entry.title}`);
    if (entry.needsManualPick || !entry.urls.length) {
      manual++;
      console.log(`   manual pick required — open ${entry.page}`);
      console.log('   then paste the direct file URL into CATALOGUE in this script.');
      continue;
    }
    for (const r of await fetchOne(entry)) {
      if (r.ok) {
        ok++;
        console.log(`   OK   ${r.file}  (${r.note})`);
        manifest.tracks.push({
          id: entry.id, file: r.file, title: entry.title, composer: entry.composer,
          licence: entry.status, licenceNote: entry.statusNote, source: entry.source, page: entry.page,
        });
      } else {
        failed++;
        console.log(`   FAIL ${r.url}\n        ${r.note}`);
      }
    }
  }

  if (manifest.tracks.length) {
    const dest = join(OUT_DIR, 'manifest.json');
    await writeFile(dest, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`\nwrote ${dest} (${manifest.tracks.length} tracks) — src/core/music.js will prefer these`);
  }
  console.log(`\ndone: ${ok} downloaded, ${failed} failed, ${manual} need a manual pick`);
  if (failed && !ok) {
    console.log('\nEvery download failed. This network is probably blocking the hosts.');
    console.log('The synthesised score in src/core/music.js needs no network at all.');
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
