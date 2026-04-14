import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listSessions,
  getSession,
  createSession,
  recordTurn,
  deleteSession,
} from './sessionStore.js';
import { runTurn, loadHistory } from './claudeRunner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

export function chatRouter() {
  const router = express.Router();
  router.use(express.json());

  router.get('/chat', (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'chat.html'));
  });

  router.get('/api/chat/sessions', async (_req, res) => {
    try {
      res.json(await listSessions());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/chat/sessions', async (_req, res) => {
    try {
      res.json(await createSession());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/chat/sessions/:id/history', async (req, res) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const history = await loadHistory(req.params.id);
      res.json({ session, history });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/chat/sessions/:id', async (req, res) => {
    try {
      await deleteSession(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/chat/sessions/:id/message', async (req, res) => {
    const sessionId = req.params.id;
    const message = (req.body?.message || '').toString();
    if (!message.trim()) return res.status(400).json({ error: 'Empty message' });

    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // SSE setup
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const isFirstTurn = session.turnCount === 0;
      await recordTurn(sessionId, message);

      const turn = runTurn({ sessionId, message, isFirstTurn });

      turn.on('text', data => send('text', data));
      turn.on('thinking', data => send('thinking', data));
      turn.on('tool_use', data => send('tool_use', data));
      turn.on('tool_result', data => send('tool_result', data));
      turn.on('system', data => {
        if (data.subtype === 'init') send('system', { subtype: 'init' });
      });
      turn.on('error', data => send('error', data));
      turn.on('result', data => send('result', data));
      turn.on('end', data => {
        send('end', data);
        res.end();
      });

      req.on('close', () => {
        try { turn.kill(); } catch {}
      });
    } catch (err) {
      send('error', { message: err.message });
      send('end', { code: 1 });
      res.end();
    }
  });

  return router;
}
