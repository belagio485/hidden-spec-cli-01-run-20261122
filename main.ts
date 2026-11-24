// mend: one patch tool for every AI edit format.
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits) and applies it to the tree of text files under the
// working directory, changing every file or none.
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import * as fs from "node:fs";
import * as path from "node:path";

function printLines(lines: string[]): void {
  if (lines.length > 0) process.stdout.write(lines.join("\n") + "\n");
}

interface EditResult {
  ok: boolean;
  code?: string;
  path?: string;
}

interface Edit {
  run(tree: Tree, moves: { old: string; new: string }[]): EditResult;
}

function fail(code: string, p: string): EditResult {
  return { ok: false, code, path: p };
}

function succeed(): EditResult {
  return { ok: true };
}

function main(): void {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);
  if (parsed.error) {
    printLines(["error: usage"]);
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (parsed.patchArg === null || parsed.patchArg === "-") {
    patchText = fs.readFileSync(0, "utf8");
  } else {
    try {
      patchText = fs.readFileSync(path.join(process.cwd(), parsed.patchArg), "utf8");
    } catch {
      printLines(["error: no-patch"]);
      process.exitCode = 2;
      return;
    }
  }
  const patchLines = splitPatch(patchText);
  let fmt = parsed.format;
  if (fmt === "auto") {
    const detected = detectFormat(patchLines);
    if (!detected) {
      printLines(["error: format"]);
      process.exitCode = 2;
      return;
    }
    fmt = detected;
  }
  let edits: Edit[];
  try {
    edits = parsePatch(fmt, patchLines, parsed.strict);
  } catch (e) {
    if (e && typeof e === "object" && "parseLine" in (e as Record<string, unknown>)) {
      printLines([`error: parse ${(e as { parseLine: number }).parseLine}`]);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  const tree = new Tree();
  const moves: { old: string; new: string }[] = [];
  const failures: { code: string; path: string }[] = [];
  for (const ed of edits) {
    const r = ed.run(tree, moves);
    if (!r.ok) failures.push({ code: r.code as string, path: r.path as string });
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    printLines(out);
    process.exitCode = 1;
    return;
  }
  const outLines = computeOutput(tree, moves);
  outLines.push(outLines.length === 1 ? "ok: 1 file" : `ok: ${outLines.length} files`);
  if (!parsed.check) writeTree(tree);
  printLines(outLines);
  process.exitCode = 0;
}

interface ParsedArgs {
  error: boolean;
  format: string;
  check: boolean;
  strict: boolean;
  patchArg: string | null;
}

function parseArgs(args: string[]): ParsedArgs {
  const bad: ParsedArgs = { error: true, format: "auto", check: false, strict: false, patchArg: null };
  let format = "auto";
  let check = false;
  let strict = false;
  let formatSeen = false;
  let checkSeen = false;
  let strictSeen = false;
  let patchArg: string | null = null;
  let positional = 0;
  let noMoreOptions = false;
  for (const a of args) {
    if (!noMoreOptions && a === "--") {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith("-") && a !== "-") {
      if (a === "--check") {
        if (checkSeen) return bad;
        checkSeen = true;
        check = true;
      } else if (a === "--strict") {
        if (strictSeen) return bad;
        strictSeen = true;
        strict = true;
      } else if (a.startsWith("--format=")) {
        if (formatSeen) return bad;
        formatSeen = true;
        const v = a.slice("--format=".length);
        if (v !== "unified" && v !== "search-replace" && v !== "v4a" && v !== "json" && v !== "auto") return bad;
        format = v;
      } else {
        return bad;
      }
    } else {
      positional++;
      if (positional > 1) return bad;
      patchArg = a;
    }
  }
  return { error: false, format, check, strict, patchArg };
}

// A patch's lines are its text split at \n, each with one trailing \r
// removed, and without the empty piece after a final \n.
function splitPatch(text: string): string[] {
  const raw = text.split("\n");
  if (text.endsWith("\n")) raw.pop();
  return raw.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

// ---- Files, lines and paths ----

type Break = "\n" | "\r\n";

function detectBreak(text: string): Break {
  const i = text.indexOf("\n");
  if (i > 0 && text[i - 1] === "\r") return "\r\n";
  return "\n";
}

interface SplitFile {
  lines: string[];
  brk: Break;
  endsWithBreak: boolean;
}

// A file's lines are its text split at its own line break. It ends with a
// line break when its text ends with that break; that last, empty piece is
// not a line. An empty file has no lines and does not end with a line break.
function splitFile(text: string): SplitFile {
  if (text === "") return { lines: [], brk: "\n", endsWithBreak: false };
  const brk = detectBreak(text);
  return splitByBreak(text, brk);
}

function splitByBreak(text: string, brk: Break): SplitFile {
  if (text === "") return { lines: [], brk, endsWithBreak: false };
  const parts = text.split(brk);
  let endsWithBreak = false;
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
    endsWithBreak = true;
  }
  return { lines: parts, brk, endsWithBreak };
}

function joinFile(lines: string[], brk: Break, endsWithBreak: boolean): string {
  if (lines.length === 0) return "";
  return lines.join(brk) + (endsWithBreak ? brk : "");
}

// A path is safe when it is not empty, does not start with /, holds no \,
// and none of its /-separated segments is empty, . or ...
function isSafePath(p: string): boolean {
  if (p === "") return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

interface FileState {
  lines: string[];
  brk: Break;
  endsWithBreak: boolean;
  present: boolean;
  existed: boolean;
  origText: string | null;
}

// The tree as the patch leaves it, loaded lazily from disk. Nothing is
// written until every edit has run and none failed.
class Tree {
  private files = new Map<string, FileState>();

  get(p: string): FileState {
    let f = this.files.get(p);
    if (!f) {
      const abs = path.join(process.cwd(), p);
      let text: string | null = null;
      try {
        if (fs.statSync(abs).isFile()) text = fs.readFileSync(abs, "utf8");
      } catch {
        text = null;
      }
      if (text === null) {
        f = { lines: [], brk: "\n", endsWithBreak: false, present: false, existed: false, origText: null };
      } else {
        const s = splitFile(text);
        f = { lines: s.lines, brk: s.brk, endsWithBreak: s.endsWithBreak, present: true, existed: true, origText: text };
      }
      this.files.set(p, f);
    }
    return f;
  }

  set(p: string, lines: string[], brk: Break, endsWithBreak: boolean): void {
    const f = this.get(p);
    f.lines = lines;
    f.brk = brk;
    f.endsWithBreak = endsWithBreak;
    f.present = true;
  }

  remove(p: string): void {
    const f = this.get(p);
    f.lines = [];
    f.endsWithBreak = false;
    f.present = false;
  }

  all(): IterableIterator<[string, FileState]> {
    return this.files.entries();
  }

  textOf(f: FileState): string {
    return joinFile(f.lines, f.brk, f.endsWithBreak);
  }
}

// ---- Matching lines ----

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, "");
  return line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
}

function occurrencesAt(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  const want = oldLines.map((l) => normLine(l, tier));
  for (let i = from; i + oldLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (normLine(fileLines[i + j], tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier at which O occurs at least once, with its occurrences.
function findTier(fileLines: string[], oldLines: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(fileLines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// First line at or after `from` equal to a single-line anchor, at the first
// tier where one is.
function findAnchor(fileLines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < fileLines.length; i++) {
      if (normLine(fileLines[i], t) === want) return i;
    }
  }
  return -1;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : "";
}

// At tier 2 every non-context line of N is re-indented: the leading spaces
// and tabs of O's first line are replaced by those of the file's first
// matched line.
function reindent(line: string, pLead: string, fLead: string): string {
  if (line === "" || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(pLead)) return fLead + line.slice(pLead.length);
  return line;
}

interface NewLine {
  text: string;
  ctx: boolean;
  oIndex: number | null;
}

// Build N's lines. A context line is written as the file's own matched
// line, never the patch's; other lines are re-indented at tier 2.
function buildN(entries: NewLine[], fileLines: string[], at: number, tier: number, oLines: string[]): string[] {
  if (tier !== 2) {
    return entries.map((e) => (e.ctx ? fileLines[at + (e.oIndex ?? 0)] : e.text));
  }
  const pLead = leadingWs(oLines[0] ?? "");
  const fLead = leadingWs(fileLines[at] ?? "");
  return entries.map((e) => (e.ctx ? fileLines[at + (e.oIndex ?? 0)] : reindent(e.text, pLead, fLead)));
}

function countOccurrences(hay: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = hay.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + 1;
  }
  return count;
}

// ---- Detecting the format ----

function detectFormat(lines: string[]): string | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank === -1) return null;
  if (lines[firstNonBlank].trim() === "*** Begin Patch") return "v4a";
  const firstChar = lines[firstNonBlank].trimStart()[0];
  if (firstChar === "[" || firstChar === "{") return "json";
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, "") === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) return "unified";
  }
  return null;
}

