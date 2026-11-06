/** Codex 0.165 may omit the MCP isError flag while retaining plain error text. */
export function isToolFailure(item: Record<string, any>): boolean {
  if (item.error || item.status === "failed") return true;
  const result = item.result;
  if (!result) return false;
  if (result.isError || result.is_error) return true;
  if (result.structured_content != null || result.structuredContent != null)
    return false;
  for (const block of result.content ?? []) {
    if (block.type !== "text") continue;
    try {
      const value = JSON.parse(block.text);
      if (value?.isError || value?.is_error || Array.isArray(value))
        return true;
    } catch {
      // This server returns JSON or images on success, plain text only on failure.
      return true;
    }
  }
  return false;
}
