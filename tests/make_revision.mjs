#!/usr/bin/env node
/**
 * tests/make_revision.mjs — regenerate evidence/revision.json.
 *
 * Records the git HEAD and a SHA-256 for every tracked product file, so a later
 * reader can tell whether a verification still applies to the tree in front of
 * them. Run it after any commit:
 *
 *   node tests/make_revision.mjs
 *
 * Not a test file (it does not match `node --test`'s discovery patterns), so it
 * never runs as part of `node --test tests/`.
 *
 * Owned by the verifier (tests/**, evidence/**, docs/VERIFY.md).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const OUT = join(root, 'evidence', 'revision.json');

/** Every path git tracks, minus anything we deliberately do not verify. */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Read with retries. Under heavy host load this checkout has thrown
 * ETIMEDOUT from readFileSync on large files; a retry is enough, and a file
 * that still will not read is REPORTED rather than silently skipped, so the
 * snapshot can never quietly under-count the tree.
 */
function readWithRetry(abs, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return readFileSync(abs); } catch (err) { last = err; }
  }
  throw last;
}

const files = {};
const unreadable = [];
const deleted = [];
for (const rel of trackedFiles()) {
  const abs = join(root, rel);
  let st;
  try { st = statSync(abs); } catch { deleted.push(rel); continue; }
  if (!st.isFile()) continue;
  try {
    const buf = readWithRetry(abs);
    files[rel.split(sep).join('/')] = {
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: buf.length,
    };
  } catch (err) {
    unreadable.push([rel, String(err.code || err.message)]);
  }
}
if (unreadable.length) {
  console.error('UNREADABLE (snapshot is INCOMPLETE — re-run):');
  for (const [rel, why] of unreadable) console.error(`  ${rel}: ${why}`);
  process.exitCode = 1;
}
if (deleted.length) {
  // Tracked but absent from the working tree — a real state worth recording,
  // not a read failure. Kept out of `files` so the snapshot only ever
  // describes files that actually exist.
  console.error(`tracked-but-deleted (${deleted.length}): ${deleted.join(', ')}`);
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();

const ordered = {};
for (const k of Object.keys(files).sort()) ordered[k] = files[k];

const doc = {
  capturedAt: new Date().toISOString(),
  gitHead: head,
  workingTreeClean: dirty.length === 0,
  note: 'Regenerated after the eight-hull armament rebuild and the firing-indicator rework. '
      + 'docs/VERIFY.md states the revision it verified; if this file disagrees with the tree '
      + 'in front of you, re-run the commands in that file rather than trusting its results.',
  fileCount: Object.keys(ordered).length,
  deletedFiles: deleted.sort(),
  files: ordered,
};

writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${relative(root, OUT)} — ${doc.fileCount} files @ ${head.slice(0, 7)}`
  + `${doc.workingTreeClean ? '' : ' (WORKING TREE DIRTY)'}`);