function parseError(line: number): never {
  throw { parseLine: line };
}

function parsePatch(fmt: string, lines: string[], strict: boolean): Edit[] {
  if (fmt === "unified") return parseUnified(lines, strict);
  if (fmt === "search-replace") return parseSearchReplace(lines, strict);
  if (fmt === "v4a") return parseV4a(lines, strict);
  return parseJson(lines, strict);
}

// ---- Unified diffs ----

interface UnifiedHunk {
  a: number;
  body: string[];
}

interface UnifiedSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  creation: boolean;
  deletion: boolean;
  hasPair: boolean;
  hunks: UnifiedHunk[];
}

// The path is the text after the four characters, up to the first tab, with
// surrounding spaces removed. /dev/null means no file. A leading a/ or b/
// is removed from either.
function parseHeaderPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf("\t");
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === "/dev/null") return null;
  if (p.startsWith("a/")) return p.slice(2);
  if (p.startsWith("b/")) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | null = null;
  let inHeader = false;
  let hunk: UnifiedHunk | null = null;

  function endHunk(): void {
    if (hunk) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === "") hunk.body.pop();
      hunk = null;
    }
  }

  function newSection(): void {
    endHunk();
    section = {
      pairOld: undefined,
      pairNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      diffOld: undefined,
      diffNew: undefined,
      creation: false,
      deletion: false,
      hasPair: false,
      hunks: [],
    };
    sections.push(section);
    inHeader = true;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hunk) {
      if (line.startsWith("diff --git ")) {
        endHunk();
      } else if (line.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
        endHunk();
      } else if (line === "" || line[0] === " " || line[0] === "-" || line[0] === "+" || line[0] === "\\") {
        hunk.body.push(line);
        continue;
      } else {
        endHunk();
      }
    }
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) parseError(i + 1);
      newSection();
      (section as UnifiedSection).diffOld = m[1];
      (section as UnifiedSection).diffNew = m[2];
      continue;
    }
    if (line.startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      if (section && inHeader && !section.hasPair) {
        section.hasPair = true;
        section.pairOld = parseHeaderPath(line);
        section.pairNew = parseHeaderPath(lines[i + 1]);
        i++;
        continue;
      }
      newSection();
      (section as UnifiedSection).hasPair = true;
      (section as UnifiedSection).pairOld = parseHeaderPath(line);
      (section as UnifiedSection).pairNew = parseHeaderPath(lines[i + 1]);
      i++;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (section && inHeader) parseError(i + 2);
      continue;
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) parseError(i + 1);
      if (!section) parseError(i + 1);
      endHunk();
      inHeader = false;
      hunk = { a: parseInt(m[1], 10), body: [] };
      (section as UnifiedSection).hunks.push(hunk);
      continue;
    }
    if (section && inHeader) {
      if (line.startsWith("rename from ")) section.renameOld = line.slice("rename from ".length).trim();
      else if (line.startsWith("rename to ")) section.renameNew = line.slice("rename to ".length).trim();
      else if (line.startsWith("new file mode")) section.creation = true;
      else if (line.startsWith("deleted file mode")) section.deletion = true;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
  }
  endHunk();
  if (sections.length === 0) parseError(1);
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

