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
