// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

// ---- Sections 3 and 5: the file line model and three-tier matching ----

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A line of N: `ctx` is its index into O for a context line, -1 for an added line. */
interface NLine {
  text: string;
  ctx: number;
}

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(fileLines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > fileLines.length) return out;
  const want = old.map((l) => normLine(l, tier));
  for (let i = 0; i + old.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (normLine(fileLines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs, with its positions. */
function matchTier(fileLines: string[], old: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(fileLines, old, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Replace O at `pos` by N: context lines keep the file's own lines; tier 2 re-indents the rest. */
function replaceAt(fileLines: string[], pos: number, old: string[], next: NLine[], tier: number): string[] {
  const out = fileLines.slice(0, pos);
  if (tier === 2 && old.length > 0) {
    const f = /^[ \t]*/.exec(fileLines[pos]!)![0];
    const p = /^[ \t]*/.exec(old[0]!)![0];
    for (const nl of next) {
      if (nl.ctx >= 0) out.push(fileLines[pos + nl.ctx]!);
      else if (nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) out.push(f + nl.text.slice(p.length));
      else out.push(nl.text);
    }
  } else {
    for (const nl of next) out.push(nl.ctx >= 0 ? fileLines[pos + nl.ctx]! : nl.text);
  }
  out.push(...fileLines.slice(pos + old.length));
  return out;
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  old: string[];
  next: NLine[];
  noEol: boolean;
  plusNoEol: boolean | null;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;

/** A `--- ` / `+++ ` path: after the four characters, to the first tab, spaces trimmed, a/ or b/ removed. */
function headerPath(raw: string): string | null {
  const cut = raw.split('\t')[0]!.trim();
  if (cut === '/dev/null') return null;
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}

function parseUniHeader(lines: string[], start: number, sec: UniSection): number {
  let i = start;
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renOld: string | undefined;
  let renNew: string | undefined;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || line.startsWith('@@')) break;
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        pairOld = headerPath(line.slice(4));
        pairNew = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('+++ ')) {
      pairNew = headerPath(line.slice(4));
      i += 1;
      continue;
    }
    if (line.startsWith('rename from ')) renOld = line.slice('rename from '.length).trim();
    else if (line.startsWith('rename to ')) renNew = line.slice('rename to '.length).trim();
    else if (line.startsWith('new file mode')) sec.create = true;
    else if (line.startsWith('deleted file mode')) sec.remove = true;
    i += 1;
  }
  if (pairOld !== undefined) sec.oldPath = pairOld;
  else if (renOld !== undefined) sec.oldPath = renOld;
  if (pairNew !== undefined) sec.newPath = pairNew;
  else if (renNew !== undefined) sec.newPath = renNew;
  return i;
}

function parseUniHunks(lines: string[], start: number, sec: UniSection): number {
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (!line.startsWith('@@')) {
      i += 1;
      continue;
    }
    const m = HUNK_HEAD.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
    const body: string[] = [];
    while (i < lines.length) {
      const b = lines[i]!;
      if (b.startsWith('diff --git ')) break;
      if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
        body.push(b);
        i += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    let lastCP = -1;
    let lastPlus = -1;
    for (let k = 0; k < body.length; k += 1) {
      const b = body[k]!;
      if (b === '' || b.startsWith(' ') || b.startsWith('+')) lastCP = k;
      if (b.startsWith('+')) lastPlus = k;
    }
    const noEol = lastCP >= 0 && body[lastCP + 1] !== undefined && body[lastCP + 1]!.startsWith('\\');
    const plusNoEol = lastPlus < 0 ? null : body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
    const old: string[] = [];
    const next: NLine[] = [];
    for (const b of body) {
      if (b.startsWith('\\')) continue;
      if (b === '' || b.startsWith(' ')) {
        const text = b === '' ? '' : b.slice(1);
        next.push({ text, ctx: old.length });
        old.push(text);
      } else if (b.startsWith('-')) old.push(b.slice(1));
      else next.push({ text: b.slice(1), ctx: -1 });
    }
    sec.hunks.push({ a: Number(m[1]), old, next, noEol, plusNoEol });
  }
  return i;
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UniSection = { oldPath: m[1]!, newPath: m[2]!, create: false, remove: false, hunks: [] };
      sections.push(sec);
      i = parseUniHeader(lines, i + 1, sec);
      i = parseUniHunks(lines, i, sec);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = { oldPath: headerPath(line.slice(4)), newPath: headerPath(lines[i + 1]!.slice(4)), create: false, remove: false, hunks: [] };
      sections.push(sec);
      i = parseUniHeader(lines, i + 2, sec);
      i = parseUniHunks(lines, i, sec);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => (tree: Tree): void => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.create;
    const isDelete = !isCreate && (newP === null || sec.remove);
    if (isCreate) {
      if (newP === null) return;
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        for (const nl of h.next) if (nl.ctx < 0) out.push(nl.text);
        if (h.plusNoEol !== null) noEol = h.plusNoEol;
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== newP;
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      if (h.old.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const wasEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...h.next.map((nl) => nl.text));
        if (wasEnd) f.final = !h.noEol;
        d += h.next.length;
      } else {
        const m = matchTier(f.lines, h.old, strict);
        if (m === null) throw new Fail('no-match', p);
        const target = h.a - 1 + d;
        let best = m.pos[0]!;
        for (const q of m.pos) if (Math.abs(q - target) < Math.abs(best - target)) best = q;
        const runsToEnd = best + h.old.length === f.lines.length;
        f.lines = replaceAt(f.lines, best, h.old, h.next, m.tier);
        if (runsToEnd) f.final = !h.noEol;
        d += h.next.length - h.old.length;
      }
    }
    const text = joinFile(f);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(newP!, text);
      moves.push([p, newP!]);
    } else {
      tree.now.set(p, text);
    }
  });
}

