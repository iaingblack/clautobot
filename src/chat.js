import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listSessions,
  getSession,
  createSession,
  recordTurn,
  deleteSession,
  setTicketKey,
} from './sessionStore.js';
import { runTurn, loadHistory } from './claudeRunner.js';
import { bus } from './events.js';

const TICKET_KEY_RE = /\/browse\/([A-Z][A-Z0-9_]*-\d+)/;

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
      let detectedTicket = session.ticketKey || null;

      const maybeAttachTicket = async text => {
        if (detectedTicket) return;
        const m = text && text.match(TICKET_KEY_RE);
        if (!m) return;
        detectedTicket = m[1];
        try {
          await setTicketKey(sessionId, detectedTicket);
          send('ticket_attached', { ticketKey: detectedTicket });
        } catch {}
      };

      turn.on('text', data => {
        send('text', data);
        maybeAttachTicket(data.text);
      });
      turn.on('thinking', data => send('thinking', data));
      turn.on('tool_use', data => send('tool_use', data));
      turn.on('tool_result', data => {
        send('tool_result', data);
        maybeAttachTicket(data.content);
      });
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

  router.get('/api/chat/sessions/:id/events', async (req, res) => {
    const sessionId = req.params.id;
    const session = await getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const onUpdate = async evt => {
      // Re-read session each time so a ticket attached mid-stream is picked up.
      const current = await getSession(sessionId);
      if (!current?.ticketKey || current.ticketKey !== evt.ticketKey) return;
      const taskId = evt.workflow?.octopusTaskId;
      const octopusBase = process.env.OCTOPUS_SERVER_URL;
      const octopusTaskUrl = taskId && octopusBase
        ? `${octopusBase.replace(/\/$/, '')}/app#/tasks/${taskId}`
        : null;
      send('workflow-update', {
        ticketKey: evt.ticketKey,
        status: evt.status,
        workflowType: evt.workflow?.workflowType,
        octopusTaskId: taskId,
        octopusTaskUrl,
        jiraUrl: evt.workflow?.jiraUrl,
        updatedAt: evt.workflow?.updatedAt,
      });
    };

    bus.on('workflow-update', onUpdate);

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      bus.off('workflow-update', onUpdate);
    });
  });

  return router;
}
