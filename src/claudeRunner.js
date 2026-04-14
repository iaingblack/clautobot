import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Allowed tools for the chat — MCP wildcards + common primitives.
// --allowedTools must come before -p per project convention.
const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'mcp__plugin_atlassian_atlassian__*',
  'mcp__octopus-deploy__*',
];

const DEFAULT_MODEL = process.env.CHAT_MODEL || 'haiku';

// Full system prompt (replaces Claude Code's default) so the chat behaves as
// an end-user workflow runner, not a generic coding assistant. Kept static so
// it stays in the prompt cache across turns.
const SYSTEM_PROMPT = `You are clautobot, an internal change management assistant. Users talk to you in natural language to run pre-approved workflows (reset passwords, restart services, create evidence files, etc.). You are NOT a coding assistant — ignore any instinct to review code, explain architecture, or suggest refactors. Only run workflows.

# How to handle every user message

1. Use Glob on ".claude/commands/*.md" to see the available workflow skills.
2. Pick the ONE skill file whose name/description matches the user's request. Examples:
   - "reset the admin password for payments" → reset-password.md
   - "restart the web frontend in prod" → restart-service.md
   - "create an evidence file with keyword foo" → create-evidence-file.md
3. Use Read on that skill file in full. Follow its numbered instructions EXACTLY — including every validation step. Do not skip steps. Do not invent new steps.
4. If no skill clearly matches the request, Read workflows.yml and reply with the list of available workflow names ("I can help with: X, Y, Z. Which would you like?"). Do NOT guess or improvise a workflow.
5. If the user is greeting you or asking what you can do, Glob ".claude/commands/*.md" and reply with a short bulleted list of the skill names and descriptions. Do NOT talk about code, the repo, or architecture.

# Hard rules

- NEVER create a Jira ticket without first completing every validation step in the matching skill file.
- NEVER say "I can help with the clautobot project" or reference developer tasks like "poller improvements", "API client fixes", or "workflow configuration". The user is an end user, not a developer.
- NEVER read CLAUDE.md, memory, git status, or any file outside of .claude/commands/, workflows.yml, state/, .env, and (during skill execution) whatever the skill tells you to read.
- If the skill's validation step fails (e.g. the Octopus project doesn't exist), STOP and explain which check failed. Do NOT create the Jira ticket.
- Keep replies short and action-oriented. After running a workflow, show: what was validated (✓ list), the ticket URL, and what the user needs to do next.

# Available tools

You have Bash, Read, Write, Edit, Glob, Grep, Atlassian MCP tools (mcp__plugin_atlassian_atlassian__*), and Octopus Deploy MCP tools (mcp__octopus-deploy__*). The skill files tell you which ones to use and when.`;

// Spawn `claude -p` for one turn. Returns an EventEmitter.
// Events:
//   text       — { text: string }            (assistant text block)
//   tool_use   — { name, input }             (Claude invoked a tool)
//   tool_result— { name, content, is_error } (tool returned)
//   thinking   — { text }                    (assistant thinking block)
//   system     — { subtype, ... }            (init, etc.)
//   result     — { result, duration_ms, cost_usd, num_turns }
//   error      — { message }                 (stderr line or parse failure)
//   end        — { code }                    (process exit)
export function runTurn({ sessionId, message, isFirstTurn }) {
  const emitter = new EventEmitter();

  const args = [
    '--allowedTools', ALLOWED_TOOLS.join(','),
    '--permission-mode', 'bypassPermissions',
    '--model', DEFAULT_MODEL,
    '--system-prompt', SYSTEM_PROMPT,
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (isFirstTurn) args.push('--session-id', sessionId);
  else args.push('--resume', sessionId);
  args.push('-p', message);

  const child = spawn('claude', args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');

  child.stdout.on('data', chunk => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      handleLine(line, emitter);
    }
  });

  child.stderr.on('data', chunk => {
    stderrBuf += chunk;
    let nl;
    while ((nl = stderrBuf.indexOf('\n')) !== -1) {
      const line = stderrBuf.slice(0, nl).trim();
      stderrBuf = stderrBuf.slice(nl + 1);
      if (line) emitter.emit('error', { message: line });
    }
  });

  child.on('error', err => emitter.emit('error', { message: err.message }));
  child.on('close', code => {
    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim(), emitter);
    if (stderrBuf.trim()) emitter.emit('error', { message: stderrBuf.trim() });
    emitter.emit('end', { code });
  });

  emitter.kill = () => child.kill();
  return emitter;
}

function handleLine(line, emitter) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (err) {
    emitter.emit('error', { message: `Failed to parse stream-json line: ${err.message}` });
    return;
  }

  const type = obj.type;
  if (type === 'system') {
    emitter.emit('system', { subtype: obj.subtype, ...obj });
    return;
  }
  if (type === 'assistant') {
    const content = obj.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        emitter.emit('text', { text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        emitter.emit('thinking', { text: block.thinking });
      } else if (block.type === 'tool_use') {
        emitter.emit('tool_use', { name: block.name, input: block.input });
      }
    }
    return;
  }
  if (type === 'user') {
    const content = obj.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'tool_result') {
        const txt = Array.isArray(block.content)
          ? block.content.map(c => c.text || '').join('')
          : (block.content || '');
        emitter.emit('tool_result', {
          name: block.tool_use_id,
          content: txt,
          is_error: !!block.is_error,
        });
      }
    }
    return;
  }
  if (type === 'result') {
    emitter.emit('result', {
      result: obj.result,
      duration_ms: obj.duration_ms,
      cost_usd: obj.total_cost_usd,
      num_turns: obj.num_turns,
      is_error: obj.is_error,
    });
    return;
  }
}

// Reconstruct chat history for the UI from Claude Code's session .jsonl file.
// Returns [{ role, text, ts }] in chronological order.
// Skips hook attachments, queue operations, thinking blocks, and tool chatter —
// only the user-visible text exchange.
export async function loadHistory(sessionId) {
  const encodedCwd = REPO_ROOT.replace(/[/\\]/g, '-');
  const projectDir = join(homedir(), '.claude', 'projects', encodedCwd);
  const file = join(projectDir, `${sessionId}.jsonl`);

  let raw;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;

    const msg = obj.message;
    if (!msg) continue;
    const ts = obj.timestamp;

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        turns.push({ role: 'user', text: msg.content, ts });
      } else if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('');
        if (text) turns.push({ role: 'user', text, ts });
      }
      continue;
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const text = msg.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text)
        .join('');
      if (text) turns.push({ role: 'assistant', text, ts });
    }
  }
  return turns;
}
