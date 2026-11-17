// token-radar-01 entry point (Node 22, standard library only).
//
// Lifecycle: read the sealed snapshot, score every pre-token protocol through the
// model in lib/model.ts, rank them into board.json, emit the dashboard's data feed,
// copy dashboard/ and screenshots/ beside it, and finally write the dossier that the
// judge reads. The work is split into small, named steps so each failure is reported
// against the step that produced it.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, SnapshotError } from './lib/model.ts';
import type { BoardRow, RadarData, Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** The repository root: where dashboard/, screenshots/ and lib/ live. */
const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MIN_SCREENSHOTS = 3;

/** Read a `--name <value>` (or `--name=<value>`) argument, else the fallback. */
function readArg(name: string, fallback: string): string {
  const dash = `--${name}`;
  const at = process.argv.indexOf(dash);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const inline = process.argv.find((a) => a.startsWith(`${dash}=`));
  return inline === undefined ? fallback : inline.slice(dash.length + 1);
}

/** Map the --input argument to the snapshot file path: a file as given, else snapshot.json inside a directory. */
function snapshotFilePath(inputArg: string): string {
  return inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
}

/** Load and parse the snapshot. On a missing input, report and exit(2). */
function loadSnapshot(inputArg: string): Snapshot {
  const file = snapshotFilePath(inputArg);
  if (!existsSync(file)) {
    process.stderr.write(`token radar: no snapshot at ${file}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
    process.exit(2);
  }
  try {
    return parseSnapshot(readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof SnapshotError ? error.message : String(error);
    process.stderr.write(`token radar: could not parse the snapshot at ${file}: ${message}\n`);
    process.exit(1);
  }
}

/** Score the snapshot and guard the board against the gate. On a refusal, report and exit(1). */
function scoreBoard(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
    process.exit(1);
  }
  return { board, radar };
}

/** Write board.json (the ranked board) and data.js (the dashboard's feed). */
function writeBoardAssets(outDir: string, board: BoardRow[], radar: RadarData): void {
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(outDir, 'data.js'), dataScript(radar));
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyDirectory(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/** Stage the dashboard and screenshots into the output. Validate the screenshot count and filenames. */
function stageAssets(outDir: string): string[] {
  copyDirectory(join(REPO_ROOT, 'dashboard'), join(outDir, 'dashboard'));
  const shots = copyDirectory(join(REPO_ROOT, 'screenshots'), join(outDir, 'screenshots'));
  if (shots.length < MIN_SCREENSHOTS) {
    process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
    process.exit(1);
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
  }
  return shots;
}

/** Write the dossier last: the scorer rebuilds it from this /output and compares bytes. */
function writeDossier(outDir: string): void {
  writeFileSync(
    join(outDir, 'dossier.json'),
    buildDossier(outDir, {
      text_max_bytes: TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_CAPS,
      dashboard: { max_files: 400, max_bytes: 4_194_304 },
    }),
  );
}

/** Run the full pipeline and report what was written. */
function main(): void {
  const inputArg = readArg('input', '/input');
  const snapshot = loadSnapshot(inputArg);
  const outDir = readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const { board, radar } = scoreBoard(snapshot);

  mkdirSync(outDir, { recursive: true });
  writeBoardAssets(outDir, board, radar);
  const shots = stageAssets(outDir);
  writeDossier(outDir);

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (3 files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
  );
}

main();
