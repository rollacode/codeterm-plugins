// host.exec retains only 128 KiB of stdout. Keep read-only JSON responses in
// private plugin storage instead, and remove them after consuming the full file.
type Result = { ok: true; stdout: string; stderr: string } | { ok: false; error: string; stdout: string; stderr: string; code?: number };
type Run = (bin: string, args: string[], env: Record<string, string>, timeoutMs: number) => Result;

const WINDOWS_READ = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  '$readArgs = @(ConvertFrom-Json $env:CT_EXO_ARGS)',
  '$readOutput = & $env:CT_EXO_BIN @readArgs',
  '$readCode = $LASTEXITCODE',
  '[IO.File]::WriteAllText($env:CT_EXO_OUTPUT, ($readOutput -join "`n"), [Text.UTF8Encoding]::new($false))',
  'exit $readCode',
].join('; ');

export function readOutput(
  binary: string, args: string[], env: Record<string, string>, root: string,
  powershell: string | null, timeoutMs: number, run: Run,
): Result {
  const file = host.path.normalize(`${root}/read-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const native = host.path.toNative(file);
  const readEnv = { ...env, CT_EXO_BIN: binary, CT_EXO_OUTPUT: native, CT_EXO_ARGS: JSON.stringify(args) };
  try {
    const result = powershell
      ? run(powershell, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_READ], readEnv, timeoutMs)
      : run('/bin/sh', ['-c', 'umask 077; exec "$CT_EXO_BIN" "$@" > "$CT_EXO_OUTPUT"', 'teams-read', ...args], readEnv, timeoutMs);
    if (!result.ok) return result;
    const stdout = host.fs.readFile(file);
    if (stdout === null) return { ok: false, error: 'Could not read the complete Teams response from private storage.', stdout: '', stderr: result.stderr };
    return { ok: true, stdout, stderr: result.stderr };
  } catch {
    return { ok: false, error: 'Could not capture the complete Teams response in private storage.', stdout: '', stderr: '' };
  } finally {
    try { host.fs.removeFile(file); } catch { }
  }
}