// Split a hunk body into O (context and - lines) and N (context and +
// lines, in body order). A \ line is a marker, not a line of either.
function hunkON(body: string[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const line of body) {
    if (line === "" || line.startsWith(" ")) {
      const t = line === "" ? "" : line.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIndex: o.length - 1 });
    } else if (line.startsWith("-")) {
      o.push(line.slice(1));
    } else if (line.startsWith("+")) {
      n.push({ text: line.slice(1), ctx: false, oIndex: null });
    }
  }
  return { o, n };
}

// Whether a \ line follows the hunk's last context or + line.
function backslashAfterLastCtxPlus(body: string[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j] === "" || body[j].startsWith(" ") || body[j].startsWith("+")) last = j;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1].startsWith("\\");
}

// Whether a \ line follows the hunk's last + line.
function backslashAfterLastPlus(body: string[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j].startsWith("+")) last = j;
  }
  return last >= 0 && last + 1 < body.length && body[last + 1].startsWith("\\");
}

interface HunkOutcome {
  lines: string[];
  endsWithBreak: boolean;
}

// Apply a section's hunks in order, each to the result of the ones before
// it. Returns null when a hunk finds no match.
function applyHunks(lines: string[], endsWithBreak: boolean, hunks: UnifiedHunk[], strict: boolean): HunkOutcome | null {
  let cur = lines;
  let curEnds = endsWithBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h.body);
    if (o.length > 0) {
      const found = findTier(cur, o, strict);
      if (!found) return null;
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const at = best;
      const reachedEnd = at + o.length === cur.length;
      const newLines = buildN(n, cur, at, found.tier, o);
      cur = [...cur.slice(0, at), ...newLines, ...cur.slice(at + o.length)];
      if (reachedEnd) curEnds = !backslashAfterLastCtxPlus(h.body);
      d += n.length - o.length;
    } else {
      const pos = Math.max(0, Math.min(h.a + d, cur.length));
      const newLines = n.map((e) => e.text);
      const atEnd = pos === cur.length;
      cur = [...cur.slice(0, pos), ...newLines, ...cur.slice(pos)];
      if (atEnd) curEnds = !backslashAfterLastCtxPlus(h.body);
      d += n.length;
    }
  }
  return { lines: cur, endsWithBreak: curEnds };
}

