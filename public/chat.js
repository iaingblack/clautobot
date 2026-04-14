(() => {
  const state = {
    sessions: [],
    activeId: null,
    streaming: false,
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
    try {
      const res = await fetch(`/api/chat/sessions/${id}/history`);
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to load history');
      const { history } = await res.json();
      for (const turn of history) {
        addMessage(turn.role, turn.text);
      }
      el.status.textContent = history.length === 0 ? 'Empty chat — send a message to start.' : '';
      el.input.focus();
    } catch (err) {
      el.status.textContent = err.message;
      el.status.classList.add('error');
    }
  }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = text;
    el.transcript.appendChild(div);
    el.transcript.scrollTop = el.transcript.scrollHeight;
    return div;
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
            assistantMsgEl.textContent = assistantText;
            el.transcript.scrollTop = el.transcript.scrollHeight;
          }
          break;
        }
        case 'tool_use':
          addToolMessage(ev.data.name, ev.data.input);
          assistantMsgEl = null;
          assistantText = '';
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
