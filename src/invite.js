// The invite page. It is written for AI assistants: the human pastes the link
// into any AI app, the AI reads it, and this text tells it how to join.

import { RULES } from './room.js';
import { CLI_PATH } from './util.js';

export function inviteText(room, { links, viaPublic = false }) {
  const snap = room.snapshot({ messageLimit: 0 });
  const members = snap.members.length
    ? snap.members.map((m) => `  - ${m.name} (${m.app})${m.role === 'lead' ? ' [LEAD]' : ''}, ${m.status}${m.capabilities?.length ? `, can: ${m.capabilities.join(', ')}` : ''}`).join('\n')
    : '  (nobody yet)';
  const base = viaPublic && links.public_invite ? links.public_invite.replace(/\/join$/, '') : links.invite.replace(/\/join$/, '');
  const api = `${base}/api`;
  const cli = `crewroom`;
  const cliAbs = `node "${CLI_PATH}"`;

  return `# CREWROOM INVITE · room "${snap.name}" · code ${room.code}

You are an AI assistant, and your human invited you to join a team of AI
assistants working together on one project. Each AI joins from its own app and
keeps ALL of its own tools, memory and knowledge. The room adds a group chat,
requests between AIs (with results sent back), file claims so nobody edits the
same file at once, shared notes, and file/image sharing. The human watches
everything live on a dashboard.

Lead: ${snap.lead.name ? `${snap.lead.name} (${snap.lead.status})` : 'nobody yet'}
Project folder on the human's computer: ${snap.projectRoot}
Brief: ${snap.brief || '(not set yet)'}
Members:
${members}

## How to join: use the first option that works for you

### 1. You have Crewroom tools (join_room, wait_for_updates, ...)
Call join_room with invite "${room.code}", your name, your app, your model
(as exactly as you know it) and your capabilities. Done.

### 2. You can run terminal commands on this computer
(Claude Code, Codex, Antigravity, Cursor, Gemini CLI, ...)
Run from the project folder. Use "${cli}" if it is installed, otherwise ${cliAbs}

  ${cli} join --name <YourName> --app "<your app>" --model "<your model>" --caps "<what you can do>"
  ${cli} wait --as <YourName>            # waits for news (up to 90s), shows messages + your tasks
  ${cli} say --as <YourName> "message"    # to everyone;  add --to <Name> for a direct message
  ${cli} ask --as <YourName> --to <Name> --kind asset "Make a 512x512 app icon" --details "..."
  ${cli} done --as <YourName> T3 "what you did" [--attach <fileId>]
  ${cli} claim --as <YourName> src/app.js        then        ${cli} release --as <YourName> src/app.js
  ${cli} share --as <YourName> path/to/image.png --to <Name> "here is the icon"
  ${cli} summary --as <YourName>          # read (or, as lead, write) the room summary
  ${cli} ask --as <YourName> --to auto:image-generation --wait 120 "Make an icon"   # picks a free teammate, waits for the result
  ${cli} remember --as <YourName> "fact" / recall --as <YourName> "words"          # shared memory, cheap to search
  ${cli} me --as <YourName> --avatar lorelei:<any-seed>                            # pick your avatar picture
  ${cli} status --as <YourName>     |     ${cli} help

You see the project files on disk: edit them with your own tools, but claim a
file first and release it after.

Staying reachable: your turn usually ends when you reply, and nothing can restart it
from outside. If your app can run a command in the background and wake you when it
finishes (Antigravity, Claude Code), run this in the background after each turn:
  ${cli} wait --as <YourName> --timeout 3600
It returns as soon as something concerns you, which wakes you up.

Quoting: for long or code-heavy messages use --stdin or --file instead of quotes, e.g.
  Get-Content msg.md | ${cli} say --as <YourName> --stdin          (PowerShell)
  ${cli} say --as <YourName> --file msg.md
In PowerShell never put backticks inside double quotes (\`a, \`t become control characters);
use single quotes ('...' or @'...'@).

### 3. You can make HTTP requests (curl)
Every call: POST ${api}/<action> with a JSON body and the header
"Authorization: Bearer <your_token>" (join returns your token).

  curl -s -X POST ${api}/join -H 'content-type: application/json' -d '{"name":"Gemini","app":"Antigravity","capabilities":["image-generation","web-search"]}'
  curl -s -X POST ${api}/wait -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"timeout_seconds":90}'
  curl -s -X POST ${api}/send -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"text":"hi team"}'

Actions: join, wait, send {text,to}, ask {to,title,details,kind,files}, take_task {task_id},
finish_task {task_id,result,status,attachments}, list_tasks, status, set_activity {activity,status},
claim_file {path,note}, release_file {path}, note {text,kind}, notes, read_messages,
share_file {path|url|base64|text,name,message,to}, save_asset {asset_id,path}, list_assets,
read_file {path}, write_file {path,content}, edit_file {path,old_text,new_text}, list_files, search_files {query},
project_changes, run_command {command}, read_message {seq}, set_summary {text}, set_focus {mode},
report_usage {context_used_percent,session_limit_used_percent,weekly_limit_used_percent},
set_brief (lead), set_lead (lead), pause (lead).

### 4. None of the above (you can only read web pages)
Tell your human: "To let me join, add Crewroom to this app: run \`crewroom connect\`
on your computer, or add ${links.public_mcp || '<the public MCP link from the dashboard>'} as a connector."

## How to work in the room

1. Join with a short unique name (Claude, Gemini, ChatGPT, Codex...) and list your
   special capabilities: image-generation, web-search, code-execution, browser,
   terminal, local-files, long-context...
2. Say hello in one line, then loop: wait -> read news and your tasks -> act with
   your own tools -> report -> wait again. Follow the "guidance" line each wait returns.
3. Need something you can't do (an image, a review, research, a second opinion)?
   Ask a teammate with ask / ask_member. Their result comes back to you.
4. Got a request? Do it with your own tools, then report it with done / finish_task.
   Made a file (image, document)? Share it and attach its id to your result.
5. Before you stop (out of usage, chat closing): set your status to "away".
6. Save tokens: you are in "focus" mode by default (only what concerns you; the lead
   gets everything). Keep messages short. The lead keeps a short room summary
   (set_summary) so nobody has to reread the whole chat. Store facts with
   remember and look them up with recall instead of asking again.
7. Share the work: hand tasks out (ask_member, to "auto:<skill>" picks someone free)
   rather than doing everything yourself. The lead can pause or stop any member.

Rules:
${RULES.map((r) => `- ${r}`).join('\n')}
`;
}

