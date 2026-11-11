(() => {
  const DEFAULTS = {
    ollamaUrl: 'http://localhost:11434',
    bridgeUrl: 'http://127.0.0.1:8765',
    useBridgeProxy: true,
    workspacePath: '',
    temperature: 0.4,
    think: false,
    preset: 'dev',
  };

  const PRESETS = {
    dev: 'You are an expert software engineer paired with Antigravity. Use any attached workspace files accurately, cite exact filenames and symbols, and give concise, copy-paste-ready fixes.',
    scriptdesk: 'You are a film production and screenplay assistant for ScriptDesk. Help with scene breakdowns, shot division, shooting schedules, call sheets, and Telugu/Hindi/English script formatting.',
    general: 'You are a helpful, concise local AI assistant running offline via Ollama.',
  };

  const el = (id) => document.getElementById(id);
  let settings = loadJson('oab_settings', DEFAULTS);
  let chats = loadJson('oab_chats', []);
  let activeChatId = localStorage.getItem('oab_active_chat') || '';
  let bridgeAlive = false;
  let workspaceFiles = [];
  let attachments = new Map(); // path -> { name, content, handle? }
  let abortCtrl = null;

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : structuredClone(fallback);
    } catch {
      return structuredClone(fallback);
    }
  }

  function loadArray(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  chats = loadArray('oab_chats');
  if (!chats.length) createChat(false);
  if (!chats.some((c) => c.id === activeChatId)) activeChatId = chats[0].id;

  function saveChats() {
    localStorage.setItem('oab_chats', JSON.stringify(chats));
    localStorage.setItem('oab_active_chat', activeChatId);
  }

  function currentChat() {
    return chats.find((c) => c.id === activeChatId) || chats[0];
  }

  function createChat(render = true) {
    const id = 'chat_' + Date.now();
    chats.unshift({ id, title: 'New chat', messages: [] });
    activeChatId = id;
    saveChats();
    if (render) {
      renderChatList();
      renderMessages();
    }
  }

  function ollamaBase() {
    if (bridgeAlive && settings.useBridgeProxy) {
      return `${settings.bridgeUrl.replace(/\/$/, '')}/api/ollama`;
    }
    return settings.ollamaUrl.replace(/\/$/, '');
  }

  async function checkBridge() {
    const badge = el('bridgeStatus');
    try {
      const res = await fetch(`${settings.bridgeUrl.replace(/\/$/, '')}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      bridgeAlive = true;
      badge.textContent = 'Bridge: Connected';
      badge.className = 'pill ok';
      if (!settings.workspacePath && data.workspace) {
        settings.workspacePath = data.workspace;
      }
      await refreshBridgeWorkspace();
    } catch {
      bridgeAlive = false;
      badge.textContent = 'Bridge: Browser-only';
      badge.className = 'pill warn';
      el('agInfo').innerHTML = 'Bridge offline. Run <code>python bridge_server.py</code> for local tools &amp; MCP inspection, or use <b>Folder</b> above.';
    }
  }

  async function refreshBridgeWorkspace() {
    if (!bridgeAlive) return;
    try {
      const [filesRes, agRes] = await Promise.all([
        fetch(`${settings.bridgeUrl}/api/workspace/files`),
        fetch(`${settings.bridgeUrl}/api/antigravity/info`),
      ]);
      if (filesRes.ok) {
        const fData = await filesRes.json();
        el('wsPath').textContent = fData.workspace || '';
        workspaceFiles = (fData.files || []).map((f) => ({
          path: f.path,
          size: f.size,
          source: 'bridge',
        }));
        renderFileList();
      }
      if (agRes.ok) {
        const ag = await agRes.json();
        const skills = (ag.workspaceSkills || []).map((s) => s.name).join(', ') || 'none';
        const mcps = (ag.mcpServers || []).join(', ') || 'none';
        el('agInfo').innerHTML =
          `<div><b>GEMINI.md:</b> ${ag.hasGeminiMd ? 'Yes' : 'No'}</div>` +
          `<div><b>Skills:</b> ${escapeHtml(skills)}</div>` +
          `<div><b>MCPs:</b> ${escapeHtml(mcps)}</div>`;
      }
    } catch {
      // ignore transient errors
    }
  }

  async function checkOllama() {
    const badge = el('ollamaStatus');
    const select = el('modelSelect');
    el('corsBanner').classList.add('hidden');
    try {
      const res = await fetch(`${ollamaBase()}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const models = data.models || [];
      badge.textContent = `Ollama: ${models.length} model${models.length === 1 ? '' : 's'}`;
      badge.className = 'pill ok';

      const prev = select.value || localStorage.getItem('oab_model') || '';
      select.innerHTML = '';
      if (!models.length) {
        select.innerHTML = '<option value="">No models installed (run ollama pull qwen3:8b)</option>';
        return;
      }
      // Put local models before :cloud models
      models.sort((a, b) => Number(!!a.remote_host) - Number(!!b.remote_host));
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.name;
        const isCloud = Boolean(m.remote_host) || m.name.endsWith(':cloud');
        opt.textContent = isCloud ? `${m.name} [Cloud · uses tokens]` : `${m.name} [Local · free]`;
        select.appendChild(opt);
      }
      if (prev && models.some((m) => m.name === prev)) select.value = prev;
    } catch (err) {
      const isHttps = location.protocol === 'https:';
      badge.textContent = isHttps ? 'Ollama: Blocked / Offline' : 'Ollama: Offline';
      badge.className = 'pill err';
      select.innerHTML = '<option value="">Ollama unreachable</option>';
      if (isHttps || String(err).includes('Failed to fetch')) {
        el('corsBanner').classList.remove('hidden');
      }
    }
  }

  function renderChatList() {
    const root = el('chatList');
    root.innerHTML = '';
    for (const chat of chats) {
      const row = document.createElement('div');
      row.className = 'list-item' + (chat.id === activeChatId ? ' active' : '');
      const title = document.createElement('span');
      title.className = 'truncate';
      title.textContent = chat.title || 'New chat';
      row.appendChild(title);

      if (chats.length > 1) {
        const del = document.createElement('button');
        del.className = 'del-btn';
        del.textContent = '✕';
        del.title = 'Delete chat';
        del.onclick = (e) => {
          e.stopPropagation();
          chats = chats.filter((c) => c.id !== chat.id);
          if (activeChatId === chat.id) activeChatId = chats[0].id;
          saveChats();
          renderChatList();
          renderMessages();
        };
        row.appendChild(del);
      }

      row.onclick = () => {
        activeChatId = chat.id;
        saveChats();
        renderChatList();
        renderMessages();
      };
      root.appendChild(row);
    }
  }

  function renderFileList() {
    const q = el('fileFilter').value.trim().toLowerCase();
    const root = el('fileList');
    root.innerHTML = '';
    const filtered = workspaceFiles.filter((f) => !q || f.path.toLowerCase().includes(q));
    for (const f of filtered.slice(0, 150)) {
      const btn = document.createElement('button');
      btn.className = 'list-item' + (attachments.has(f.path) ? ' active' : '');
      const span = document.createElement('span');
      span.className = 'truncate';
      span.textContent = f.path;
      btn.appendChild(span);
      btn.onclick = () => toggleAttachment(f);
      root.appendChild(btn);
    }
  }

  async function toggleAttachment(fileInfo) {
    if (attachments.has(fileInfo.path)) {
      attachments.delete(fileInfo.path);
      renderAttachments();
      renderFileList();
      return;
    }

    try {
      let content = '';
      if (fileInfo.source === 'bridge') {
        const res = await fetch(`${settings.bridgeUrl}/api/workspace/read?path=${encodeURIComponent(fileInfo.path)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to read file');
        content = data.content;
      } else if (fileInfo.file) {
        content = await fileInfo.file.text();
      } else if (fileInfo.handle) {
        const file = await fileInfo.handle.getFile();
        content = await file.text();
      }
      attachments.set(fileInfo.path, { path: fileInfo.path, content: content.slice(0, 80000) });
      renderAttachments();
      renderFileList();
    } catch (err) {
      alert('Could not read file: ' + err.message);
    }
  }

  function renderAttachments() {
    const bar = el('attachmentsBar');
    bar.innerHTML = '';
    if (!attachments.size) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    for (const [path] of attachments) {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.textContent = path + ' ';
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.onclick = () => {
        attachments.delete(path);
        renderAttachments();
        renderFileList();
      };
      chip.appendChild(rm);
      bar.appendChild(chip);
    }
  }

  function renderMessages() {
    const container = el('messages');
    const chat = currentChat();
    container.innerHTML = '';
    if (!chat.messages.length) {
      container.appendChild(el('emptyState') || buildEmptyState());
      el('emptyState').classList.remove('hidden');
      return;
    }
    for (const msg of chat.messages) {
      container.appendChild(renderMessageNode(msg));
    }
    container.scrollTop = container.scrollHeight;
  }

  function buildEmptyState() {
    const div = document.createElement('div');
    div.id = 'emptyState';
    div.className = 'empty-state';
    div.innerHTML = '<h2>Ready for 100% Local AI</h2><p>Select a model and send a prompt.</p>';
    return div;
  }

  function renderMessageNode(msg) {
    const card = document.createElement('div');
    card.className = `msg ${msg.role}`;
    const role = document.createElement('div');
    role.className = 'msg-role';
    role.textContent = msg.role === 'user' ? 'You' : msg.role === 'tool' ? 'Bridge Tool' : (msg.model || 'Ollama');
    card.appendChild(role);

    if (msg.thinking) {
      const det = document.createElement('details');
      det.className = 'msg-think';
      const sum = document.createElement('summary');
      sum.textContent = 'Thinking trace';
      const pre = document.createElement('div');
      pre.style.whiteSpace = 'pre-wrap';
      pre.textContent = msg.thinking;
      det.append(sum, pre);
      card.appendChild(det);
    }

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = formatContent(msg.content || '');
    card.appendChild(body);
    return card;
  }

  function formatContent(text) {
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts
      .map((part) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const inner = part.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\n/, '');
          return `<pre><code>${escapeHtml(inner)}</code></pre>`;
        }
        return escapeHtml(part);
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function sendPrompt(overrideText) {
    const input = el('promptInput');
    const text = (overrideText ?? input.value).trim();
    const model = el('modelSelect').value;
    if (!text) return;
    if (!model) {
      alert('No Ollama model selected. Make sure Ollama is running and has a local model like qwen3:8b.');
      return;
    }

    if (!overrideText) input.value = '';
    const chat = currentChat();

    let userContent = text;
    if (attachments.size) {
      const ctxBlocks = [];
      for (const [path, info] of attachments) {
        ctxBlocks.push(`--- FILE: ${path} ---\n${info.content}`);
      }
      userContent = `${ctxBlocks.join('\n\n')}\n\nUser request:\n${text}`;
    }

    if (!chat.messages.length) {
      chat.title = text.slice(0, 42);
      renderChatList();
    }

    chat.messages.push({ role: 'user', content: text, fullContent: userContent });
    const assistantMsg = { role: 'assistant', model, content: '', thinking: '' };
    chat.messages.push(assistantMsg);
    saveChats();
    renderMessages();

    const apiMessages = [
      { role: 'system', content: PRESETS[el('presetSelect').value] || PRESETS.general },
      ...chat.messages.slice(0, -1).map((m) => ({
        role: m.role === 'tool' ? 'assistant' : m.role,
        content: m.fullContent || m.content,
      })),
    ];

    abortCtrl = new AbortController();
    el('sendBtn').classList.add('hidden');
    el('stopBtn').classList.remove('hidden');

    try {
      const res = await fetch(`${ollamaBase()}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortCtrl.signal,
        body: JSON.stringify({
          model,
          messages: apiMessages,
          stream: true,
          think: el('thinkToggle').checked,
          options: { temperature: Number(settings.temperature) },
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk = JSON.parse(line);
          if (chunk.message?.thinking) assistantMsg.thinking += chunk.message.thinking;
          if (chunk.message?.content) assistantMsg.content += chunk.message.content;
          updateLastAssistantNode(assistantMsg);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        assistantMsg.content += '\n\n[Stopped]';
      } else {
        assistantMsg.content = `Error calling Ollama: ${err.message}`;
      }
      updateLastAssistantNode(assistantMsg);
    } finally {
      abortCtrl = null;
      el('sendBtn').classList.remove('hidden');
      el('stopBtn').classList.add('hidden');
      saveChats();
    }
  }

  function updateLastAssistantNode(msg) {
    const container = el('messages');
    const last = container.lastElementChild;
    if (!last) return;
    const fresh = renderMessageNode(msg);
    container.replaceChild(fresh, last);
    container.scrollTop = container.scrollHeight;
  }

  async function runBridgeTool(toolName) {
    if (!bridgeAlive) {
      alert('Start the local bridge first: python bridge_server.py');
      return;
    }
    const chat = currentChat();
    const res = await fetch(`${settings.bridgeUrl}/api/tools/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: toolName }),
    });
    const data = await res.json();
    chat.messages.push({
      role: 'tool',
      content: `[${toolName}]\n${data.output || data.error || 'Done'}`,
    });
    saveChats();
    renderMessages();
  }

  async function pickLocalFolder() {
    if (!window.showDirectoryPicker) {
      alert('Your browser does not support folder picking. Use the "Files" button or run python bridge_server.py.');
      return;
    }
    try {
      const dir = await window.showDirectoryPicker();
      el('wsPath').textContent = dir.name;
      const collected = [];
      async function walk(handle, prefix = '') {
        for await (const [name, entry] of handle.entries()) {
          if (['.git', 'node_modules', '__pycache__', '.firebase'].includes(name)) continue;
          const rel = prefix ? `${prefix}/${name}` : name;
          if (entry.kind === 'file') {
            collected.push({ path: rel, handle: entry, source: 'fsapi' });
            if (collected.length >= 300) return;
          } else if (entry.kind === 'directory') {
            await walk(entry, rel);
          }
        }
      }
      await walk(dir);
      workspaceFiles = collected;
      renderFileList();
    } catch {
      // user cancelled
    }
  }

  // Event bindings
  el('newChatBtn').onclick = () => createChat(true);
  el('sendBtn').onclick = () => sendPrompt();
  el('stopBtn').onclick = () => abortCtrl?.abort();
  el('promptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
  el('modelSelect').onchange = () => localStorage.setItem('oab_model', el('modelSelect').value);
  el('presetSelect').value = settings.preset;
  el('presetSelect').onchange = () => {
    settings.preset = el('presetSelect').value;
    localStorage.setItem('oab_settings', JSON.stringify(settings));
  };
  el('thinkToggle').checked = Boolean(settings.think);
  el('thinkToggle').onchange = () => {
    settings.think = el('thinkToggle').checked;
    localStorage.setItem('oab_settings', JSON.stringify(settings));
  };
  el('fileFilter').oninput = renderFileList;
  el('pickFolderBtn').onclick = pickLocalFolder;
  el('pickFilesInput').onchange = (e) => {
    const files = Array.from(e.target.files || []);
    workspaceFiles = files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f, source: 'input' }));
    el('wsPath').textContent = `${files.length} selected file(s)`;
    renderFileList();
  };
  el('refreshBridgeBtn').onclick = async () => {
    await checkBridge();
    await checkOllama();
  };
  el('btnOllamaList').onclick = () => runBridgeTool('ollama_list');
  el('btnBuildScriptDesk').onclick = () => runBridgeTool('build_scriptdesk');
  el('copyCorsBtn').onclick = () => {
    navigator.clipboard.writeText(el('corsCmd').textContent);
    el('copyCorsBtn').textContent = 'Copied!';
    setTimeout(() => (el('copyCorsBtn').textContent = 'Copy'), 1500);
  };
  el('exportMdBtn').onclick = () => {
    const chat = currentChat();
    const md = chat.messages.map((m) => `### ${m.role.toUpperCase()}\n\n${m.content}`).join('\n\n---\n\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(chat.title || 'chat').replace(/[^a-z0-9_-]/gi, '_')}.md`;
    a.click();
  };
  el('toggleSidebarBtn').onclick = () => el('sidebar').classList.toggle('open');
  document.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.onclick = () => sendPrompt(btn.dataset.prompt);
  });

  // Settings dialog
  const dlg = el('settingsDialog');
  el('settingsBtn').onclick = () => {
    el('cfgOllamaUrl').value = settings.ollamaUrl;
    el('cfgBridgeUrl').value = settings.bridgeUrl;
    el('cfgUseBridgeProxy').checked = settings.useBridgeProxy;
    el('cfgWorkspacePath').value = settings.workspacePath;
    el('cfgTemp').value = settings.temperature;
    el('tempVal').textContent = settings.temperature;
    dlg.showModal();
  };
  el('cfgTemp').oninput = () => (el('tempVal').textContent = el('cfgTemp').value);
  el('resetSettingsBtn').onclick = () => {
    settings = structuredClone(DEFAULTS);
    localStorage.setItem('oab_settings', JSON.stringify(settings));
    dlg.close();
    boot();
  };
  el('saveSettingsBtn').onclick = async () => {
    settings.ollamaUrl = el('cfgOllamaUrl').value.trim() || DEFAULTS.ollamaUrl;
    settings.bridgeUrl = el('cfgBridgeUrl').value.trim() || DEFAULTS.bridgeUrl;
    settings.useBridgeProxy = el('cfgUseBridgeProxy').checked;
    settings.temperature = Number(el('cfgTemp').value);
    const newWs = el('cfgWorkspacePath').value.trim();
    if (newWs && bridgeAlive && newWs !== settings.workspacePath) {
      await fetch(`${settings.bridgeUrl}/api/workspace/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newWs }),
      });
      settings.workspacePath = newWs;
    }
    localStorage.setItem('oab_settings', JSON.stringify(settings));
    dlg.close();
    await boot();
  };

  async function boot() {
    renderChatList();
    renderMessages();
    await checkBridge();
    await checkOllama();
  }

  boot();
})();
