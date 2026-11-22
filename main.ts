// main.ts is mend, the CLI SPEC.md specifies. It does all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three matching tiers, unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;
type MovePair = [string, string];

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- files as lines (SPEC.md section 3) ----------

/** A file split at its own line break, with whether it ends with one. */
interface FileState {
  br: string;
  lines: string[];
  eol: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], eol: false };
  const idx = text.indexOf('\n');
  const br = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { br, lines: parts, eol };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.eol ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// ---------- matching lines at three tiers (SPEC.md section 5) ----------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiersFor(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions i >= from where O's lines match the file's lines i, i+1, ... at this tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const pos: number[] = [];
  const ol = o.length;
  for (let i = from; i + ol <= lines.length; i++) {
    if (eofOnly && i + ol !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < ol; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs at least once at or after `from`, with its positions. */
function findTier(lines: string[], o: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; positions: number[] } | null {
  for (const tier of tiersFor(strict)) {
    const positions = occurrences(lines, o, tier, from, eofOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  for (const tier of tiersFor(strict)) {
    const want = normLine(anchor, tier);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, tier) === want) return i;
    }
  }
  return -1;
}

// ---------- hunk and chunk bodies ----------

/** One body line: context (in both O and N), old (O only) or new (N only). */
interface BodyEl {
  k: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line followed this body line: it has no line break after it. */
  noEol: boolean;
}

/** One line of N: its text, and the index of the O line it is a context line for, or -1. */
interface NLine {
  text: string;
  ctx: number;
}

/** Body lines to O and N. A context line of N remembers which O line it pairs with. */
function splitBody(els: BodyEl[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const el of els) {
    if (el.k === 'ctx') {
      const idx = o.length;
      o.push(el.text);
      n.push({ text: el.text, ctx: idx });
    } else if (el.k === 'old') {
      o.push(el.text);
    } else {
      n.push({ text: el.text, ctx: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function lastCtxOrNewNoEol(els: BodyEl[]): boolean {
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i]!;
    if (el.k === 'ctx' || el.k === 'new') return el.noEol;
  }
  return false;
}

/** Whether a `\` line follows the body's last `+` line. */
function lastNewNoEol(els: BodyEl[]): boolean {
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i]!;
    if (el.k === 'new') return el.noEol;
  }
  return false;
}

/** Raw body lines (starting with ` `, `-`, `+`, `\` or empty) to body elements. */
function parseBody(raw: string[]): BodyEl[] {
  const els: BodyEl[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) {
      if (els.length > 0) els[els.length - 1]!.noEol = true;
      continue;
    }
    if (l === '') els.push({ k: 'ctx', text: '', noEol: false });
    else if (l[0] === ' ') els.push({ k: 'ctx', text: l.slice(1), noEol: false });
    else if (l[0] === '-') els.push({ k: 'old', text: l.slice(1), noEol: false });
    else els.push({ k: 'new', text: l.slice(1), noEol: false });
  }
  return els;
}

/**
 * Build the lines that replace O's match at `pos`: a context line is the file's own matched line,
 * and at tier 2 every other line is re-indented from O's first line to the file's first matched line.
 */
function buildN(o: string[], n: NLine[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return n.map((x) => (x.ctx >= 0 ? fileLines[pos + x.ctx]! : x.text));
  const p = leadingWs(o[0] ?? '');
  const f = leadingWs(fileLines[pos] ?? '');
  return n.map((x) => {
    if (x.ctx >= 0) return fileLines[pos + x.ctx]!;
    const t = x.text;
    if (t === '' || t.trim() === '') return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

/**
 * Apply one hunk or chunk to a file: O is replaced by N, or N is inserted when O is empty.
 * `a` is the hunk's A (unified) and `d` the length drift of the hunks applied so far; returns the
 * new file and the new drift. Throws Fail('no-match', path) when O is nowhere to be found.
 */
function applyHunk(fl: FileState, o: string[], n: NLine[], a: number, d: number, els: BodyEl[], strict: boolean, path: string): { fl: FileState; d: number } {
  if (o.length === 0) {
    // A + d can go below zero when earlier hunks removed lines: inserting after a
    // negative number of lines means inserting at the top, never cutting from the end.
    const idx = Math.max(0, Math.min(a + d, fl.lines.length));
    const texts = n.map((x) => x.text);
    const lines = [...fl.lines.slice(0, idx), ...texts, ...fl.lines.slice(idx)];
    const runsToEnd = idx === fl.lines.length;
    const eol = runsToEnd ? !lastCtxOrNewNoEol(els) : fl.eol;
    return { fl: { br: fl.br, lines, eol }, d: d + n.length };
  }
  const found = findTier(fl.lines, o, 0, strict, false);
  if (found === null) throw new Fail('no-match', path);
  const target = a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const rep = buildN(o, n, fl.lines, best, found.tier);
  const lines = [...fl.lines.slice(0, best), ...rep, ...fl.lines.slice(best + o.length)];
  const runsToEnd = best + o.length === fl.lines.length;
  const eol = runsToEnd ? !lastCtxOrNewNoEol(els) : fl.eol;
  return { fl: { br: fl.br, lines, eol }, d: d + (n.length - o.length) };
}

// ---------- unified diffs (SPEC.md section 6) ----------

interface Hunk {
  a: number;
  els: BodyEl[];
}

/** The path after `--- ` or `+++ `: up to the first tab, trimmed, `/dev/null` as null, `a/`/`b/` stripped. */
function unifiedPath(line: string): string | null {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  let s = (tab >= 0 ? t.slice(0, tab) : t).trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/')) s = s.slice(2);
  else if (s.startsWith('b/')) s = s.slice(2);
  return s;
}

function makeUnifiedEdit(oldPath: string | null, newPath: string | null, newFile: boolean, deletedFile: boolean, hunks: Hunk[], strict: boolean, moves: MovePair[]): Edit {
  return (tree) => {
    const isCreate = oldPath === null || newFile;
    const isDelete = !isCreate && (newPath === null || deletedFile);
    if (isCreate) {
      const p = newPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of hunks) {
        for (const el of h.els) {
          if (el.k === 'new') plus.push(el.text);
        }
      }
      let noEol = false;
      outer: for (let hi = hunks.length - 1; hi >= 0; hi--) {
        const els = hunks[hi]!.els;
        for (let ei = els.length - 1; ei >= 0; ei--) {
          if (els[ei]!.k === 'new') {
            noEol = els[ei]!.noEol;
            break outer;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = oldPath!;
    const newP = newPath!;
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let fl = parseFile(text);
    let d = 0;
    for (const h of hunks) {
      const { o, n } = splitBody(h.els);
      const r = applyHunk(fl, o, n, h.a, d, h.els, strict, oldP);
      fl = r.fl;
      d = r.d;
    }
    const out = serializeFile(fl);
    if (oldP !== newP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function parseUnified(lines: string[], strict: boolean, moves: MovePair[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      diffOld = m[1]!;
      diffNew = m[2]!;
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A section starting at its `---`/`+++` pair: the header loop below consumes it.
    } else {
      i++;
      continue;
    }
    let oldP: string | null = null;
    let newP: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let newFile = false;
    let deletedFile = false;
    let pairSeen = false;
    if (diffOld === null && lines[i]!.startsWith('--- ')) {
      oldP = unifiedPath(lines[i]!);
      newP = unifiedPath(lines[i + 1]!);
      pairSeen = true;
      i += 2;
    }
    const hunks: Hunk[] = [];
    let inHeader = true;
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const a = parseInt(m[1]!, 10);
        i++;
        const raw: string[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
            raw.push(b);
            i++;
          } else break;
        }
        while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
        hunks.push({ a, els: parseBody(raw) });
        inHeader = false;
        continue;
      }
      if (inHeader) {
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ')) {
          if ((lines[i + 1] ?? '').startsWith('+++ ')) {
            if (pairSeen) break;
            oldP = unifiedPath(l);
            newP = unifiedPath(lines[i + 1]!);
            pairSeen = true;
            i += 2;
            continue;
          }
          throw new Exit2(`error: parse ${i + 2}`);
        }
        if (l.startsWith('rename from ')) {
          renameFrom = l.slice(12).trim();
          i++;
          continue;
        }
        if (l.startsWith('rename to ')) {
          renameTo = l.slice(10).trim();
          i++;
          continue;
        }
        if (l.startsWith('new file mode')) {
          newFile = true;
          i++;
          continue;
        }
        if (l.startsWith('deleted file mode')) {
          deletedFile = true;
          i++;
          continue;
        }
        i++;
        continue;
      }
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      i++;
    }
    const oldPath = oldP ?? renameFrom ?? diffOld;
    const newPath = newP ?? renameTo ?? diffNew;
    edits.push(makeUnifiedEdit(oldPath, newPath, newFile, deletedFile, hunks, strict, moves));
  }
  return edits;
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const fl = parseFile(text);
    const found = findTier(fl.lines, oldLines, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const rep = buildN(oldLines, newLines.map((t) => ({ text: t, ctx: -1 })), fl.lines, pos, found.tier);
    const lines = [...fl.lines.slice(0, pos), ...rep, ...fl.lines.slice(pos + oldLines.length)];
    tree.now.set(path, serializeFile({ br: fl.br, lines, eol: fl.eol }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      if (t === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(makeSearchReplaceEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC.md section 8) ----------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  els: BodyEl[];
}

function makeV4aAdd(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** Apply one V4A chunk: the anchor moves the cursor, then O is replaced by N at or after it. */
function applyV4aChunk(fl: FileState, chunk: V4aChunk, cursor: number, strict: boolean, path: string): { fl: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const at = findAnchor(fl.lines, chunk.anchor, cur, strict);
    if (at < 0) throw new Fail('no-match', path);
    cur = at + 1;
  }
  const { o, n } = splitBody(chunk.els);
  if (o.length === 0) {
    const ins = chunk.eof ? fl.lines.length : cur;
    const texts = n.map((x) => x.text);
    const lines = [...fl.lines.slice(0, ins), ...texts, ...fl.lines.slice(ins)];
    return { fl: { br: fl.br, lines, eol: fl.eol }, cursor: ins + texts.length };
  }
  const found = findTier(fl.lines, o, cur, strict, chunk.eof);
  if (found === null) throw new Fail('no-match', path);
  const pos = found.positions[0]!;
  const rep = buildN(o, n, fl.lines, pos, found.tier);
  const lines = [...fl.lines.slice(0, pos), ...rep, ...fl.lines.slice(pos + o.length)];
  return { fl: { br: fl.br, lines, eol: fl.eol }, cursor: pos + rep.length };
}

function makeV4aUpdate(path: string, raw: string[], rawStart: number, headerLine: number, strict: boolean, moves: MovePair[]): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice(13).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let seenChunk = false;
  const lineNo = (j: number): number => rawStart + j + 1;
  for (; idx < raw.length; idx++) {
    const l = raw[idx]!;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, els: [] };
      chunks.push(cur);
      seenChunk = true;
      continue;
    }
    if (l.trim() === '*** End of File' && l[0] !== ' ' && l[0] !== '\t') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo(idx)}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (seenChunk) throw new Exit2(`error: parse ${lineNo(idx)}`);
        cur = { anchor: null, eof: false, els: [] };
        chunks.push(cur);
        seenChunk = true;
      }
      if (l === '') cur.els.push({ k: 'ctx', text: '', noEol: false });
      else if (l[0] === ' ') cur.els.push({ k: 'ctx', text: l.slice(1), noEol: false });
      else if (l[0] === '-') cur.els.push({ k: 'old', text: l.slice(1), noEol: false });
      else cur.els.push({ k: 'new', text: l.slice(1), noEol: false });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo(idx)}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let fl = parseFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      const r = applyV4aChunk(fl, chunk, cursor, strict, path);
      fl = r.fl;
      cursor = r.cursor;
    }
    const out = serializeFile(fl);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean, moves: MovePair[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      i++;
      const content: string[] = [];
      while (i < last && (lines[i]!.startsWith('+') || lines[i]! === '')) {
        content.push(lines[i]!.startsWith('+') ? lines[i]!.slice(1) : '');
        i++;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push(makeV4aAdd(path, content));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i++;
      edits.push(makeV4aDelete(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const headerLine = i + 1;
      i++;
      const rawStart = i;
      while (
        i < last &&
        !lines[i]!.startsWith('*** Add File: ') &&
        !lines[i]!.startsWith('*** Delete File: ') &&
        !lines[i]!.startsWith('*** Update File: ')
      ) {
        i++;
      }
      const raw = lines.slice(rawStart, i);
      while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
      edits.push(makeV4aUpdate(path, raw, rawStart, headerLine, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------- JSON edits (SPEC.md section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- running the CLI (SPEC.md sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: MovePair[] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict, moves)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; text: string }[] = [];
  const hidden = new Set<string>();
  for (const [o, nw] of moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, text: `R ${o} -> ${nw}` });
      hidden.add(o);
      hidden.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(byBytes)) {
    if (hidden.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byBytes(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byBytes)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
