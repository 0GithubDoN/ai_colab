// Running shell commands for room members (only after the human allows it)
// and reading git changes so remote members can review work.

import { spawn, execFile } from 'node:child_process';

const MAX_OUTPUT = 60_000;

export function runShell(command, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: process.env.CI || '1' } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (buf, chunk) => (buf.length > MAX_OUTPUT ? buf : (buf + chunk).slice(0, MAX_OUTPUT + 1));
    child.stdout.on('data', (c) => { stdout = cap(stdout, c.toString()); });
    child.stderr.on('data', (c) => { stderr = cap(stderr, c.toString()); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (exitCode, error) => {
      clearTimeout(timer);
      const trim = (s) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n...[output truncated]` : s);
      resolve({ exitCode, stdout: trim(stdout), stderr: trim(error ? `${stderr}${error}` : stderr), timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (err) => finish(-1, err.message));
    child.on('close', (code) => finish(code));
  });
}

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }));
  });
}

export async function gitChanges(cwd, file) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inside.ok) return { git: false, note: 'This project is not a git repository, so there is no change history. Use read_file to look at files.' };
  const status = await git(['status', '--porcelain=v1', '--branch'], cwd);
  const stat = await git(['diff', 'HEAD', '--stat', ...(file ? ['--', file] : [])], cwd);
  const diff = await git(['diff', 'HEAD', ...(file ? ['--', file] : [])], cwd);
  const log = await git(['log', '--oneline', '-n', '10'], cwd);
  let patch = diff.stdout;
  const truncated = patch.length > MAX_OUTPUT;
  if (truncated) patch = `${patch.slice(0, MAX_OUTPUT)}\n...[diff truncated, ask for a single file]`;
  return {
    git: true,
    status: status.stdout.trim(),
    summary: stat.stdout.trim() || 'No changes to tracked files since the last commit.',
    diff: patch,
    truncated,
    recent_commits: log.stdout.trim(),
  };
}