function makeUnifiedEdit(s: UnifiedSection, strict: boolean): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.diffOld;
  const newPath = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.diffNew;
  const oldP: string | null = oldPath === undefined ? null : oldPath;
  const newP: string | null = newPath === undefined ? null : newPath;
  const isCreation = s.creation || oldP === null;
  const isDeletion = !isCreation && (s.deletion || newP === null);
  return {
    run(tree: Tree, moves: { old: string; new: string }[]): EditResult {
      if (isCreation) {
        const p = newP ?? "";
        if (!isSafePath(p)) return fail("unsafe", p);
        const f = tree.get(p);
        if (f.present) return fail("exists", p);
        const plusLines: string[] = [];
        for (const h of s.hunks) {
          for (const line of h.body) {
            if (line.startsWith("+")) plusLines.push(line.slice(1));
          }
        }
        // A created file ends with a line break unless a \ line follows
        // its last + line.
        let endsWithBreak = plusLines.length > 0;
        outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          const body = s.hunks[hi].body;
          for (let j = body.length - 1; j >= 0; j--) {
            if (body[j].startsWith("+")) {
              endsWithBreak = !(j + 1 < body.length && body[j + 1].startsWith("\\"));
              break outer;
            }
          }
        }
        tree.set(p, plusLines, "\n", endsWithBreak);
        return succeed();
      }
      if (isDeletion) {
        const p = oldP ?? "";
        if (!isSafePath(p)) return fail("unsafe", p);
        const f = tree.get(p);
        if (!f.present) return fail("missing", p);
        tree.remove(p);
        return succeed();
      }
      const p = oldP ?? "";
      const q = newP ?? "";
      const isMove = p !== q;
      if (!isSafePath(p)) return fail("unsafe", p);
      if (isMove && !isSafePath(q)) return fail("unsafe", q);
      const f = tree.get(p);
      if (!f.present) return fail("missing", p);
      if (isMove) {
        const g = tree.get(q);
        if (g.present) return fail("exists", q);
      }
      const out = applyHunks(f.lines, f.endsWithBreak, s.hunks, strict);
      if (!out) return fail("no-match", p);
      if (isMove) {
        tree.set(q, out.lines, f.brk, out.endsWithBreak);
        tree.remove(p);
        moves.push({ old: p, new: q });
      } else {
        f.lines = out.lines;
        f.endsWithBreak = out.endsWithBreak;
      }
      return succeed();
    },
  };
}

