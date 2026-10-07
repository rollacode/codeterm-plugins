export interface ContextFiles { edit: string[]; read: string[] }

/** Core resolves paths; validate the attachment contract without losing context. */
export function contextAttachments(value: unknown): ContextFiles {
  if (value === undefined || value === null) return { edit: [], read: [] };
  const fail = () => { throw new Error("Invalid Aider contextFiles. Supply absolute file paths in edit/read arrays with no overlap."); };
  if (typeof value !== "object" || Array.isArray(value)) return fail();
  const files = value as Record<string, unknown>;
  if (Object.keys(files).some(key => key !== "edit" && key !== "read")) return fail();
  const list = (items: unknown): string[] => {
    if (!Array.isArray(items)) return fail();
    if (items.some(path => typeof path !== "string" || !path.trim() || /[\0\r\n]/.test(path) ||
      !(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)))) return fail();
    return [...new Set(items as string[])];
  };
  const edit = list(files.edit);
  const read = list(files.read);
  if (edit.some(path => read.includes(path))) return fail();
  return { edit, read };
}
