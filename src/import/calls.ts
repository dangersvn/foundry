// Finds calls to AI-DLC's own engine in stage text. A call is the inline code
// span that contains an engine token, or, in a fenced block, the line that
// does (plus its backslash continuation lines). The importer rewrites each
// call through docs/aidlc-rewrites.md; whatever is still found afterwards
// fails the import.
export const ENGINE_TOKENS: RegExp[] = [
  /\{\{INVOKE\}\}/,
  /\{\{HARNESS_DIR\}\}/,
  /\baidlc-[a-z-]+\.ts\b/,
  /\baidlc engine\b/,
  /\baidlc-orchestrate\b/,
  /(^|\s)\/aidlc\b/,
  /^next(\s+--[a-z-]+.*)?$/, // the engine's `next` directive, as a whole inline span
];

export interface Call {
  start: number; // offset in the text
  end: number;
  text: string;
  line: number;
}

const isEngine = (s: string) => ENGINE_TOKENS.some((t) => t.test(s));

export function findCalls(text: string): Call[] {
  const calls: Call[] = [];
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  // Fenced blocks first; prose is what lies between them.
  const fence = /^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm;
  let last = 0;
  const prose: [number, number][] = [];
  for (const m of text.matchAll(fence)) {
    prose.push([last, m.index!]);
    const block = m[0];
    const bodyStart = m.index! + block.indexOf("\n") + 1;
    const lines = block.slice(block.indexOf("\n") + 1).split("\n");
    let off = bodyStart;
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i]!;
      const start = off;
      let end = off + l.length;
      let span = l;
      if (isEngine(l) && !/^```/.test(l)) {
        while (span.trimEnd().endsWith("\\") && i + 1 < lines.length) {
          i++;
          off = end + 1;
          l = lines[i]!;
          span += "\n" + l;
          end = off + l.length;
        }
        const lead = span.length - span.trimStart().length;
        calls.push({ start: start + lead, end, text: span.trim(), line: lineAt(start) });
      }
      off = end + 1;
    }
    last = m.index! + block.length;
  }
  prose.push([last, text.length]);
  for (const [a, b] of prose) {
    const part = text.slice(a, b);
    for (const m of part.matchAll(/(?<!`)`([^`]+)`(?!`)/g)) {
      if (isEngine(m[1]!.trim())) {
        const start = a + m.index! + 1;
        calls.push({ start, end: start + m[1]!.length, text: m[1]!, line: lineAt(start) });
      }
    }
    // An engine token in bare prose (outside any code) is a call too.
    const stripped = part.replace(/(?<!`)`[^`]+`(?!`)/g, (s) => " ".repeat(s.length));
    for (const t of [/\{\{INVOKE\}\}[^\n]*/g, /\{\{HARNESS_DIR\}\}[^\s)`'"]*/g]) {
      for (const m of stripped.matchAll(t)) calls.push({ start: a + m.index!, end: a + m.index! + m[0].length, text: m[0], line: lineAt(a + m.index!) });
    }
  }
  return calls.sort((x, y) => x.start - y.start);
}