// ---- SEARCH/REPLACE blocks ----

function markerLine(line: string, marker: string): boolean {
  return line.replace(/[ \t]+$/, "") === marker;
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!markerLine(lines[i], "<<<<<<< SEARCH")) continue;
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (markerLine(lines[j], "=======")) {
        eq = j;
        break;
      }
    }
    if (eq === -1) parseError(searchLine);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (markerLine(lines[j], ">>>>>>> REPLACE")) {
        rep = j;
        break;
      }
    }
    if (rep === -1) parseError(searchLine);
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line, that is not blank and does not start
    // with three backticks.
    let p: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const t = lines[j];
      if (t.trim() === "") continue;
      if (t.trim().startsWith("```")) continue;
      p = t.trim();
      break;
    }
    if (p === null) {
      if (prevPath === null) parseError(searchLine);
      p = prevPath;
    }
    prevPath = p;
    prevReplaceEnd = rep;
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSearchReplaceEdit(p, oldLines, newLines, strict));
    i = rep;
  }
  if (edits.length === 0) parseError(1);
  return edits;
}

function makeSearchReplaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return {
    run(tree: Tree): EditResult {
      if (!isSafePath(p)) return fail("unsafe", p);
      const f = tree.get(p);
      if (oldLines.length === 0) {
        if (f.present) return fail("exists", p);
        tree.set(p, [...newLines], "\n", newLines.length > 0);
        return succeed();
      }
      if (!f.present) return fail("missing", p);
      const found = findTier(f.lines, oldLines, strict);
      if (!found) return fail("no-match", p);
      if (found.occ.length > 1) return fail("ambiguous", p);
      const at = found.occ[0];
      const entries: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: null }));
      const newL = buildN(entries, f.lines, at, found.tier, oldLines);
      f.lines = [...f.lines.slice(0, at), ...newL, ...f.lines.slice(at + oldLines.length)];
      return succeed();
    },
  };
}