// ---- Section 7: SEARCH/REPLACE blocks ----

interface SrBlock {
  path: string;
  old: string[];
  next: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, old: lines.slice(searchIdx + 1, sep), next: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.next.length === 0 ? '' : b.next.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = splitFile(before);
    const m = matchTier(f.lines, b.old, strict);
    if (m === null) throw new Fail('no-match', b.path);
    if (m.pos.length > 1) throw new Fail('ambiguous', b.path);
    const nl: NLine[] = b.next.map((t) => ({ text: t, ctx: -1 }));
    f.lines = replaceAt(f.lines, m.pos[0]!, b.old, nl, m.tier);
    tree.now.set(b.path, joinFile(f));
  });
}

// ---- Section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  old: string[];
  next: NLine[];
  eof: boolean;
}

type V4aSection =
  | { kind: 'add'; path: string; body: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[] };

function v4aSectionKind(l: string): 'add' | 'delete' | 'update' | null {
  if (l.startsWith('*** Add File: ')) return 'add';
  if (l.startsWith('*** Delete File: ')) return 'delete';
  if (l.startsWith('*** Update File: ')) return 'update';
  return null;
}

function parseV4aUpdate(path: string, content: string[], contentStart: number, updateLine: number): V4aSection {
  let moveTo: string | null = null;
  let idx = 0;
  if (content.length > 0 && content[0]!.startsWith('*** Move to: ')) {
    moveTo = content[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const isBody = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
  for (; idx < content.length; idx += 1) {
    const l = content[idx]!;
    const lineNo = contentStart + idx + 1;
    if (l.startsWith('@@')) {
      if (cur !== null) chunks.push(cur);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, old: [], next: [], eof: false };
      continue;
    }
    if (l.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      continue;
    }
    if (isBody(l)) {
      if (cur === null) {
        if (chunks.length > 0) {
          if (blank(l)) continue;
          throw new Exit2(`error: parse ${lineNo}`);
        }
        cur = { anchor: null, old: [], next: [], eof: false };
      }
      if (l === '' || l.startsWith(' ')) {
        const text = l === '' ? '' : l.slice(1);
        cur.next.push({ text, ctx: cur.old.length });
        cur.old.push(text);
      } else if (l.startsWith('-')) cur.old.push(l.slice(1));
      else cur.next.push({ text: l.slice(1), ctx: -1 });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  if (cur !== null) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return { kind: 'update', path, moveTo, chunks };
}

function parseV4a(lines: string[]): V4aSection[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = v4aSectionKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const updateLine = i + 1;
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    i += 1;
    const content: string[] = [];
    const contentStart = i;
    while (i < last) {
      if (v4aSectionKind(lines[i]!) !== null) break;
      content.push(lines[i]!);
      i += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
    if (kind === 'add') {
      const body: string[] = [];
      for (let k = 0; k < content.length; k += 1) {
        const l = content[k]!;
        if (l.startsWith('+')) body.push(l.slice(1));
        else if (l === '') body.push('');
        else throw new Exit2(`error: parse ${contentStart + k + 1}`);
      }
      sections.push({ kind: 'add', path, body });
    } else if (kind === 'delete') {
      for (let k = 0; k < content.length; k += 1) {
        if (!blank(content[k]!)) throw new Exit2(`error: parse ${contentStart + k + 1}`);
      }
      sections.push({ kind: 'delete', path });
    } else {
      sections.push(parseV4aUpdate(path, content, contentStart, updateLine));
    }
  }
  return sections;
}

/** First line at or after `from` equal to `line` at the first tier with one; null when none. */
function anchorAt(fileLines: string[], line: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(line, t);
    for (let k = from; k < fileLines.length; k += 1) {
      if (normLine(fileLines[k]!, t) === want) return k;
    }
  }
  return null;
}

/** First occurrence of O at or after `from` at the first tier with one (EOF: must end at the last line). */
function findFrom(fileLines: string[], old: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(fileLines, old, t).filter((p) => p >= from && (!eof || p + old.length === fileLines.length));
    if (pos.length > 0) return { tier: t, pos: pos[0]! };
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.body.length === 0 ? '' : sec.body.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    return (tree: Tree): void => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(sec.path);
      if (before === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const f = splitFile(before);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          const at = anchorAt(f.lines, ch.anchor, cursor, strict);
          if (at === null) throw new Fail('no-match', sec.path);
          cursor = at + 1;
        }
        if (ch.old.length === 0) {
          const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
          const ins = ch.next.map((nl) => nl.text);
          f.lines.splice(at, 0, ...ins);
          cursor = at + ins.length;
        } else {
          const found = findFrom(f.lines, ch.old, cursor, strict, ch.eof);
          if (found === null) throw new Fail('no-match', sec.path);
          f.lines = replaceAt(f.lines, found.pos, ch.old, ch.next, found.tier);
          cursor = found.pos + ch.next.length;
        }
      }
      const text = joinFile(f);
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, text);
        moves.push([sec.path, sec.moveTo]);
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
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
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
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
  const changed: Array<{ key: string; row: string }> = [];
  const merged = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      changed.push({ key: newP, row: `R ${oldP} -> ${newP}` });
      merged.add(oldP);
      merged.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (merged.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  changed.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  const rows = changed.map((c) => c.row);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
