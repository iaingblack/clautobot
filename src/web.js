import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAllWorkflows, getWorkflow } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function timeAgo(isoString) {
  if (!isoString) return 'never';
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusClass(status) {
  switch (status) {
    case 'done': return 'status-done';
    case 'runbook_running': case 'runbook_complete': return 'status-running';
    case 'awaiting_approval': case 'approved': return 'status-waiting';
    case 'runbook_failed': return 'status-failed';
    default: return '';
  }
}

function renderRow(wf) {
  const params = wf.params ? Object.entries(wf.params).map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join(', ') : '';
  const octopusLink = wf.octopusTaskId
    ? `<a href="${escapeHtml(process.env.OCTOPUS_SERVER_URL)}/app#/tasks/${escapeHtml(wf.octopusTaskId)}">Octopus</a>`
    : '';
  return `<tr>
    <td><a href="/workflow/${escapeHtml(wf.ticketKey)}">${escapeHtml(wf.ticketKey)}</a></td>
    <td>${escapeHtml(wf.workflowType)}</td>
    <td><span class="status ${statusClass(wf.status)}">${escapeHtml(wf.status)}</span></td>
    <td>${params}</td>
    <td title="${escapeHtml(wf.createdAt)}">${timeAgo(wf.createdAt)}</td>
    <td title="${escapeHtml(wf.updatedAt)}">${timeAgo(wf.updatedAt)}</td>
    <td class="links">
      <a href="${escapeHtml(wf.jiraUrl)}">Jira</a>
      ${octopusLink}
    </td>
  </tr>`;
}

function renderDashboard(workflows, health) {
  const rows = workflows.length > 0
    ? workflows.map(renderRow).join('')
    : '<tr><td colspan="7" class="empty">No workflows found</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
  <title>Clautobot Dashboard</title>
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
  <header>
    <h1>Clautobot</h1>
    <div class="health">
      Last poll: ${timeAgo(health.lastPollAt)} &middot;
      Polls: ${health.pollCount} &middot;
      Uptime: ${timeAgo(health.startedAt)} &middot;
      Types: ${health.workflowConfigs.join(', ')}
    </div>
  </header>
  <main>
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Workflow</th>
          <th>Status</th>
          <th>Params</th>
          <th>Created</th>
          <th>Updated</th>
          <th>Links</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </main>
</body>
</html>`;
}

function renderDetail(wf) {
  const params = wf.params ? Object.entries(wf.params).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('') : '<dd>None</dd>';
  const octopusUrl = wf.octopusTaskId ? `${process.env.OCTOPUS_SERVER_URL}/app#/tasks/${wf.octopusTaskId}` : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
  <title>${escapeHtml(wf.ticketKey)} - Clautobot</title>
  <link rel="stylesheet" href="/public/style.css">
</head>
<body>
  <header>
    <h1><a href="/">Clautobot</a> &rsaquo; ${escapeHtml(wf.ticketKey)}</h1>
  </header>
  <main class="detail">
    <section class="info">
      <div class="field">
        <label>Status</label>
        <span class="status ${statusClass(wf.status)}">${escapeHtml(wf.status)}</span>
      </div>
      <div class="field">
        <label>Workflow</label>
        <span>${escapeHtml(wf.workflowType)}</span>
      </div>
      <div class="field">
        <label>Created</label>
        <span>${escapeHtml(wf.createdAt)}</span>
      </div>
      <div class="field">
        <label>Updated</label>
        <span>${escapeHtml(wf.updatedAt)}</span>
      </div>
      <div class="field">
        <label>Jira</label>
        <a href="${escapeHtml(wf.jiraUrl)}">${escapeHtml(wf.ticketKey)}</a>
      </div>
      ${octopusUrl ? `<div class="field">
        <label>Octopus Task</label>
        <a href="${escapeHtml(octopusUrl)}">${escapeHtml(wf.octopusTaskId)}</a>
      </div>` : ''}
    </section>
    <section>
      <h2>Parameters</h2>
      <dl>${params}</dl>
    </section>
    ${wf.runbookLog ? `<section>
      <h2>Runbook Output</h2>
      <pre class="log">${escapeHtml(wf.runbookLog)}</pre>
    </section>` : ''}
  </main>
</body>
</html>`;
}

export function startWeb(pollerState) {
  const app = express();
  const PORT = process.env.WEB_PORT || 3000;

  app.use('/public', express.static(join(__dirname, '..', 'public')));

  app.get('/', async (req, res) => {
    const workflows = await getAllWorkflows();
    res.send(renderDashboard(workflows, pollerState));
  });

  app.get('/workflow/:key', async (req, res) => {
    try {
      const wf = await getWorkflow(req.params.key);
      res.send(renderDetail(wf));
    } catch {
      res.status(404).send('Workflow not found');
    }
  });

  app.get('/api/health', (req, res) => {
    res.json(pollerState);
  });

  app.get('/api/workflows', async (req, res) => {
    res.json(await getAllWorkflows());
  });

  app.get('/api/workflows/:key', async (req, res) => {
    try {
      res.json(await getWorkflow(req.params.key));
    } catch {
      res.status(404).json({ error: 'Not found' });
    }
  });

  app.listen(PORT, () => {
    const ts = new Date().toISOString();
    console.log(`${ts} [web] Dashboard: http://localhost:${PORT}`);
  });
}