// ---- V4A patches ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function stripTrailingBlanks(body: string[]): void {
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) parseError(1);
  if (lines[first].trim() !== "*** Begin Patch") parseError(first + 1);
  if (lines[last].trim() !== "*** End Patch") parseError(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const p = line.slice("*** Add File: ".length).trim();
      i++;
      const content: string[] = [];
      while (i < last) {
        const l = lines[i];
        if (l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("*** Update File: ")) break;
        if (isBlank(l)) {
          content.push("");
          i++;
          continue;
        }
        if (!l.startsWith("+")) parseError(i + 1);
        content.push(l.slice(1));
        i++;
      }
      stripTrailingBlanks(content);
      edits.push(makeV4aAdd(p, content));
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const p = line.slice("*** Delete File: ".length).trim();
      i++;
      while (i < last) {
        const l = lines[i];
        if (l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("*** Update File: ")) break;
        if (isBlank(l)) {
          i++;
          continue;
        }
        parseError(i + 1);
      }
      edits.push(makeV4aDelete(p));
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const p = line.slice("*** Update File: ".length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      while (i < last && isBlank(lines[i])) i++;
      if (i < last && lines[i].startsWith("*** Move to: ")) {
        moveTo = lines[i].slice("*** Move to: ".length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const closeChunk = () => {
        cur = null;
      };
      while (i < last) {
        const l = lines[i];
        if (l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("*** Update File: ")) break;
        if (l.startsWith("@@")) {
          closeChunk();
          cur = { anchor: l.slice(2).trim() === "" ? null : l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          i++;
          continue;
        }
        if (l.trim() === "*** End of File") {
          if (!cur) {
            cur = { anchor: null, eof: true, body: [] };
            chunks.push(cur);
          } else {
            cur.eof = true;
          }
          closeChunk();
          i++;
          continue;
        }
        if (l === "" || isBlank(l) || l.startsWith(" ") || l.startsWith("-") || l.startsWith("+")) {
          if (!cur) {
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push(isBlank(l) ? "" : l);
          i++;
          continue;
        }
        parseError(i + 1);
      }
      // Blank lines at the end of a section are not part of it.
      if (chunks.length > 0) stripTrailingBlanks(chunks[chunks.length - 1].body);
      if (chunks.length === 0 && moveTo === null) parseError(updateLine);
      edits.push(makeV4aUpdate(p, moveTo, chunks, strict));
      continue;
    }
    parseError(i + 1);
  }
  if (edits.length === 0) parseError(1);
  return edits;
}

function makeV4aAdd(p: string, content: string[]): Edit {
  return {
    run(tree: Tree): EditResult {
      if (!isSafePath(p)) return fail("unsafe", p);
      const f = tree.get(p);
      if (f.present) return fail("exists", p);
      tree.set(p, [...content], "\n", content.length > 0);
      return succeed();
    },
  };
}

function makeV4aDelete(p: string): Edit {
  return {
    run(tree: Tree): EditResult {
      if (!isSafePath(p)) return fail("unsafe", p);
      const f = tree.get(p);
      if (!f.present) return fail("missing", p);
      tree.remove(p);
      return succeed();
    },
  };
}

function makeV4aUpdate(p: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return {
    run(tree: Tree, moves: { old: string; new: string }[]): EditResult {
      if (!isSafePath(p)) return fail("unsafe", p);
      if (moveTo !== null && !isSafePath(moveTo)) return fail("unsafe", moveTo);
      const f = tree.get(p);
      if (!f.present) return fail("missing", p);
      if (moveTo !== null) {
        const g = tree.get(moveTo);
        if (g.present) return fail("exists", moveTo);
      }
      let lines = [...f.lines];
      const brk = f.brk;
      const endsWithBreak = f.endsWithBreak;
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const idx = findAnchor(lines, ch.anchor, cursor, strict);
          if (idx === -1) return fail("no-match", p);
          cursor = idx + 1;
        }
        const { o, n } = hunkON(ch.body);
        if (o.length > 0) {
          // The first occurrence at or after the cursor, at the first tier
          // with one; an end-of-file chunk takes only an occurrence that
          // ends at the file's last line.
          let found: { tier: number; occ: number[] } | null = null;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            let occ = occurrencesAt(lines, o, t, cursor);
            if (ch.eof) occ = occ.filter((pos) => pos + o.length === lines.length);
            if (occ.length > 0) {
              found = { tier: t, occ };
              break;
            }
          }
          if (!found) return fail("no-match", p);
          const at = found.occ[0];
          const newL = buildN(n, lines, at, found.tier, o);
          lines = [...lines.slice(0, at), ...newL, ...lines.slice(at + o.length)];
          cursor = at + newL.length;
        } else {
          const pos = ch.eof ? lines.length : cursor;
          const newL = n.map((e) => e.text);
          lines = [...lines.slice(0, pos), ...newL, ...lines.slice(pos)];
          cursor = pos + newL.length;
        }
      }
      if (moveTo !== null) {
        tree.set(moveTo, lines, brk, endsWithBreak);
        tree.remove(p);
        moves.push({ old: p, new: moveTo });
      } else {
        f.lines = lines;
      }
      return succeed();
    },
  };
}

// ---- JSON edits ----

type JsonEdit =
  | { kind: "create"; path: string; fileText: string }
  | { kind: "str_replace"; path: string; oldStr: string; newStr: string }
  | { kind: "insert"; path: string; insertLine: number; newStr: string };

function parseJsonEditObject(obj: unknown): JsonEdit | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== "string") return null;
  if (typeof o.command !== "string") return null;
  if (o.command === "create") {
    if (typeof o.file_text !== "string") return null;
    return { kind: "create", path: o.path, fileText: o.file_text };
  }
  if (o.command === "str_replace") {
    if (typeof o.old_str !== "string" || o.old_str === "") return null;
    if (o.new_str !== undefined && typeof o.new_str !== "string") return null;
    return { kind: "str_replace", path: o.path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? "" };
  }
  if (o.command === "insert") {
    if (typeof o.insert_line !== "number" || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== "string") return null;
    return { kind: "insert", path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], _strict: boolean): Edit[] {
  const edits: JsonEdit[] = [];
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank === -1) parseError(1);
  const firstChar = lines[firstNonBlank].trimStart()[0];
  if (firstChar === "[") {
    // One JSON array of edit objects. Any fault is reported at the line
    // where the array starts.
    const arrayLine = firstNonBlank + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines.join("\n"));
    } catch {
      parseError(arrayLine);
    }
    if (!Array.isArray(parsed)) parseError(arrayLine);
    for (const el of parsed as unknown[]) {
      const e = parseJsonEditObject(el);
      if (!e) parseError(arrayLine);
      edits.push(e);
    }
  } else {
    // JSON Lines: one edit object a line, blank lines ignored.
    for (let i = 0; i < lines.length; i++) {
      if (isBlank(lines[i])) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        parseError(i + 1);
      }
      const e = parseJsonEditObject(parsed);
      if (!e) parseError(i + 1);
      edits.push(e);
    }
  }
  if (edits.length === 0) parseError(1);
  return edits.map((e) => makeJsonEdit(e));
}

