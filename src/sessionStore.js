import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, '..', 'state', 'chat-sessions.json');

async function load() {
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { sessions: [] };
    throw err;
  }
}

async function save(data) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(data, null, 2));
}

function deriveTitle(firstMessage) {
  const trimmed = firstMessage.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? trimmed.slice(0, 57) + '...' : trimmed;
}

export async function listSessions() {
  const data = await load();
  return [...data.sessions].sort((a, b) =>
    (b.updatedAt || '').localeCompare(a.updatedAt || '')
  );
}

export async function getSession(id) {
  const data = await load();
  return data.sessions.find(s => s.id === id) || null;
}

export async function createSession() {
  const data = await load();
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    ticketKey: null,
  };
  data.sessions.push(session);
  await save(data);
  return session;
}

export async function recordTurn(id, userMessage) {
  const data = await load();
  const session = data.sessions.find(s => s.id === id);
  if (!session) throw new Error(`Session not found: ${id}`);
  if (session.turnCount === 0 && userMessage) {
    session.title = deriveTitle(userMessage);
  }
  session.turnCount += 1;
  session.updatedAt = new Date().toISOString();
  await save(data);
  return session;
}

export async function setTicketKey(id, ticketKey) {
  const data = await load();
  const session = data.sessions.find(s => s.id === id);
  if (!session) return null;
  session.ticketKey = ticketKey;
  session.updatedAt = new Date().toISOString();
  await save(data);
  return session;
}

export async function deleteSession(id) {
  const data = await load();
  data.sessions = data.sessions.filter(s => s.id !== id);
  await save(data);
}