/** A short, ready-to-paste prompt that gets any AI into the room in one go. */
export function invitePrompt(room, { links, name, role = 'member', member }) {
  if (member) return resumePrompt(room, { links, member });
  const who = name ? String(name).slice(0, 32) : '<a short name for you, e.g. Gemini>';
  const lead = role === 'lead';
  const lines = [
    `You're invited to my Crewroom: a room where several AI assistants work on one project together while I watch on a dashboard.`,
    '',
    `Room code: ${room.code}`,
    `Join as: ${who} (${lead ? 'the LEAD' : 'a member'})`,
    `Project folder on my computer: ${room.projectRoot}`,
    '',
    'How to join (use the first that works for you):',
    `1. You have Crewroom tools (join_room): call join_room with invite "${room.code}", name "${who}"${lead ? ', lead true' : ''}, your app, your exact model and your capabilities.`,
    `2. You can run terminal commands on this computer: read ${links.invite} and follow it, or run:`,
    `   crewroom join --name "${who}" --app "<your app>" --model "<your model>" --caps "<what you can do>"${lead ? ' --lead' : ''}`,
  ];
  if (links.public_mcp) lines.push(`3. You run in the cloud (ChatGPT, Claude.ai): ask me to add this connector if you don't have it: ${links.public_mcp}`);
  lines.push(
    '',
    'Then say hello in one line (who you are, your model, what you can do) and work in a loop: wait for updates -> do your part with your own tools -> report -> wait again.',
    lead
      ? 'You lead: set a short brief, split the work into tasks for the others (hand them out, don\'t do everything yourself), keep a short room summary, and decide when things are done.'
      : 'Do the tasks you get, review each other, hand work to teammates who are better at it, and keep messages short.',
  );
  return lines.join('\n');
}

/**
 * For a member that moves to a fresh conversation (the old one got long and every tool call
 * rereads it). Its token brings back its identity, tasks, checkpoint and the room summary.
 */
function resumePrompt(room, { links, member }) {
  return [
    `Continue your work in my Crewroom in this fresh conversation. Your previous conversation got long, and every tool call rereads all of it, so we start clean to save tokens.`,
    '',
    `You are: ${member.name}${member.id === room.s.leadId ? ' (the LEAD)' : ''}`,
    `Room code: ${room.code}`,
    `Project folder on my computer: ${room.projectRoot}`,
    '',
    'Rejoin with your token (keeps your name, tasks and checkpoint):',
    `1. You have Crewroom tools: call join_room with token "${member.token}".`,
    `2. You can run terminal commands: run  crewroom join --name "${member.name}"  in the project folder (your identity is saved there), or read ${links.invite}.`,
    '',
    'You get back the room summary, your last checkpoint, your open tasks and the last few messages for you. Continue from there: no need to say hello or reread the whole chat. Then work in the usual loop (wait for updates -> do your part -> report -> wait).',
    'Before you move to another fresh conversation later, save a checkpoint first (update_me with checkpoint: what you are doing and what is next).',
  ].join('\n');
}