function makeJsonEdit(e: JsonEdit): Edit {
  return {
    run(tree: Tree): EditResult {
      if (!isSafePath(e.path)) return fail("unsafe", e.path);
      const f = tree.get(e.path);
      if (e.kind === "create") {
        if (f.present) return fail("exists", e.path);
        const s = splitFile(e.fileText);
        tree.set(e.path, s.lines, s.brk, s.endsWithBreak);
        return succeed();
      }
      if (!f.present) return fail("missing", e.path);
      if (e.kind === "str_replace") {
        const text = tree.textOf(f);
        if (f.brk === "\r\n") {
          const normText = text.split("\r\n").join("\n");
          const normOld = e.oldStr.split("\r\n").join("\n");
          const normNew = e.newStr.split("\r\n").join("\n");
          const count = countOccurrences(normText, normOld);
          if (count === 0) return fail("no-match", e.path);
          if (count > 1) return fail("ambiguous", e.path);
          const replaced = normText.replace(normOld, () => normNew);
          const outText = replaced.split("\n").join("\r\n");
          const s = splitByBreak(outText, "\r\n");
          f.lines = s.lines;
          f.endsWithBreak = s.endsWithBreak;
        } else {
          const count = countOccurrences(text, e.oldStr);
          if (count === 0) return fail("no-match", e.path);
          if (count > 1) return fail("ambiguous", e.path);
          const replaced = text.replace(e.oldStr, () => e.newStr);
          const s = splitByBreak(replaced, "\n");
          f.lines = s.lines;
          f.endsWithBreak = s.endsWithBreak;
        }
        return succeed();
      }
      // insert
      if (e.insertLine < 0 || e.insertLine > f.lines.length) return fail("no-match", e.path);
      const insLines = splitPatch(e.newStr);
      f.lines = [...f.lines.slice(0, e.insertLine), ...insLines, ...f.lines.slice(e.insertLine)];
      return succeed();
    },
  };
}

// ---- Output and writing ----

function computeOutput(tree: Tree, moves: { old: string; new: string }[]): string[] {
  const out: { sortKey: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const m of moves) {
    const oldBefore = tree.get(m.old).existed;
    const oldAfter = tree.get(m.old).present;
    const newBefore = tree.get(m.new).existed;
    const newAfter = tree.get(m.new).present;
    if (oldBefore && !oldAfter && !newBefore && newAfter) {
      out.push({ sortKey: m.new, text: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const [p, st] of tree.all()) {
    if (covered.has(p)) continue;
    if (!st.existed && st.present) {
      out.push({ sortKey: p, text: `A ${p}` });
    } else if (st.existed && !st.present) {
      out.push({ sortKey: p, text: `D ${p}` });
    } else if (st.existed && st.present) {
      if (tree.textOf(st) !== st.origText) out.push({ sortKey: p, text: `M ${p}` });
    }
  }
  out.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, "utf8"), Buffer.from(b.sortKey, "utf8")));
  return out.map((l) => l.text);
}

function writeTree(tree: Tree): void {
  for (const [p, st] of tree.all()) {
    const abs = path.join(process.cwd(), p);
    if (st.present) {
      const text = tree.textOf(st);
      if (!st.existed || text !== st.origText) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text, "utf8");
      }
    } else if (st.existed) {
      try {
        fs.unlinkSync(abs);
      } catch {
        // Already gone.
      }
    }
  }
}


// Entry point, kept last so every declaration above is initialised first.
// When the grader runs this beside a trial environment, hand over to the
// kit's runner, which drives the checks. Otherwise run the CLI.
if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import("./runner.ts");
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
