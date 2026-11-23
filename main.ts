// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats — a unified diff,
// SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON — finds the lines each edit names at the
// first of three matching tiers (exact; trailing whitespace ignored; indentation ignored, with the replacement
// re-indented), and writes every change or none, printing what changed or why each edit failed. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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
  /** Successful move edits, in the order they ran: [old path, new path]. */
  readonly moves: [string, string][] = [];
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

/** A file being edited: its lines, its own line break, and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** One line of a hunk or chunk body: a context line, an old line or a new line. */
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line (no line break at end of file) follows this entry. */
  slash: boolean;
  /** The body line was an empty patch line, not a context line with empty text. */
  fromEmpty?: boolean;
}

const lead = (s: string): string => /^[ \t]*/.exec(s)![0]!;
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function matchAt(lines: string[], i: number, o: string[], tier: number): boolean {
  for (let j = 0; j < o.length; j += 1) {
    if (!matchLine(lines[i + j]!, o[j]!, tier)) return false;
  }
  return true;
}

/**
 * The occurrences of O in `lines` at the first tier that has one (SPEC.md section 5), looking only at positions
 * from `from` on; with `eofOnly`, only occurrences that end at the file's last line. Null when no tier has one.
 */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (eofOnly && i + o.length !== lines.length) continue;
      if (matchAt(lines, i, o, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    for (let i = from; i < lines.length; i += 1) {
      if (matchLine(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

/**
 * The lines a matched hunk or chunk writes (SPEC.md section 5): a context line is the file's own matched line;
 * at tier 2 every other new line is re-indented from the old block's indentation to the file's.
 */
function buildWritten(entries: BodyEntry[], fileLines: string[], pos: number, tier: number, oFirst: string): string[] {
  const out: string[] = [];
  let fIndent = '';
  let pIndent = '';
  if (tier === 2) {
    fIndent = lead(fileLines[pos] ?? '');
    pIndent = lead(oFirst);
  }
  let oi = 0;
  for (const e of entries) {
    if (e.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (e.kind === 'old') {
      oi += 1;
    } else {
      let t = e.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(pIndent)) t = fIndent + t.slice(pIndent.length);
      out.push(t);
    }
  }
  return out;
}

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
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(f));
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

interface Hunk {
  /** The A of the hunk header `@@ -A[,B] +C[,D] @@`; B and D are not used. */
  a: number;
  entries: BodyEntry[];
}

/** The hunks of one unified section applied in order to a file (SPEC.md section 6). */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, errPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = h.entries.filter((e) => e.kind !== 'new').map((e) => e.text);
    const nLen = h.entries.filter((e) => e.kind !== 'old').length;
    if (o.length > 0) {
      const found = findTier(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let p = found.positions[0]!;
      for (const cand of found.positions) {
        if (Math.abs(cand - target) < Math.abs(p - target)) p = cand;
      }
      const written = buildWritten(h.entries, f.lines, p, found.tier, o[0]!);
      const runsToEnd = p + o.length === f.lines.length;
      f.lines.splice(p, o.length, ...written);
      if (runsToEnd) {
        const lastNew = [...h.entries].reverse().find((e) => e.kind !== 'old');
        f.finalBreak = !(lastNew !== undefined && lastNew.slash);
      }
      d += nLen - o.length;
    } else {
      const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...h.entries.map((e) => e.text));
      if (atEnd) {
        const lastNew = h.entries[h.entries.length - 1];
        f.finalBreak = !(lastNew !== undefined && lastNew.slash);
      }
      d += nLen;
    }
  }
}

interface UnifiedSection {
  /** Null: the patch names /dev/null on that side. */
  oldP: string | null;
  newP: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** One unified section as one edit (SPEC.md section 6). */
function unifiedSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  const { oldP, newP, newFile, deletedFile, hunks } = sec;
  const isCreate = (oldP === null || newFile) && newP !== null;
  const isDelete = !isCreate && (newP === null || deletedFile);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const target = newP!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: BodyEntry[] = [];
      for (const h of hunks) for (const e of h.entries) if (e.kind === 'new') plus.push(e);
      const last = plus[plus.length - 1];
      tree.now.set(target, serializeFile({ lines: plus.map((e) => e.text), br: '\n', finalBreak: !(last !== undefined && last.slash) }));
    } else if (isDelete) {
      const target = oldP ?? newP ?? '';
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    } else if (isMove) {
      const before = tree.get(oldP!);
      if (before === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      const f = parseFile(before);
      applyHunks(f, hunks, strict, oldP!);
      tree.now.set(newP!, serializeFile(f));
      tree.now.set(oldP!, null);
      tree.moves.push([oldP!, newP!]);
    } else {
      const target = oldP ?? newP ?? '';
      const before = tree.get(target);
      if (before === null) throw new Fail('missing', target);
      const f = parseFile(before);
      applyHunks(f, hunks, strict, target);
      tree.now.set(target, serializeFile(f));
    }
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The two paths of a `diff --git a/<X> b/<Y>` line; any other form is a parse error at that line. */
function diffGitPaths(l: string, ln: number): [string, string] {
  const rest = l.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${ln}`);
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) throw new Exit2(`error: parse ${ln}`);
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${ln}`);
  return [x, y];
}

/** The path a `--- ` or `+++ ` header line names (SPEC.md section 6); null for /dev/null. */
function headerPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');

/** Unified diffs (SPEC.md section 6): sections, their headers, and their hunks. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  const pairAt = (j: number): boolean => j < n && lines[j]!.startsWith('--- ') && j + 1 < n && lines[j + 1]!.startsWith('+++ ');

  const parseSection = (diffX: string | null, diffY: string | null): void => {
    let oldPath: string | null | undefined;
    let newPath: string | null | undefined;
    let sawPair = false;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let newFile = false;
    let deletedFile = false;
    const hunks: Hunk[] = [];
    let inHeader = true;
    while (inHeader && i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        if (i + 1 >= n || !lines[i + 1]!.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        oldPath = headerPath(l);
        newPath = headerPath(lines[i + 1]!);
        sawPair = true;
        i += 2;
      } else if (l.startsWith('+++ ')) {
        newPath = headerPath(l);
        i += 1;
      } else if (l.startsWith('rename from ')) {
        renameFrom = trimSpaces(l.slice('rename from '.length));
        i += 1;
      } else if (l.startsWith('rename to ')) {
        renameTo = trimSpaces(l.slice('rename to '.length));
        i += 1;
      } else if (l.startsWith('new file mode')) {
        newFile = true;
        i += 1;
      } else if (l.startsWith('deleted file mode')) {
        deletedFile = true;
        i += 1;
      } else if (l.startsWith('@@')) {
        inHeader = false;
      } else {
        i += 1;
      }
    }
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (pairAt(i)) break;
      if (!l.startsWith('@@')) {
        i += 1;
        continue;
      }
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const entries: BodyEntry[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (pairAt(i)) break;
        if (b === '') entries.push({ kind: 'ctx', text: '', slash: false, fromEmpty: true });
        else if (b[0] === ' ') entries.push({ kind: 'ctx', text: b.slice(1), slash: false });
        else if (b[0] === '-') entries.push({ kind: 'old', text: b.slice(1), slash: false });
        else if (b[0] === '+') entries.push({ kind: 'new', text: b.slice(1), slash: false });
        else if (b[0] === '\\') {
          const last = entries[entries.length - 1];
          if (last !== undefined) last.slash = true;
        } else break;
        i += 1;
      }
      while (entries.length > 0) {
        const last = entries[entries.length - 1]!;
        if (last.fromEmpty === true && !last.slash) entries.pop();
        else break;
      }
      hunks.push({ a, entries });
    }
    let oldP: string | null;
    let newP: string | null;
    if (sawPair) {
      oldP = oldPath!;
      newP = newPath!;
    } else {
      oldP = renameFrom !== undefined ? renameFrom : diffX;
      newP = renameTo !== undefined ? renameTo : diffY;
      if (oldP === '/dev/null') oldP = null;
      if (newP === '/dev/null') newP = null;
    }
    edits.push(unifiedSectionEdit({ oldP, newP, newFile, deletedFile, hunks }, strict));
  };

  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const [x, y] = diffGitPaths(l, i + 1);
      i += 1;
      parseSection(x, y);
    } else if (pairAt(i)) {
      parseSection(null, null);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return edits;
}

/** One SEARCH/REPLACE block as one edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, serializeFile({ lines: [...newLines], br: '\n', finalBreak: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const p = found.positions[0]!;
    const entries: BodyEntry[] = newLines.map((t) => ({ kind: 'new' as const, text: t, slash: false }));
    const written = buildWritten(entries, f.lines, p, found.tier, oldLines[0]!);
    f.lines.splice(p, oldLines.length, ...written);
    tree.now.set(path, serializeFile(f));
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). Lines outside blocks are ignored. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= regionStart; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    regionStart = rep + 1;
    i = rep + 1;
  }
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

/** One V4A Update File section as one edit (SPEC.md section 8). */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(f.lines, chunk.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o = chunk.entries.filter((e) => e.kind !== 'new').map((e) => e.text);
      if (o.length === 0) {
        const pos = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        const texts = chunk.entries.map((e) => e.text);
        f.lines.splice(pos, 0, ...texts);
        cursor = pos + texts.length;
      } else {
        const found = findTier(f.lines, o, strict, cursor, chunk.eof);
        if (found === null) throw new Fail('no-match', path);
        const p = found.positions[0]!;
        const written = buildWritten(chunk.entries, f.lines, p, found.tier, o[0]!);
        f.lines.splice(p, o.length, ...written);
        cursor = p + written.length;
      }
    }
    if (moveTo !== null) {
      tree.now.set(moveTo, serializeFile(f));
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, serializeFile(f));
    }
  };
}

