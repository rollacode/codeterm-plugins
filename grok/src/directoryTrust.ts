import type { ParsedPrompt } from "@codeterm/plugin-sdk";

export function grokDirectoryTrustPrompt(screen: string): ParsedPrompt | null {
  const lines = screen.split(/\r?\n/).map(line => line.trim().replace(/^[│┃]\s*|\s*[│┃]$/g, ""));
  const index = lines.findIndex(line => line === "Do you trust the contents of this directory?");
  if (index < 0) return null;
  const tail = lines.slice(index + 1);
  const yes = tail.filter(line => /^(?:[>❯]\s*)?Yes, proceed\s+y$/.test(line));
  const no = tail.filter(line => /^(?:[>❯]\s*)?No, quit\s+n$/.test(line));
  if (yes.length !== 1 || no.length !== 1) return null;
  return { question: lines[index], options: [["Yes, proceed", "y"], ["No, quit", "n"]] };
}

export function grokTrustPromptResponse(index: number, screen: string): string[] {
  if (!grokDirectoryTrustPrompt(screen)) return [];
  return index === 0 ? ["eQ=="] : index === 1 ? ["bg=="] : [];
}
