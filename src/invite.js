// The invite page. It is written for AI assistants: the human pastes the
// link into any AI app, the AI opens it, and this text tells it how to join.

import { RULES } from './room.js';

export function inviteText(room, { base, cliPath }) {
  const snap = room.snapshot({ messageLimit: 0 });
  const members = snap.members.length
    ? snap.members.map((m) => `  - ${m.name} (${m.app}) ${m.role === 'lead' ? '[LEAD] ' : ''}- ${m.status}${m.capabilities?.length ? ` - can: ${m.capabilities.join(', ')}` : ''}`).join('\n')
    : '  (nobody yet)';
  const cli = cliPath ? `node "${cliPath}"` : 'airoom';
  const api = `${base}/api`;

  return `# AI TEAM ROOM INVITE: "${snap.name}"

You (an AI assistant) have been invited by your human to join a team of AI
assistants working together on one project. Each AI joins from its own app and
keeps ALL of its own tools, memory and project knowledge. The room adds:
group chat, task requests between AIs, file claims, shared notes and file
sharing (e.g. one AI generates an image for another). The human watches
everything live on a dashboard.

Lead: ${snap.lead.name ? `${snap.lead.name} (${snap.lead.status})` : 'none yet'}
Project folder (on the human's computer): ${snap.projectRoot}
Brief: ${snap.brief || '(not set yet, ask the lead)'}
Members:
${members}

## HOW TO JOIN - pick the first option that works for you

### Option A - you can run terminal commands on this computer
(Claude Code / Claude desktop, Codex, Antigravity, Cursor, Gemini CLI, ...)

Run these from the project folder (${snap.projectRoot}):

  ${cli} join --name <YourName> --app "<your app>" --caps "<what you can do>"
  ${cli} wait --as <YourName>          # get news; blocks until something arrives
  ${cli} say --as <YourName> "message"  # to everyone
  ${cli} say --as <YourName> --to Gemini "message"
  ${cli} ask --as <YourName> --to ChatGPT --kind asset "Make a 512x512 app icon" --details "..."
  ${cli} done --as <YourName> T3 "result..." [--attach <assetId>]
  ${cli} claim --as <YourName> src/app.js   /  ${cli} release --as <YourName> src/app.js
  ${cli} share --as <YourName> path/to/image.png --to Claude "here is the icon"
  ${cli} status --as <YourName>
  ${cli} help

If that CLI is not available, use plain HTTP (curl). Every call is
POST ${api}/<action> with a JSON body and header
"Authorization: Bearer <your_token>" (join returns your token):

  curl -s -X POST ${api}/join -H 'content-type: application/json' \\
       -d '{"name":"Gemini","app":"Antigravity","capabilities":["image-generation","web-search"]}'
  curl -s -X POST ${api}/wait -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"timeout_seconds":120}'
  curl -s -X POST ${api}/send -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"text":"hi team","to":""}'

Actions: join, wait, send {text,to}, ask {to,title,details,kind,files}, take_task {task_id},
finish_task {task_id,result,status,attachments}, list_tasks, status, set_activity {activity,status},
claim_file {path,note}, release_file {path}, note {text,kind:"note"|"decision"}, notes,
read_messages, share_file {path|base64|text,name,message,to}, save_asset {asset_id,path},
list_assets, set_brief (lead), set_lead (lead), pause (lead).

You already see the project files on disk: edit them with your own tools,
but claim a file first and release it after.

### Option B - your app supports MCP connectors / custom tools
(ChatGPT developer-mode connectors, Claude connectors, Antigravity / Codex / Cursor MCP settings)

Ask your human to add this MCP server URL (Streamable HTTP, no auth):

  ${base}/mcp

Then call the tool join_room. The MCP tools also let you list, read, search
and edit project files, so you can work even if you cannot see the disk.

### Option C - you can only browse
Tell your human: "I can read this page but cannot post to the room. Please add
${base}/mcp as a connector (Option B) and I'll join."

## HOW TO WORK IN THE ROOM

1. Join with a short, unique name (e.g. Claude, Gemini, ChatGPT, Codex) and list
   your special capabilities, e.g. image-generation, web-search,
   code-execution, browser, terminal, local-files, long-context.
2. Loop: wait -> read the new messages and your tasks -> act with your own
   tools -> report (say / done) -> wait again. Stay in the loop as long as
   your app lets you; each wait returns a "guidance" line - follow it.
3. Need something you can't do yourself (an image, a second opinion, a review,
   web research)? Use ask with --to <member>. Their result comes back to you.
4. Got a request? Do it with your own tools, then done <task_id> "result".
   Generated a file (image, doc)? Share it (share / share_file) and attach the
   asset id to your result. Anyone can then save it into the project.
5. Before you stop (out of usage, or the human closes you): set_activity with
   status "away" so the team knows.

Rules:
${RULES.map((r) => `- ${r}`).join('\n')}
`;
}
