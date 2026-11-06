#!/usr/bin/env node
// PUBLIC builder tool: static analysis of browser-delivered JavaScript in the packaged game.
// Operations: scripts | symbols | search | lines | refs. Output is JSON on stdout.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse, type Node } from "acorn";

interface Script {
  index: number;
  start_line: number;
  source: string;
}
export function inlineScripts(html: string): Script[] {
  const scripts: Script[] = [];
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const offset = match.index + match[0].indexOf(">") + 1;
    scripts.push({
      index: scripts.length,
      start_line: html.slice(0, offset).split("\n").length,
      source: match[1],
    });
  }
  return scripts;
}
type AnyNode = Node & Record<string, any>;
function children(node: AnyNode): AnyNode[] {
  const result: AnyNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc")
      continue;
    if (Array.isArray(value))
      for (const item of value)
        if (item && typeof item.type === "string") result.push(item);
    if (
      value &&
      typeof value === "object" &&
      typeof (value as AnyNode).type === "string"
    )
      result.push(value as AnyNode);
  }
  return result;
}
const isFunction = (node: AnyNode) =>
  [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ].includes(node.type);
function names(pattern: AnyNode): string[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "ObjectPattern")
    return pattern.properties.flatMap((p: AnyNode) =>
      names(p.value ?? p.argument),
    );
  if (pattern.type === "ArrayPattern")
    return pattern.elements.flatMap((p: AnyNode) => names(p));
  if (pattern.type === "AssignmentPattern") return names(pattern.left);
  if (pattern.type === "RestElement") return names(pattern.argument);
  return [];
}
export function symbols(script: Script, maxDepth = 1) {
  const ast = parse(script.source, {
    ecmaVersion: "latest",
    sourceType: "script",
    locations: true,
  }) as AnyNode;
  const rows: Record<string, unknown>[] = [];
  const line = (node: AnyNode) => script.start_line + node.loc!.start.line - 1;
  const visit = (node: AnyNode, depth: number, owner: string | null) => {
    if (node.type === "FunctionDeclaration" && depth <= maxDepth)
      rows.push({
        kind: "function",
        name: node.id?.name,
        params: node.params.flatMap(names),
        line: line(node),
        depth,
        owner,
      });
    if (node.type === "VariableDeclaration" && depth <= maxDepth)
      for (const declaration of node.declarations)
        for (const name of names(declaration.id))
          rows.push({
            kind: node.kind,
            name,
            line: line(declaration),
            depth,
            owner,
            init: declaration.init
              ? script.source.slice(
                  declaration.init.start,
                  Math.min(declaration.init.end, declaration.init.start + 80),
                )
              : null,
          });
    const nextDepth = isFunction(node) ? depth + 1 : depth;
    const nextOwner =
      node.type === "FunctionDeclaration" ? (node.id?.name ?? owner) : owner;
    for (const child of children(node)) visit(child, nextDepth, nextOwner);
  };
  visit(ast, 0, null);
  return rows;
}
export function refs(script: Script, name: string) {
  const ast = parse(script.source, {
    ecmaVersion: "latest",
    sourceType: "script",
    locations: true,
  }) as AnyNode;
  const rows: Record<string, unknown>[] = [];
  const visit = (node: AnyNode, owner: string | null) => {
    if (node.type === "Identifier" && node.name === name)
      rows.push({
        line: script.start_line + node.loc!.start.line - 1,
        column: node.loc!.start.column,
        in_function: owner,
      });
    const nextOwner =
      node.type === "FunctionDeclaration" ? (node.id?.name ?? owner) : owner;
    for (const child of children(node)) visit(child, nextOwner);
  };
  visit(ast, null);
  return rows;
}

function main(argv: string[]) {
  const [op, file, ...rest] = argv;
  if (!op || !file) {
    console.error(
      "usage: fn-inspect scripts|symbols|search|lines|refs FILE [...]\n  symbols FILE [maxDepth=1]\n  search FILE REGEX [context=1] [max=200]\n  lines FILE START END\n  refs FILE IDENTIFIER",
    );
    process.exit(2);
  }
  const html = readFileSync(file, "utf8");
  const scripts = inlineScripts(html);
  const all = html.split("\n");
  let result: unknown;
  if (op === "scripts")
    result = scripts.map((s) => ({
      index: s.index,
      start_line: s.start_line,
      lines: s.source.split("\n").length,
      bytes: Buffer.byteLength(s.source),
      sha256: createHash("sha256").update(s.source).digest("hex"),
    }));
  else if (op === "symbols")
    result = scripts.flatMap((s) =>
      symbols(s, Number(rest[0] ?? 1)).map((row) => ({
        script: s.index,
        ...row,
      })),
    );
  else if (op === "refs")
    result = scripts.flatMap((s) =>
      refs(s, rest[0]).map((row) => ({ script: s.index, ...row })),
    );
  else if (op === "search") {
    const pattern = new RegExp(rest[0]),
      context = Number(rest[1] ?? 1),
      max = Number(rest[2] ?? 200);
    const hits: Record<string, unknown>[] = [];
    all.forEach((text, index) => {
      if (hits.length < max && pattern.test(text))
        hits.push({
          line: index + 1,
          text: text.slice(0, 400),
          context: all
            .slice(Math.max(0, index - context), index + context + 1)
            .map((t) => t.slice(0, 400)),
        });
    });
    result = hits;
  } else if (op === "lines") {
    const start = Math.max(1, Number(rest[0])),
      end = Math.min(all.length, Number(rest[1] ?? start + 40), start + 400);
    result = all
      .slice(start - 1, end)
      .map((text, i) => ({ line: start + i, text }));
  } else {
    console.error(`unknown operation ${op}`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(result, null, 1) + "\n");
}
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("fn-inspect.js")
)
  main(process.argv.slice(2));
