// What changed during a task. When a task is taken, its files are copied aside; when it is
// finished, they are diffed, and other files modified during the task are listed (and diffed
// against git when the project is a repository). The lead reviews exactly what changed.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTwoFilesPatch } from 'diff';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.crewroom', 'dist', 'build', '.next', 'out', 'coverage', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode']);
const MAX_FILE = 1_000_000;
const MAX_DIFF = 200_000;

const snapDir = (dataDir, taskId) => path.join(dataDir, 'snapshots', taskId);

export function snapshotTask(projectRoot, dataDir, task) {
  const dir = snapDir(dataDir, task.id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const rel of task.files || []) {
    const abs = path.join(projectRoot, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      const dest = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    } catch {}
  }
}

function modifiedSince(projectRoot, since, limit = 4000) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 12 || out.length >= 200) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (--limit <= 0) return;
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) {
        if (!SKIP_DIRS.has(it.name) && !it.name.startsWith('.')) walk(abs, depth + 1);
      } else if (it.isFile()) {
        try {
          if (fs.statSync(abs).mtimeMs > since) out.push(path.relative(projectRoot, abs).split(path.sep).join('/'));
        } catch {}
      }
    }
  };
  walk(projectRoot, 0);
  return out;
}

function gitHead(projectRoot, rel) {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_FILE * 2 }).toString('utf8');
  } catch {
    return null;
  }
}

const read = (abs) => {
  try {
    const st = fs.statSync(abs);
    return st.size > MAX_FILE ? null : fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
};

const isBinary = (s) => s && s.slice(0, 8000).includes('\u0000');

/**
 * Returns { changes: [{ file, added, removed, note? }], diff } and saves the diff text.
 * Files outside the task's own list are "also changed during the task" (maybe by someone else).
 */
export function diffTask(projectRoot, dataDir, task) {
  const dir = snapDir(dataDir, task.id);
  const own = new Set(task.files || []);
  const others = task.startedAt ? modifiedSince(projectRoot, task.startedAt).filter((f) => !own.has(f)) : [];
  const changes = [];
  let diff = '';
  for (const rel of [...own, ...others]) {
    const snap = path.join(dir, rel);
    const before = own.has(rel) ? (fs.existsSync(snap) ? fs.readFileSync(snap, 'utf8') : '') : gitHead(projectRoot, rel);
    const after = read(path.join(projectRoot, rel));
    if (after === null) {
      changes.push({ file: rel, note: 'too large to diff' });
      continue;
    }
    if (before === null) {
      changes.push({ file: rel, note: own.has(rel) ? 'unchanged' : 'changed during the task (no earlier copy to compare)' });
      continue;
    }
    if (before === after) continue;
    if (isBinary(before) || isBinary(after)) {
      changes.push({ file: rel, note: 'binary file changed' });
      continue;
    }
    const patch = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, '', '', { context: 3 }).replace(/^=+\n/, '');
    const lines = patch.split('\n');
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    changes.push({ file: rel, added, removed, ...(own.has(rel) ? {} : { note: 'not in the task\'s files (maybe changed by someone else)' }) });
    if (diff.length < MAX_DIFF) diff += `${patch}\n`;
  }
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… (diff cut at ${MAX_DIFF} characters)`;
  try {
    fs.mkdirSync(path.join(dataDir, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'snapshots', `${task.id}.diff`), diff);
  } catch {}
  return { changes, diff };
}

export function savedDiff(dataDir, taskId) {
  try {
    return fs.readFileSync(path.join(dataDir, 'snapshots', `${taskId}.diff`), 'utf8');
  } catch {
    return null;
  }
}