/** V4A patches (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let j = lines.length - 1; j > firstIdx; j -= 1) {
    if (!blank(lines[j]!)) {
      lastIdx = j;
      break;
    }
  }
  if (lastIdx < 0 || lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): { kind: 'add' | 'delete' | 'update'; prefix: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', prefix: '*** Add File: ' };
    if (l.startsWith('*** Delete File: ')) return { kind: 'delete', prefix: '*** Delete File: ' };
    if (l.startsWith('*** Update File: ')) return { kind: 'update', prefix: '*** Update File: ' };
    return null;
  };
  const edits: Edit[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const start = sectionStart(l);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const path = l.slice(start.prefix.length).trim();
    i += 1;
    const raw: { n: number; text: string }[] = [];
    while (i < lastIdx && sectionStart(lines[i]!) === null) {
      raw.push({ n: i + 1, text: lines[i]! });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (start.kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.n}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, serializeFile({ lines: fileLines, br: '\n', finalBreak: true }));
      });
    } else if (start.kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.n}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; k < raw.length; k += 1) {
        const r = raw[k]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          closeChunk();
          const a = t.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, entries: [] };
        } else if (t === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: false, entries: [] };
          cur.eof = true;
          closeChunk();
        } else if (t.startsWith('*** ')) {
          throw new Exit2(`error: parse ${r.n}`);
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, entries: [] };
          if (t === '') cur.entries.push({ kind: 'ctx', text: '', slash: false });
          else if (t[0] === ' ') cur.entries.push({ kind: 'ctx', text: t.slice(1), slash: false });
          else if (t[0] === '-') cur.entries.push({ kind: 'old', text: t.slice(1), slash: false });
          else cur.entries.push({ kind: 'new', text: t.slice(1), slash: false });
        } else {
          throw new Exit2(`error: parse ${r.n}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const consumed = new Set<string>();
  const keyed: { key: string; line: string }[] = [];
  for (const [o, nw] of tree.moves) {
    if (consumed.has(o) || consumed.has(nw)) continue;
    const oWas = tree.original(o);
    const oNow = tree.get(o);
    const nWas = tree.original(nw);
    const nNow = tree.get(nw);
    if (oWas !== null && oNow === null && nWas === null && nNow !== null) {
      keyed.push({ key: nw, line: `R ${o} -> ${nw}` });
      consumed.add(o);
      consumed.add(nw);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    keyed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const rows = keyed.map((k) => k.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
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
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
