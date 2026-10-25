// Compact text versions of room results. AIs read text as well as JSON, and
// this is a fraction of the tokens, which matters because they read it in a loop.

const indent = (s, pad = '      ') => String(s).replace(/\n/g, `\n${pad}`);

export function formatMessage(m) {
  const to = m.to === 'everyone' ? '' : ` -> ${m.to}`;
  const files = m.attachments?.length ? `\n      files: ${m.attachments.map((a) => `${a.id} ${a.name} (${a.mime})${a.project_path ? ` at ${a.project_path}` : ''}`).join('; ')}` : '';
  return `#${m.seq} ${m.time.slice(11, 16)} ${m.from}${to}${m.mentions_you ? ' [@you]' : ''}: ${indent(m.text)}${files}`;
}

export function formatTask(t, { full = true } = {}) {
  const head = `  ${t.id} [${t.kind}, ${t.status}${t.changed ? ', NEW/CHANGED' : ''}] from ${t.from}${t.assigned_to && t.assigned_to !== 'anyone' ? ` to ${t.assigned_to}` : ''}: ${t.title}`;
  if (!full) return head;
  return `${head}${t.details ? `\n      ${indent(t.details)}` : ''}${t.files ? `\n      files: ${t.files.join(', ')}` : ''}${t.result ? `\n      result: ${indent(t.result)}` : ''}`;
}

export function formatWait(r) {
  // Nothing happened: one short line (this is the common case, and it is read in a loop).
  if (r.quiet) return `nothing new${r.paused ? ' (room paused)' : ''}${r.other_task_ids?.length ? `; your open tasks: ${r.other_task_ids.join(', ')}` : ''}. next: ${r.guidance.replace(/^Nothing new\.\s*/, '')}`;
  const out = [`lead: ${r.lead?.name ? `${r.lead.name} (${r.lead.status})` : 'none'}${r.paused ? '  |  ROOM PAUSED' : ''}`];
  if (r.history?.length) out.push('--- earlier ---', ...r.history.map(formatMessage));
  out.push(r.new_messages.length ? `--- ${r.new_messages.length} new ---` : '--- nothing new ---', ...r.new_messages.map(formatMessage));
  if (r.other_messages) out.push(`(+${r.other_messages.count} other message(s) from ${r.other_messages.between.join(', ')} not addressed to you; read_messages if you need them)`);
  if (r.queued) out.push(`(${r.queued} more queued: call wait again now)`);
  if (r.your_tasks?.length) out.push('--- your new/changed tasks ---', ...r.your_tasks.map((t) => formatTask(t, { full: !t.brief })));
  if (r.other_task_ids?.length) out.push(`(your other open tasks: ${r.other_task_ids.join(', ')})`);
  if (r.open_tasks_anyone_can_take?.length) out.push('--- new open tasks anyone can take ---', ...r.open_tasks_anyone_can_take.map((t) => formatTask(t, { full: false })));
  else if (r.open_task_count) out.push(`(${r.open_task_count} open task(s) anyone can take: room_status lists them)`);
  out.push(`next: ${r.guidance}`);
  return out.join('\n');
}

/** Compact JSON for other results (no indentation, no empty fields). */
export function compactJson(obj) {
  return JSON.stringify(obj, (k, v) => (v === undefined || v === null || (Array.isArray(v) && v.length === 0 && k !== 'new_messages') ? undefined : v));
}
