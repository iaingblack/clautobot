(() => {
  const state = {
    sessions: [],
    activeId: null,
    streaming: false,
    eventStream: null,
  };

  const STATUS_LABELS = {
    awaiting_approval: 'awaiting approval',
    approved: 'approved · triggering runbook',
    runbook_running: 'runbook running',
    runbook_complete: 'runbook complete',
    runbook_failed: 'runbook failed',
    done: 'done · ticket closed',
  };

  const el = {
    sessionList: document.getElementById('session-list'),
    newBtn: document.getElementById('new-chat'),
    empty: document.getElementById('empty-state'),
    transcript: document.getElementById('transcript'),
    form: document.getElementById('chat-form'),
    input: document.getElementById('chat-input'),
    send: document.getElementById('chat-send'),
    status: document.getElementById('chat-status'),
  };

  function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function renderSessionList() {
    clearChildren(el.sessionList);
    if (state.sessions.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty-hint';
      li.style.color = '#999';
      li.style.cursor = 'default';
      li.textContent = 'No chats yet';
      el.sessionList.appendChild(li);
      return;
    }
    for (const s of state.sessions) {
      const li = document.createElement('li');
      li.dataset.id = s.id;
      if (s.id === state.activeId) li.classList.add('active');

      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = s.title;
      li.appendChild(title);

      const meta = document.createElement('span');
      meta.className = 'session-meta';
      meta.textContent = `${s.turnCount} turn${s.turnCount === 1 ? '' : 's'} · ${timeAgo(s.updatedAt)}`;
      li.appendChild(meta);

      if (s.ticketKey) {
        const ticket = document.createElement('span');
        ticket.className = 'session-ticket';
        ticket.textContent = s.ticketKey;
        li.appendChild(ticket);
      }

      li.addEventListener('click', () => openSession(s.id));
      el.sessionList.appendChild(li);
    }
  }

  async function loadSessions() {
    const res = await fetch('/api/chat/sessions');
    state.sessions = await res.json();
    renderSessionList();
  }

  async function newChat() {
    const res = await fetch('/api/chat/sessions', { method: 'POST' });
    const session = await res.json();
    state.sessions.unshift(session);
    openSession(session.id);
  }

  async function openSession(id) {
    if (state.streaming) return;
    state.activeId = id;
    renderSessionList();
    el.empty.hidden = true;
    el.transcript.hidden = false;
    el.form.hidden = false;
    clearChildren(el.transcript);
    el.status.textContent = 'Loading history...';
    el.status.classList.remove('error');
    closeEventStream();
    try {
      const res = await fetch(`/api/chat/sessions/${id}/history`);
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load history');
      const { history } = await res.json();
      for (const turn of history) {
        addMessage(turn.role, turn.text);
      }
      el.status.textContent = history.length === 0 ? 'Empty chat — send a message to start.' : '';
      el.input.focus();
      openEventStream(id);
    } catch (err) {
      el.status.textContent = err.message;
      el.status.classList.add('error');
    }
  }

  function closeEventStream() {
    if (state.eventStream) {
      try { state.eventStream.close(); } catch {}
      state.eventStream = null;
    }
  }

  function openEventStream(id) {
    const es = new EventSource(`/api/chat/sessions/${id}/events`);
    state.eventStream = es;
    es.addEventListener('workflow-update', ev => {
      try {
        const data = JSON.parse(ev.data);
        const label = STATUS_LABELS[data.status] || data.status;
        const parts = [];

        if (data.jiraUrl) {
          parts.push(buildLink(data.ticketKey, data.jiraUrl));
        } else {
          parts.push(data.ticketKey);
        }
        parts.push(label);
        if (data.octopusTaskId && data.octopusTaskUrl) {
          parts.push(buildLink(`task ${data.octopusTaskId}`, data.octopusTaskUrl));
        } else if (data.octopusTaskId) {
          parts.push(`task ${data.octopusTaskId}`);
        }

        addSystemMessageParts(parts);
      } catch {}
    });
    es.onerror = () => {
      // Let the browser auto-reconnect; just surface it in status.
      if (!state.streaming) el.status.textContent = 'Live updates disconnected, retrying...';
    };
  }

  function buildLink(text, url) {
    const a = document.createElement('a');
    a.textContent = text;
    if (/^https?:\/\//i.test(url)) a.setAttribute('href', url);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    return a;
  }

  function addSystemMessage(text) {
    addSystemMessageParts([text]);
  }

  function addSystemMessageParts(parts) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.appendChild(document.createTextNode('⚙  '));
    parts.forEach((part, i) => {
      if (i > 0) div.appendChild(document.createTextNode(' · '));
      if (typeof part === 'string') div.appendChild(document.createTextNode(part));
      else div.appendChild(part);
    });
    el.transcript.appendChild(div);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    if (role === 'assistant') renderMarkdown(text, div);
    else div.textContent = text;
    el.transcript.appendChild(div);
    el.transcript.scrollTop = el.transcript.scrollHeight;
    return div;
  }

  // ---- Minimal markdown renderer (safe: only textContent + createElement) ----

  function renderMarkdown(src, container) {
    clearChildren(container);
    const lines = src.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      if (line.trim().startsWith('```')) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        i++;
        const buf = [];
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          buf.push(lines[i]);
          i++;
        }
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        container.appendChild(pre);
        if (i < lines.length) i++;
        continue;
      }

      // Headers
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        const h = document.createElement('h' + headerMatch[1].length);
        parseInline(headerMatch[2], h);
        container.appendChild(h);
        i++;
        continue;
      }

      // Tables: header row followed by separator row
      if (line.trim().startsWith('|') && i + 1 < lines.length
          && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])) {
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        thead.appendChild(parseTableRow(line, 'th'));
        table.appendChild(thead);
        i += 2;
        const tbody = document.createElement('tbody');
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          tbody.appendChild(parseTableRow(lines[i], 'td'));
          i++;
        }
        table.appendChild(tbody);
        container.appendChild(table);
        continue;
      }

      // Blockquote
      if (line.startsWith('> ')) {
        const bq = document.createElement('blockquote');
        const buf = [];
        while (i < lines.length && lines[i].startsWith('> ')) {
          buf.push(lines[i].slice(2));
          i++;
        }
        parseInline(buf.join(' '), bq);
        container.appendChild(bq);
        continue;
      }

      // Unordered list
      if (/^[-*]\s+/.test(line)) {
        const ul = document.createElement('ul');
        while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
          const li = document.createElement('li');
          parseInline(lines[i].replace(/^[-*]\s+/, ''), li);
          ul.appendChild(li);
          i++;
        }
        container.appendChild(ul);
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(line)) {
        const ol = document.createElement('ol');
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          const li = document.createElement('li');
          parseInline(lines[i].replace(/^\d+\.\s+/, ''), li);
          ol.appendChild(li);
          i++;
        }
        container.appendChild(ol);
        continue;
      }

      // Skip blank lines
      if (line.trim() === '') { i++; continue; }

      // Paragraph: gather consecutive non-special lines
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== ''
             && !/^(#{1,6}\s|```|[-*]\s|\d+\.\s|>\s|\|)/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const p = document.createElement('p');
      parseInline(buf.join(' '), p);
      container.appendChild(p);
    }
  }

  function parseTableRow(line, cellTag) {
    const tr = document.createElement('tr');
    // Split on | and drop empty first/last cells from leading/trailing pipes.
    const cells = line.trim().replace(/^\||\|$/g, '').split('|');
    for (const raw of cells) {
      const cell = document.createElement(cellTag);
      parseInline(raw.trim(), cell);
      tr.appendChild(cell);
    }
    return tr;
  }

  // Parse inline markdown (code, bold, links) into `parent` as safe DOM nodes.
  function parseInline(text, parent) {
    const patterns = [
      { re: /`([^`]+)`/,                   render: m => { const n = document.createElement('code');   n.textContent = m[1]; return n; } },
      { re: /\*\*([^*]+)\*\*/,             render: m => { const n = document.createElement('strong'); n.textContent = m[1]; return n; } },
      { re: /\[([^\]]+)\]\(([^)\s]+)\)/,   render: m => {
          const a = document.createElement('a');
          a.textContent = m[1];
          const url = m[2];
          // Allow only http(s) and relative links — drops javascript: etc.
          if (/^(https?:\/\/|\/|#)/i.test(url)) a.setAttribute('href', url);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          return a;
        } },
    ];

    let remaining = text;
    while (remaining.length > 0) {
      let earliest = null;
      for (const p of patterns) {
        const m = remaining.match(p.re);
        if (m && (earliest === null || m.index < earliest.match.index)) {
          earliest = { match: m, pattern: p };
        }
      }
      if (!earliest) {
        parent.appendChild(document.createTextNode(remaining));
        return;
      }
      if (earliest.match.index > 0) {
        parent.appendChild(document.createTextNode(remaining.slice(0, earliest.match.index)));
      }
      parent.appendChild(earliest.pattern.render(earliest.match));
      remaining = remaining.slice(earliest.match.index + earliest.match[0].length);
    }
  }

  function addToolMessage(name, input) {
    const div = document.createElement('div');
    div.className = 'msg tool';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tool-name';
    nameSpan.textContent = `→ ${name}`;
    div.appendChild(nameSpan);

    const inputPreview = typeof input === 'object' ? JSON.stringify(input) : String(input);
    const trimmed = inputPreview.length > 200 ? inputPreview.slice(0, 200) + '…' : inputPreview;
    div.appendChild(document.createTextNode(' ' + trimmed));

    el.transcript.appendChild(div);
    el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function parseSseChunk(chunk) {
    const lines = chunk.split('\n');
    let eventName = 'message';
    let dataStr = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataStr += line.slice(6);
    }
    if (!dataStr) return null;
    try { return { name: eventName, data: JSON.parse(dataStr) }; }
    catch { return null; }
  }

  async function sendMessage(text) {
    if (!state.activeId || !text.trim()) return;
    state.streaming = true;
    el.send.disabled = true;
    el.input.disabled = true;
    addMessage('user', text);
    el.status.classList.remove('error');
    el.status.textContent = 'Thinking...';

    let assistantMsgEl = null;
    let assistantText = '';

    function handleEvent(ev) {
      switch (ev.name) {
        case 'text': {
          assistantText += ev.data.text;
          if (!assistantMsgEl) assistantMsgEl = addMessage('assistant', assistantText);
          else {
            renderMarkdown(assistantText, assistantMsgEl);
            el.transcript.scrollTop = el.transcript.scrollHeight;
          }
          break;
        }
        case 'tool_use':
          addToolMessage(ev.data.name, ev.data.input);
          assistantMsgEl = null;
          assistantText = '';
          break;
        case 'ticket_attached':
          addSystemMessage(`${ev.data.ticketKey} · watching for poller updates`);
          break;
        case 'error':
          addMessage('error', `Error: ${ev.data.message || 'unknown'}`);
          break;
        case 'result':
          el.status.textContent = `Done in ${Math.round((ev.data.duration_ms || 0) / 100) / 10}s · $${(ev.data.cost_usd || 0).toFixed(4)}`;
          break;
      }
    }

    try {
      const res = await fetch(`/api/chat/sessions/${state.activeId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok || !res.body) throw new Error(`Request failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseChunk(chunk);
          if (event) handleEvent(event);
        }
      }
    } catch (err) {
      addMessage('error', `Error: ${err.message}`);
      el.status.textContent = err.message;
      el.status.classList.add('error');
    } finally {
      state.streaming = false;
      el.send.disabled = false;
      el.input.disabled = false;
      el.input.value = '';
      el.input.focus();
      loadSessions();
    }
  }

  el.newBtn.addEventListener('click', newChat);
  el.form.addEventListener('submit', e => {
    e.preventDefault();
    const text = el.input.value;
    if (text.trim()) sendMessage(text);
  });
  el.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      el.form.requestSubmit();
    }
  });

  loadSessions();
})();
