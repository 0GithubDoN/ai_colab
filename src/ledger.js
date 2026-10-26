// The team ledger: an append-only record of who did what (tasks, checks, reviews, files,
// decisions). It survives new chapters, so the lead can always look back without anyone
// keeping it in their context. One JSON object per line in .crewroom/ledger.jsonl.

import fs from 'node:fs';
import path from 'node:path';

const KEEP_IN_MEMORY = 5000;

export class Ledger {
  constructor(file) {
    this.file = file;
    this.entries = [];
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_IN_MEMORY);
      for (const l of lines) {
        try {
          this.entries.push(JSON.parse(l));
        } catch {}
      }
    } catch {}
  }

  /** entry: { who, type, text, task?, files? } */
  add(entry) {
    const e = { ts: Date.now(), ...entry };
    this.entries.push(e);
    if (this.entries.length > KEEP_IN_MEMORY) this.entries.splice(0, this.entries.length - KEEP_IN_MEMORY);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(e)}\n`);
    } catch {}
    return e;
  }

  /**
   * Newest last. `about` matches a member id, a task id or a file path (substring), so one
   * search box answers "what did Codex do", "what happened to T4" and "who changed app.js".
   */
  query({ about, ids = [], type, limit = 30, since } = {}) {
    const q = String(about || '').toLowerCase();
    const list = this.entries.filter((e) => {
      if (since && e.ts < since) return false;
      if (type && e.type !== type) return false;
      if (!q && !ids.length) return true;
      if (ids.includes(e.who)) return true;
      if (q && (String(e.task || '').toLowerCase() === q || (e.files || []).some((f) => f.toLowerCase().includes(q)) || e.text.toLowerCase().includes(q))) return true;
      return false;
    });
    return list.slice(-Math.min(Math.max(Number(limit) || 30, 1), 500));
  }
}
