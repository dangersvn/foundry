// Reads the rewrite table in docs/aidlc-rewrites.md and applies it to a text.
import fs from "node:fs";
import { findCalls } from "./calls.js";

export interface Rule {
  id: string;
  pattern: RegExp;
  replacement: string;
}

export interface Applied {
  rule: string;
  line: number;
  from: string;
  to: string;
}

const unquote = (cell: string) => cell.trim().replace(/^`(.*)`$/s, "$1").replaceAll("\\|", "|");

export function parseRules(file: string): Rule[] {
  const text = fs.readFileSync(file, "utf8");
  const section = text.split(/^## Rules\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const rules: Rule[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("|") || /^\|\s*(Rule|---)/.test(line)) continue;
    const cells = line.slice(1, -1).split(/(?<!\\)\|/).map(unquote);
    if (cells.length < 3) continue;
    rules.push({ id: cells[0]!, pattern: new RegExp(`^(?:${cells[1]})$`, "s"), replacement: cells[2]! });
  }
  return rules;
}

const normalize = (call: string) => call.replace(/\\\n\s*/g, " ").replace(/\s+/g, " ").trim();

export class UnmatchedCall extends Error {
  constructor(
    readonly where: string,
    readonly call: string,
    readonly line: number,
  ) {
    super(`${where} line ${line}: no rewrite rule matches the engine call \`${call}\``);
  }
}

// Replaces every engine call in `text`. Throws UnmatchedCall for the first
// call the table does not cover.
export function rewrite(text: string, rules: Rule[], where: string): { text: string; applied: Applied[] } {
  const calls = findCalls(text);
  const applied: Applied[] = [];
  let out = "";
  let at = 0;
  for (const c of calls) {
    const call = normalize(c.text);
    const rule = rules.find((r) => r.pattern.test(call));
    if (!rule) throw new UnmatchedCall(where, call, c.line);
    const to = call.replace(rule.pattern, rule.replacement);
    applied.push({ rule: rule.id, line: c.line, from: call, to });
    out += text.slice(at, c.start) + to;
    at = c.end;
  }
  return { text: out + text.slice(at), applied };
}
