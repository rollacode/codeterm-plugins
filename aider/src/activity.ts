/** Aider's own fixed activity markers in a provider-attributed screen. */
export function hasAiderActivity(screen: string): boolean {
  const lines = String(screen || "").split(/\r?\n/).map(line => line.trim());
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]) last--;
  if (last < 0 || /^(?:[a-z]+)?>$/.test(lines[last])) return false;
  const tail = lines[last];
  // waiting.py renders the block scan frame before its fixed status label.
  if (/^[░█ #=]+Waiting for \S/.test(tail)) return true;
  if (/^(?:[░█ #=]+)?Updating repo map(?:\b|$)/.test(tail)) return true;
  // A submitted input prompt with subsequent output is a turn in progress.
  // A prompt with only typed input has no response evidence yet.
  for (let i = last; i >= 0; i--) {
    if (/^(?:[a-z]+)?>$/.test(lines[i])) return false;
    if (/^(?:[a-z]+)?>\s+\S/.test(lines[i])) return i < last;
  }
  return false;
}
