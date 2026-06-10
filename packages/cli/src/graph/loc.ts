import type { Loc } from "../types.js";

type SpanNode = {
  span?: { start: number; end: number };
  start?: number;
  end?: number;
};

function nodeOffset(node: SpanNode, end = false): number {
  if (end) return node.span?.end ?? node.end ?? 0;
  return node.span?.start ?? node.start ?? 0;
}

export function locFromSpan(node: SpanNode, lines: string[], end = false): Loc {
  const offset = nodeOffset(node, end);
  let line = 1;
  let col = 1;
  let pos = 0;
  for (const l of lines) {
    const len = l.length + 1;
    if (pos + len > offset) {
      col = offset - pos + 1;
      break;
    }
    pos += len;
    line++;
  }
  const result: Loc = { line, column: col };
  if (end) {
    result.endLine = line;
    result.endColumn = col;
  }
  return result;
}

export function locFromOffset(offset: number, lines: string[]): Loc {
  return locFromSpan({ start: offset }, lines);
}
