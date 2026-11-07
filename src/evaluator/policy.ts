// PRIVATE: interface policy for agent-built MCPs (static at smoke/acceptance, dynamic at play).
// A generic screen/mouse/keyboard driver is the GUI condition, not an application MCP.
// Generic code execution is out of contract. Free-form tools require owner review.
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Manifest } from "./freeze.js";

const guiPrimitive =
  /^(get_?)?(screenshot|screen|screen_?shot|screen_?capture|capture_?screen|capture)$|^(left_?|right_?|double_?|middle_?)?click$|^(mouse|mouse_?move|move_?mouse|mouse_?down|mouse_?up|drag|mouse_?drag|drag_?mouse|pointer|tap)$|^(type|type_?text|key|keys|key_?press|press_?key|hotkey|scroll|wheel)$|^(computer|desktop|gui|browser|cdp|devtools)$/i;
const executor =
  /^(exec|shell|bash|sh|run|run_?command|command|eval|evaluate|execute|run_?js|javascript|js|python|script|run_?script|inject|inject_?script)$/i;
const codeArgument =
  /^(code|script|source|source_?code|expression|expr|javascript|js|eval|function_?body|command|cmd|shell|program)$/i;
const codeDescription =
  /\b(arbitrary|any|custom)\s+(javascript|js|code|scripts?|commands?|expressions?)\b|\beval(uate)?\s*\(|\bexecut(e|es|ed|ing)\s+(javascript|js|code|scripts?|shell|commands?)\b|\brun\s+(javascript|js|code|scripts?)\b/i;

export interface PolicyResult {
  ok: boolean;
  reasons: string[];
  tools: string[];
}
function argumentNames(schema: unknown, prefix = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const value = schema as Record<string, any>;
  const result: string[] = [];
  for (const [name, child] of Object.entries(value.properties ?? {})) {
    result.push(prefix + name);
    result.push(...argumentNames(child, `${prefix}${name}.`));
  }
  if (value.items) result.push(...argumentNames(value.items, prefix));
  for (const key of ["anyOf", "oneOf", "allOf"])
    for (const item of value[key] ?? [])
      result.push(...argumentNames(item, prefix));
  return result;
}
export function interfacePolicy(
  tools: Tool[],
  manifest: Manifest,
): PolicyResult {
  const reasons: string[] = [];
  const names = tools.map((tool) => tool.name);
  for (const tool of tools) {
    if (guiPrimitive.test(tool.name))
      reasons.push(`gui_primitive:${tool.name}`);
    if (executor.test(tool.name)) reasons.push(`code_execution:${tool.name}`);
    for (const name of argumentNames(tool.inputSchema)) {
      const leaf = name.split(".").at(-1)!;
      if (codeArgument.test(leaf))
        reasons.push(`code_argument:${tool.name}.${name}`);
    }
    if (codeDescription.test(tool.description ?? ""))
      reasons.push(`code_description:${tool.name}`);
  }
  const declared = new Set(manifest.tools.map((t) => t.name));
  if (declared.size !== names.length || names.some((n) => !declared.has(n)))
    reasons.push("manifest_tools_mismatch");
  for (const tool of manifest.tools)
    if (tool.free_form || tool.requires_review)
      reasons.push(`review_required:${tool.name}`);
  if (!tools.length) reasons.push("no_tools");
  return { ok: reasons.length === 0, reasons, tools: names };
}

/** Dynamic check of a tool result at play time: MCP mode never relays pixels to the actor. */
export function resultViolations(result: CallToolResult): string[] {
  const violations: string[] = [];
  for (const block of (result.content ?? []) as {
    type: string;
    mimeType?: string;
    text?: string;
  }[]) {
    if (block.type === "image" || block.type === "audio")
      violations.push(`${block.type}_content`);
    if (block.type === "resource" || block.type === "resource_link")
      violations.push("resource_content");
    if (block.type === "text" && /data:image\//i.test(block.text ?? ""))
      violations.push("image_data_url");
  }
  return violations;
}
