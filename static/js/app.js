/**
 * Nova — Personal AI Assistant
 * Chat logic, streaming, auth, conversation history, and settings panel.
 */

(function () {
    'use strict';

    // ─── API base (same-origin on Cloud Run / port 5000) ──────────
    var DEFAULT_FLASK_API = 'http://127.0.0.1:5000';

    function getApiBase() {
        try {
            var fromLs = localStorage.getItem('nova_api_base');
            if (fromLs && fromLs.trim()) return fromLs.trim().replace(/\/$/, '');
        } catch (e) { /* ignore */ }
        if (typeof window.NOVA_API_BASE === 'string' && window.NOVA_API_BASE.trim())
            return window.NOVA_API_BASE.trim().replace(/\/$/, '');
        var meta = document.querySelector('meta[name="nova-api-base"]');
        var fromMeta = meta && meta.getAttribute('content');
        if (fromMeta && String(fromMeta).trim()) return String(fromMeta).trim().replace(/\/$/, '');
        var port = String(window.location.port || '');
        if (port === '5000') return '';
        return DEFAULT_FLASK_API;
    }

    function apiUrl(path) {
        var p = (path || '/');
        if (p.charAt(0) !== '/') p = '/' + p;
        return getApiBase() + p;
    }

    // ─── DOM ──────────────────────────────────────────────────────
    const chatMessages   = document.getElementById('chat-messages');
    const messageInput   = document.getElementById('message-input');
    const sendBtn        = document.getElementById('send-btn');
    const newChatBtn     = document.getElementById('new-chat-btn');
    const sidebarToggle  = document.getElementById('sidebar-toggle');
    const sidebar        = document.getElementById('sidebar');
    const modelWrap      = document.getElementById('model-select-wrap');
    const modelTrigger   = document.getElementById('model-trigger');
    const modelTriggerLabel = document.getElementById('model-trigger-label');
    const modelList      = document.getElementById('model-list');

    // Sidebar user widgets
    const sidebarAvatar   = document.getElementById('sidebar-avatar');
    const sidebarUserName = document.getElementById('sidebar-user-name');
    const sidebarUserEmail= document.getElementById('sidebar-user-email');
    const convListEl      = document.getElementById('conversation-list');

    // Settings drawer
    const settingsOverlay  = document.getElementById('settings-overlay');
    const settingsDrawer   = document.getElementById('settings-drawer');
    const settingsOpenBtn  = document.getElementById('settings-open-btn');
    const settingsCloseBtn = document.getElementById('settings-close-btn');
    const settingsSaveBtn  = document.getElementById('settings-save-btn');
    const settingsSaveStatus = document.getElementById('settings-save-status');

    // ─── State ────────────────────────────────────────────────────
    let currentUser         = null;
    let currentConversationId = null;
    let userSettings        = {};
    let serverKeyConfigured = false;
    let lastCfgDefault      = 'gpt-4o-mini';
    let selectedModelId     = '';
    let isStreaming         = false;
    let pendingAttachments  = [];
    let speechRecognition   = null;
    let speechListening     = false;
    let voiceTextPrefix     = '';
    let voiceAutoSendOnUserStop = false;

    const FALLBACK_MODELS = [
        { id: 'gpt-4o-mini',    label: 'GPT-4o mini — fast, economical' },
        { id: 'gpt-4o',        label: 'GPT-4o — most capable' },
        { id: 'gpt-4-turbo',   label: 'GPT-4 Turbo' },
        { id: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
    ];

    // ─── Utilities ────────────────────────────────────────────────
    async function readJsonBody(response) {
        var text = await response.text();
        var t = text.trim();
        if (!t) return null;
        if (t.charAt(0) === '<') {
            try {
                var stored = localStorage.getItem('nova_api_base');
                if (stored) { localStorage.removeItem('nova_api_base'); window.location.reload(); return null; }
            } catch (e) { /* ignore */ }
            throw new Error('Got HTML instead of API JSON. Open the app at http://localhost:5000');
        }
        try { return JSON.parse(text); } catch (e) { throw new Error('Invalid JSON from server.'); }
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function renderMarkdown(text) {
        if (!text) return '';
        let html = escapeHtml(text);
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
            `<pre><code class="language-${lang}">${code.trim()}</code></pre>`);
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
        html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
        html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
        html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
        html = html.replace(/^---$/gm, '<hr>');
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        html = html.split('\n\n').map(block => {
            block = block.trim();
            if (!block) return '';
            if (/^<(h[1-6]|ul|ol|li|pre|blockquote|hr|div)/.test(block)) return block;
            return `<p>${block.replace(/\n/g, '<br>')}</p>`;
        }).join('\n');
        return html;
    }

    function avatarInitials(name, email) {
        var src = (name || email || '?').trim();
        var parts = src.split(' ').filter(Boolean);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return src.charAt(0).toUpperCase();
    }

    function relativeTime(isoStr) {
        if (!isoStr) return '';
        var d = new Date(isoStr);
        var now = Date.now();
        var diff = Math.floor((now - d.getTime()) / 1000);
        if (diff < 60)  return 'just now';
        if (diff < 3600) return Math.floor(diff/60) + 'm ago';
        if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
        return Math.floor(diff/86400) + 'd ago';
    }

    // ─── Model selector ───────────────────────────────────────────
    function closeModelList() {
        if (!modelList || !modelTrigger) return;
        modelList.hidden = true;
        modelTrigger.setAttribute('aria-expanded', 'false');
    }

    function openModelList() {
        if (!modelList || !modelTrigger) return;
        modelList.hidden = false;
        modelTrigger.setAttribute('aria-expanded', 'true');
    }

    function toggleModelList() {
        modelList && modelList.hidden ? openModelList() : closeModelList();
    }

    function selectModel(id, label) {
        selectedModelId = id;
        if (modelTriggerLabel) modelTriggerLabel.textContent = label || id || '—';
        if (modelList) {
            modelList.querySelectorAll('.model-select-option').forEach(li => {
                const isSel = li.getAttribute('data-value') === id;
                li.setAttribute('aria-selected', isSel ? 'true' : 'false');
                li.classList.toggle('is-selected', isSel);
            });
        }
        if (id) localStorage.setItem('nova_model', id);
    }

    function wireOptionKeys(li) {
        li.addEventListener('keydown', function (e) {
            const opts = modelList ? Array.from(modelList.querySelectorAll('.model-select-option')) : [];
            const i = opts.indexOf(li);
            if (e.key === 'ArrowDown') { e.preventDefault(); if (i < opts.length-1) opts[i+1].focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) opts[i-1].focus(); else { closeModelList(); modelTrigger.focus(); } }
            else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); li.click(); }
        });
    }

    function populateModelSelect(models, defaultId) {
        if (!modelList) return;
        modelList.innerHTML = '';
        if (!models || !models.length) { selectedModelId = ''; if (modelTriggerLabel) modelTriggerLabel.textContent = '—'; return; }
        models.forEach(m => {
            const li = document.createElement('li');
            li.setAttribute('role', 'option');
            li.setAttribute('data-value', m.id);
            li.setAttribute('tabindex', '-1');
            li.className = 'model-select-option';
            li.textContent = m.label;
            li.addEventListener('click', e => { e.stopPropagation(); selectModel(m.id, m.label); closeModelList(); modelTrigger.focus(); });
            wireOptionKeys(li);
            modelList.appendChild(li);
        });
        const saved = localStorage.getItem('nova_model');
        const validSaved = saved && models.some(x => x.id === saved);
        const pick = validSaved ? saved : (defaultId || (models[0] && models[0].id));
        const chosen = models.find(x => x.id === pick);
        if (pick) selectModel(pick, chosen ? chosen.label : pick);
    }

    async function refreshModelList() {
        try {
            const r = await fetch(apiUrl('/api/models'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const j = await readJsonBody(r);
            if (j && j.models && j.models.length) {
                populateModelSelect(j.models, j.default_model || lastCfgDefault);
                return;
            }
        } catch (e) { /* network */ }
        populateModelSelect(FALLBACK_MODELS, lastCfgDefault);
    }

    // ─── Attachments ──────────────────────────────────────────────
    function removeAttachmentById(id) {
        pendingAttachments = pendingAttachments.filter(a => a.id !== id);
        renderAttachmentStrip();
        handleInputChange();
    }

    function renderAttachmentStrip() {
        const strip = document.getElementById('attachment-strip');
        if (!strip) return;
        if (!pendingAttachments.length) { strip.innerHTML = ''; strip.hidden = true; return; }
        strip.hidden = false;
        strip.innerHTML = pendingAttachments.map(a => {
            var icon = a.kind === 'image' ? '🖼 ' : (a.kind === 'pdf' ? '📕 ' : '📄 ');
            return `<span class="attach-chip" data-id="${escapeHtml(a.id)}"><span class="attach-chip-name">${icon}${escapeHtml(a.name)}</span><button type="button" class="attach-chip-remove" data-remove="${escapeHtml(a.id)}" aria-label="Remove file">×</button></span>`;
        }).join('');
        strip.querySelectorAll('.attach-chip-remove').forEach(btn => {
            btn.addEventListener('click', () => removeAttachmentById(btn.getAttribute('data-remove')));
        });
    }

    function isPdfFile(file) {
        return (file.type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    }

    function isTextLikeFile(file) {
        var t = (file.type || '').toLowerCase();
        if (t.indexOf('text/') === 0) return true;
        if (['application/json','application/javascript','application/xml','application/x-toml'].includes(t)) return true;
        return /\.(txt|md|markdown|json|csv|xml|py|js|mjs|cjs|ts|tsx|jsx|css|html|htm|yml|yaml|sh|bash|sql|log|c|h|cpp|cc|hpp|go|rs|java|kt|kts|rb|php|cs|vue|svelte|ini|cfg|toml|env|properties|gitignore|dockerfile)$/i.test(file.name || '');
    }

    function readAttachmentFromFile(file) {
        return new Promise((resolve, reject) => {
            var okImg = ['image/png','image/jpeg','image/gif','image/webp'];
            var isImg = file.type.indexOf('image/') === 0;
            if (isImg) {
                if (file.size > 4*1024*1024) { reject(new Error(file.name + ': image too large (max 4 MB).')); return; }
                if (!okImg.includes(file.type)) { reject(new Error(file.name + ': use PNG, JPEG, GIF, or WebP.')); return; }
                var reader = new FileReader();
                reader.onload = () => {
                    var m = /^data:([^;]+);base64,(.+)$/.exec(reader.result);
                    if (!m) { reject(new Error('Could not read image.')); return; }
                    resolve({ id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2,9), kind: 'image', name: file.name, mime: m[1], data: m[2] });
                };
                reader.onerror = () => reject(new Error('Could not read file.'));
                reader.readAsDataURL(file);
                return;
            }
            if (isPdfFile(file)) {
                if (file.size > 20*1024*1024) { reject(new Error(file.name + ': PDF too large (max 20 MB).')); return; }
                var pdfReader = new FileReader();
                pdfReader.onload = () => {
                    var m = /^data:([^;]+);base64,(.+)$/.exec(pdfReader.result);
                    if (!m) { reject(new Error('Could not read PDF.')); return; }
                    resolve({ id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2,9), kind: 'pdf', name: file.name, mime: m[1] || 'application/pdf', data: m[2] });
                };
                pdfReader.onerror = () => reject(new Error('Could not read PDF.'));
                pdfReader.readAsDataURL(file);
                return;
            }
            if (isTextLikeFile(file)) {
                if (file.size > 600*1024) { reject(new Error(file.name + ': text file too large (max 600 KB).')); return; }
                var r2 = new FileReader();
                r2.onload = () => {
                    var t = r2.result;
                    if (typeof t !== 'string') { reject(new Error(file.name + ': not readable as text.')); return; }
                    if (t.length > 200000) { reject(new Error(file.name + ': text too long (max 200k characters).')); return; }
                    resolve({ id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2,9), kind: 'text', name: file.name, text: t });
                };
                r2.onerror = () => reject(new Error('Could not read file.'));
                r2.readAsText(file);
                return;
            }
            reject(new Error('Unsupported file type. Supported: images (PNG, JPEG, GIF, WebP), PDF, and plain text/code files.'));
        });
    }

    async function onFilesSelected(fileList) {
        var files = Array.from(fileList || []);
        for (var i = 0; i < files.length; i++) {
            if (pendingAttachments.length >= 6) break;
            try {
                var att = await readAttachmentFromFile(files[i]);
                pendingAttachments.push(att);
            } catch (err) {
                appendMessage('error', err.message || 'Could not attach file.');
            }
        }
        var fi = document.getElementById('file-input');
        if (fi) fi.value = '';
        renderAttachmentStrip();
        handleInputChange();
    }

    // ─── Voice input ──────────────────────────────────────────────
    function stopVoiceOutput() {
        if (window.speechSynthesis) window.speechSynthesis.cancel();
    }

    function stripMarkdownForSpeech(md) {
        if (!md) return '';
        return md
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/`[^`]+`/g, ' ')
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/^#+\s+/gm, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\s+/g, ' ').trim();
    }

    function speakText(text) {
        if (!window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(stripMarkdownForSpeech(text));
        u.rate = 1;
        window.speechSynthesis.speak(u);
    }

    function stopSpeechRecognition() {
        if (!speechRecognition || !speechListening) return;
        try { speechRecognition.stop(); } catch (e) { /* ignore */ }
        speechListening = false;
        var mb = document.getElementById('mic-btn');
        if (mb) { mb.classList.remove('is-listening'); mb.setAttribute('aria-pressed', 'false'); }
    }

    function setupVoiceInput(micBtn) {
        if (!micBtn) return;
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { micBtn.disabled = true; micBtn.title = 'Voice input not supported (try Chrome or Edge)'; return; }
        speechRecognition = new SR();
        speechRecognition.lang = navigator.language || 'en-US';
        speechRecognition.continuous = true;
        speechRecognition.interimResults = true;
        speechRecognition.onstart = () => {
            voiceTextPrefix = messageInput.value;
            if (voiceTextPrefix && !/\s$/.test(voiceTextPrefix)) voiceTextPrefix += ' ';
        };
        speechRecognition.onresult = event => {
            var interim = '', fin = '';
            for (var i = event.resultIndex; i < event.results.length; i++) {
                var t = event.results[i][0].transcript;
                if (event.results[i].isFinal) fin += t; else interim += t;
            }
            messageInput.value = voiceTextPrefix + fin + interim;
            handleInputChange();
        };
        speechRecognition.onerror = () => {
            speechListening = false;
            micBtn.classList.remove('is-listening');
            micBtn.setAttribute('aria-pressed', 'false');
        };
        speechRecognition.onend = () => {
            speechListening = false;
            micBtn.classList.remove('is-listening');
            micBtn.setAttribute('aria-pressed', 'false');
            var shouldAutoSend = voiceAutoSendOnUserStop;
            voiceAutoSendOnUserStop = false;
            if (shouldAutoSend) {
                var t = messageInput.value.trim();
                if (t && !isStreaming) void handleSend();
            }
        };
        micBtn.addEventListener('click', () => {
            if (speechListening) { voiceAutoSendOnUserStop = true; stopSpeechRecognition(); return; }
            try {
                speechRecognition.start();
                speechListening = true;
                micBtn.classList.add('is-listening');
                micBtn.setAttribute('aria-pressed', 'true');
            } catch (e) { speechListening = false; }
        });
    }

    // ─── Message DOM helpers ──────────────────────────────────────
    function finalizeAssistantMessage(el, plainText) {
        var actions = el.querySelector('.message-actions');
        if (!actions || !plainText || !plainText.trim()) return;
        if (el.classList.contains('message-error')) return;
        actions.hidden = false;
        actions.innerHTML =
            '<button type="button" class="msg-action-btn" data-copy>Copy</button>' +
            '<button type="button" class="msg-action-btn" data-speak>Read aloud</button>';
        actions.querySelector('[data-copy]').addEventListener('click', () => {
            navigator.clipboard.writeText(plainText).then(() => {
                var b = actions.querySelector('[data-copy]');
                var orig = b.textContent;
                b.textContent = 'Copied!';
                setTimeout(() => { b.textContent = orig; }, 1500);
            }).catch(() => {});
        });
        actions.querySelector('[data-speak]').addEventListener('click', () => speakText(plainText));
    }

    function appendMessage(role, content) {
        const welcome = document.getElementById('welcome-screen');
        if (welcome && role !== 'welcome') welcome.style.display = 'none';
        const div = document.createElement('div');
        div.className = `message message-${role === 'error' ? 'assistant message-error' : role}`;
        const avatarText = role === 'user' ? 'You' : '✦';
        const roleLabel  = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'Nova';
        const actionsHtml = role === 'assistant' ? '<div class="message-actions" hidden></div>' : '';
        div.innerHTML = `
            <div class="message-avatar">${avatarText}</div>
            <div class="message-content">
                <div class="message-role">${roleLabel}</div>
                <div class="message-body">${role === 'user' ? escapeHtml(content) : renderMarkdown(content)}</div>
                ${actionsHtml}
            </div>`;
        chatMessages.appendChild(div);
        scrollToBottom();
        return div;
    }

    function appendTypingIndicator() {
        const div = document.createElement('div');
        div.className = 'message message-assistant';
        div.innerHTML = `
            <div class="message-avatar">✦</div>
            <div class="message-content">
                <div class="message-role">Nova</div>
                <div class="message-body"><div class="typing-indicator"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>
            </div>`;
        chatMessages.appendChild(div);
        scrollToBottom();
        return div;
    }

    function scrollToBottom() {
        requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight; });
    }

    // ─── User / Sidebar ───────────────────────────────────────────
    function renderUserInfo(user) {
        if (!user) return;
        var initials = avatarInitials(user.display_name, user.email);
        if (sidebarAvatar) {
            if (user.avatar_url) {
                sidebarAvatar.innerHTML = `<img src="${escapeHtml(user.avatar_url)}" alt="${escapeHtml(user.display_name || '')}" loading="lazy">`;
            } else {
                sidebarAvatar.textContent = initials;
            }
        }
        if (sidebarUserName)  sidebarUserName.textContent  = user.display_name || user.email || '';
        if (sidebarUserEmail) sidebarUserEmail.textContent = user.email || '';
    }

    // ─── Conversation list ────────────────────────────────────────
    async function loadConversations() {
        if (!convListEl) return;
        try {
            const r = await fetch(apiUrl('/api/conversations'));
            if (!r.ok) return;
            const convs = await readJsonBody(r);
            renderConversationList(convs || []);
        } catch (e) { /* ignore */ }
    }

    function renderConversationList(convs) {
        if (!convListEl) return;
        if (!convs || !convs.length) {
            convListEl.innerHTML = '<div class="conv-list-empty">No conversations yet</div>';
            return;
        }
        convListEl.innerHTML = '';
        convs.forEach(c => {
            const item = document.createElement('div');
            item.className = 'conv-item' + (c.id === currentConversationId ? ' active' : '');
            item.setAttribute('data-id', c.id);
            item.innerHTML = `
                <div class="conv-item-title" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</div>
                <button class="conv-item-delete" data-del="${escapeHtml(c.id)}" title="Delete" aria-label="Delete conversation">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>`;
            item.addEventListener('click', e => {
                if (e.target.closest('[data-del]')) return;
                loadConversation(c.id);
            });
            item.querySelector('[data-del]').addEventListener('click', e => {
                e.stopPropagation();
                deleteConversation(c.id, item);
            });
            convListEl.appendChild(item);
        });
    }

    async function loadConversation(id) {
        try {
            const r = await fetch(apiUrl('/api/conversations/' + id));
            if (!r.ok) return;
            const conv = await readJsonBody(r);
            if (!conv) return;

            currentConversationId = id;

            // Update active state
            if (convListEl) {
                convListEl.querySelectorAll('.conv-item').forEach(el => {
                    el.classList.toggle('active', el.getAttribute('data-id') === id);
                });
            }

            // Render messages
            chatMessages.innerHTML = '';
            (conv.messages || []).forEach(m => {
                if (m.role === 'user') appendMessage('user', m.content);
                else if (m.role === 'assistant') {
                    var el = appendMessage('assistant', m.content);
                    finalizeAssistantMessage(el, m.content);
                }
            });

            // Close sidebar on mobile
            sidebar.classList.remove('open');
            messageInput.focus();
        } catch (e) { /* ignore */ }
    }

    async function deleteConversation(id, itemEl) {
        try {
            await fetch(apiUrl('/api/conversations/' + id), { method: 'DELETE' });
            if (itemEl) itemEl.remove();
            if (!convListEl || !convListEl.querySelector('.conv-item')) {
                convListEl.innerHTML = '<div class="conv-list-empty">No conversations yet</div>';
            }
            if (currentConversationId === id) {
                currentConversationId = null;
                resetChatUI();
            }
        } catch (e) { /* ignore */ }
    }

    // ─── Chat UI reset ────────────────────────────────────────────
    function resetChatUI() {
        chatMessages.innerHTML = `
            <div id="welcome-screen" class="welcome-screen">
                <div class="welcome-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#CC0000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></div>
                <h2>Hello! I'm Nova</h2>
                <p>Your personal AI assistant. I can help you with questions, writing, brainstorming, coding, and much more.</p>
                <div class="suggestion-chips">
                    <button class="chip" data-message="Explain quantum computing in simple terms">💡 Explain quantum computing</button>
                    <button class="chip" data-message="Help me write a professional email to my boss about requesting time off">✉️ Write a professional email</button>
                    <button class="chip" data-message="Give me 5 creative business ideas for 2025">🚀 Creative business ideas</button>
                    <button class="chip" data-message="Write a Python function to find the longest palindrome in a string">💻 Code a palindrome finder</button>
                </div>
            </div>`;
        document.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                messageInput.value = chip.getAttribute('data-message');
                handleInputChange();
                handleSend();
            });
        });
    }

    // ─── New Chat ─────────────────────────────────────────────────
    async function handleNewChat() {
        currentConversationId = null;
        resetChatUI();
        if (convListEl) convListEl.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
        sidebar.classList.remove('open');
        pendingAttachments = [];
        renderAttachmentStrip();
        stopSpeechRecognition();
        stopVoiceOutput();
        messageInput.focus();
    }

    // ─── Send message ─────────────────────────────────────────────
    async function handleSend() {
        const text = messageInput.value.trim();
        if ((!text && pendingAttachments.length === 0) || isStreaming) return;

        stopSpeechRecognition();
        stopVoiceOutput();

        const payloadAtts = pendingAttachments.map(a => {
            if (a.kind === 'image') return { kind: 'image', name: a.name, mime: a.mime, data: a.data };
            if (a.kind === 'pdf')   return { kind: 'pdf',   name: a.name, mime: a.mime || 'application/pdf', data: a.data };
            return { kind: 'text', name: a.name, text: a.text };
        });

        var userDisplay = text;
        if (pendingAttachments.length) {
            userDisplay = (text || '(Attachments)') + '\n\n📎 ' + pendingAttachments.map(a => a.name).join(', ');
        }

        const welcome = document.getElementById('welcome-screen');
        if (welcome) welcome.style.display = 'none';

        appendMessage('user', userDisplay);
        messageInput.value = '';
        messageInput.style.height = 'auto';
        sendBtn.disabled = true;

        const typingEl = appendTypingIndicator();
        isStreaming = true;

        try {
            const response = await fetch(apiUrl('/api/chat'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: text,
                    conversation_id: currentConversationId,
                    model: selectedModelId,
                    attachments: payloadAtts,
                }),
            });

            if (!response.ok) {
                var errMsg = 'Server error (' + response.status + ')';
                if (response.status === 401) {
                    var errBody = null;
                    try { errBody = await readJsonBody(response); } catch (e) { /* ignore */ }
                    if (response.status === 401 && (!errBody || errBody.login)) {
                        window.location.href = '/login.html';
                        return;
                    }
                    errMsg = (errBody && errBody.error) || errMsg;
                } else {
                    try {
                        var eb = await readJsonBody(response);
                        if (eb && eb.error) errMsg = eb.error;
                    } catch (e) { /* ignore */ }
                }
                throw new Error(errMsg);
            }

            pendingAttachments = [];
            renderAttachmentStrip();
            typingEl.remove();

            const assistantEl = appendMessage('assistant', '');
            const bodyEl = assistantEl.querySelector('.message-body');
            let fullText = '';

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                for (const line of chunk.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.error) {
                            bodyEl.innerHTML = renderMarkdown(data.error);
                            assistantEl.classList.add('message-error');
                        } else if (data.chunk) {
                            fullText += data.chunk;
                            bodyEl.innerHTML = renderMarkdown(fullText);
                        } else if (data.done) {
                            // Update conversation state from server response
                            if (data.conversation_id) {
                                const isNew = !currentConversationId;
                                currentConversationId = data.conversation_id;
                                if (isNew) {
                                    // Refresh sidebar list to show new conversation
                                    await loadConversations();
                                } else if (data.title) {
                                    // Update title in sidebar if it changed
                                    var convItem = convListEl && convListEl.querySelector(`[data-id="${data.conversation_id}"]`);
                                    if (convItem) {
                                        var titleEl = convItem.querySelector('.conv-item-title');
                                        if (titleEl) titleEl.textContent = data.title;
                                    }
                                }
                                // Mark active
                                if (convListEl) {
                                    convListEl.querySelectorAll('.conv-item').forEach(el => {
                                        el.classList.toggle('active', el.getAttribute('data-id') === currentConversationId);
                                    });
                                }
                            }
                        }
                    } catch (parseErr) { /* skip malformed */ }
                }
                scrollToBottom();
            }

            if (!assistantEl.classList.contains('message-error') && fullText.trim()) {
                finalizeAssistantMessage(assistantEl, fullText);
            }

        } catch (error) {
            typingEl.remove();
            appendMessage('error', error.message || 'Failed to connect to the server.');
        }

        isStreaming = false;
        handleInputChange();
        messageInput.focus();
    }

    // ─── Input handling ───────────────────────────────────────────
    function handleInputChange() {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + 'px';
        sendBtn.disabled = !messageInput.value.trim() && pendingAttachments.length === 0;
    }

    function handleInputKeydown(e) {
        var sendOnEnter = (userSettings && typeof userSettings.send_on_enter !== 'undefined')
            ? userSettings.send_on_enter : true;
        if (e.key === 'Enter' && !e.shiftKey && sendOnEnter) {
            e.preventDefault();
            if (!isStreaming && messageInput.value.trim()) handleSend();
        }
    }

    // ─── Settings drawer ──────────────────────────────────────────
    function openSettings() {
        settingsDrawer.hidden  = false;
        settingsOverlay.hidden = false;
        loadSettings();
        loadSecurityEvents();
    }

    function closeSettings() {
        settingsDrawer.hidden  = true;
        settingsOverlay.hidden = true;
    }

    function switchSettingsTab(tabName) {
        document.querySelectorAll('.settings-tab').forEach(btn => {
            const active = btn.getAttribute('data-tab') === tabName;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('.settings-panel').forEach(panel => {
            panel.classList.toggle('active', panel.id === 'settings-panel-' + tabName);
        });
    }

    async function loadSettings() {
        try {
            const r = await fetch(apiUrl('/api/settings'));
            if (!r.ok) return;
            const s = await readJsonBody(r);
            if (!s) return;
            userSettings = s;

            var el;
            el = document.getElementById('setting-theme');        if (el) el.value = s.theme || 'light';
            el = document.getElementById('setting-font-size');    if (el) el.value = s.font_size || 'medium';
            el = document.getElementById('setting-send-on-enter');if (el) el.checked = s.send_on_enter !== false;
            el = document.getElementById('setting-default-model');if (el) el.value = s.default_model || 'gpt-4o-mini';
            el = document.getElementById('setting-max-turns');    if (el) el.value = s.max_history_turns || 20;
            el = document.getElementById('setting-stream');       if (el) el.checked = s.stream_responses !== false;
            el = document.getElementById('setting-system-prompt');if (el) el.value = s.system_prompt || '';
            el = document.getElementById('setting-api-key');      if (el) el.value = '';  // never pre-fill
            el = document.getElementById('setting-display-name'); if (el && currentUser) el.value = currentUser.display_name || '';

            // API key placeholder
            var apiKeyInput = document.getElementById('setting-api-key');
            if (apiKeyInput) apiKeyInput.placeholder = s.has_api_key ? '●●●●●●●●●●●● (set)' : 'sk-…';

            // Server key note
            var note = document.getElementById('server-key-note');
            if (note) note.hidden = !serverKeyConfigured;

            // Account panel
            if (currentUser) {
                el = document.getElementById('account-profile-name');  if (el) el.textContent = currentUser.display_name || '';
                el = document.getElementById('account-profile-email'); if (el) el.textContent = currentUser.email || '';
                el = document.getElementById('account-profile-provider'); if (el) el.textContent = 'Signed in via ' + (currentUser.provider || 'email');
                var avatarLg = document.getElementById('account-avatar-lg');
                if (avatarLg) {
                    if (currentUser.avatar_url) {
                        avatarLg.innerHTML = `<img src="${escapeHtml(currentUser.avatar_url)}" alt="" loading="lazy">`;
                    } else {
                        avatarLg.textContent = avatarInitials(currentUser.display_name, currentUser.email);
                    }
                }
                // Password change only for email accounts
                var pwNote = document.getElementById('pw-only-for-email-note');
                var changePwSection = document.getElementById('change-password-section');
                if (currentUser.provider !== 'email') {
                    if (pwNote) pwNote.hidden = false;
                    ['setting-current-pw','setting-new-pw','setting-confirm-pw','change-pw-btn'].forEach(id => {
                        var el2 = document.getElementById(id);
                        if (el2) el2.hidden = true;
                    });
                }
            }

            applyTheme(s.theme);
            applyFontSize(s.font_size);
        } catch (e) { /* ignore */ }
    }

    async function saveSettings() {
        var payload = {};
        var el;
        el = document.getElementById('setting-theme');        if (el) payload.theme = el.value;
        el = document.getElementById('setting-font-size');    if (el) payload.font_size = el.value;
        el = document.getElementById('setting-send-on-enter');if (el) payload.send_on_enter = el.checked;
        el = document.getElementById('setting-default-model');if (el) payload.default_model = el.value;
        el = document.getElementById('setting-max-turns');    if (el) payload.max_history_turns = parseInt(el.value, 10) || 20;
        el = document.getElementById('setting-stream');       if (el) payload.stream_responses = el.checked;
        el = document.getElementById('setting-system-prompt');if (el) payload.system_prompt = el.value;

        var apiKeyInput = document.getElementById('setting-api-key');
        if (apiKeyInput && apiKeyInput.value.trim()) payload.openai_api_key = apiKeyInput.value.trim();
        else if (apiKeyInput && apiKeyInput.value === '') payload.openai_api_key = '';

        try {
            settingsSaveBtn.disabled = true;
            const r = await fetch(apiUrl('/api/settings'), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (r.ok) {
                if (settingsSaveStatus) {
                    settingsSaveStatus.textContent = 'Saved!';
                    setTimeout(() => { settingsSaveStatus.textContent = ''; }, 2000);
                }
                userSettings = { ...userSettings, ...payload };
                applyTheme(payload.theme || userSettings.theme);
                applyFontSize(payload.font_size || userSettings.font_size);
                if (payload.default_model) selectModel(payload.default_model, payload.default_model);
                if (apiKeyInput) { apiKeyInput.value = ''; apiKeyInput.placeholder = '●●●●●●●●●●●● (set)'; }
                // Refresh model list with new key
                if (payload.openai_api_key) await refreshModelList();
            } else {
                var err = await readJsonBody(r);
                if (settingsSaveStatus) { settingsSaveStatus.style.color = '#b91c1c'; settingsSaveStatus.textContent = (err && err.error) || 'Save failed.'; setTimeout(() => { settingsSaveStatus.textContent = ''; settingsSaveStatus.style.color = ''; }, 3000); }
            }
        } catch (e) {
            if (settingsSaveStatus) { settingsSaveStatus.textContent = 'Network error.'; setTimeout(() => { settingsSaveStatus.textContent = ''; }, 3000); }
        } finally {
            settingsSaveBtn.disabled = false;
        }
    }

    function applyTheme(theme) {
        document.body.classList.toggle('theme-dark', theme === 'dark');
    }

    function applyFontSize(size) {
        document.body.classList.remove('font-small', 'font-medium', 'font-large');
        if (size) document.body.classList.add('font-' + size);
    }

    // ─── Security events ──────────────────────────────────────────
    async function loadSecurityEvents() {
        var list = document.getElementById('login-events-list');
        if (!list) return;
        try {
            const r = await fetch(apiUrl('/api/security/events'));
            if (!r.ok) { list.innerHTML = '<p class="field-hint">Could not load events.</p>'; return; }
            const events = await readJsonBody(r);
            if (!events || !events.length) { list.innerHTML = '<p class="field-hint">No login events recorded yet.</p>'; return; }
            list.innerHTML = events.map(ev => `
                <div class="login-event-row">
                    <span>${escapeHtml(ev.ip || 'Unknown IP')}</span>
                    <span class="login-event-ts">${relativeTime(ev.timestamp)}</span>
                    <span class="login-event-badge ${ev.success ? 'ok' : 'fail'}">${ev.success ? 'OK' : 'Failed'}</span>
                    <span class="login-event-ua">${escapeHtml((ev.user_agent || '').slice(0, 120))}</span>
                </div>`).join('');
        } catch (e) { list.innerHTML = '<p class="field-hint">Could not load events.</p>'; }
    }

    // ─── API key test ─────────────────────────────────────────────
    async function testApiKey() {
        var apiKeyInput = document.getElementById('setting-api-key');
        var status = document.getElementById('api-key-status');
        if (!apiKeyInput || !status) return;
        var key = apiKeyInput.value.trim();
        if (!key) { status.textContent = 'Enter a key to test.'; status.className = 'field-hint error'; return; }
        status.textContent = 'Testing…'; status.className = 'field-hint';
        try {
            const r = await fetch(apiUrl('/api/models'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: key }),
            });
            const j = await readJsonBody(r);
            if (r.ok && j && j.source === 'openai') {
                status.textContent = `✓ Valid — ${j.models.length} models available.`;
                status.className = 'field-hint success';
            } else {
                status.textContent = '✗ ' + ((j && j.error) || 'Invalid key.');
                status.className = 'field-hint error';
            }
        } catch (e) { status.textContent = 'Network error.'; status.className = 'field-hint error'; }
    }

    // ─── Account actions ──────────────────────────────────────────
    async function handleLogout() {
        try {
            await fetch(apiUrl('/auth/logout'), { method: 'POST' });
        } catch (e) { /* ignore */ }
        window.location.href = '/login.html';
    }

    async function handleDeleteAccount() {
        if (!confirm('Permanently delete your account and ALL data? This cannot be undone.')) return;
        try {
            const r = await fetch(apiUrl('/api/account'), { method: 'DELETE' });
            if (r.ok) window.location.href = '/login.html';
        } catch (e) { alert('Failed to delete account.'); }
    }

    async function handleDeleteAllChats() {
        if (!confirm('Delete ALL your conversations? This cannot be undone.')) return;
        try {
            const r = await fetch(apiUrl('/api/conversations'), { method: 'DELETE' });
            if (r.ok) {
                currentConversationId = null;
                if (convListEl) convListEl.innerHTML = '<div class="conv-list-empty">No conversations yet</div>';
                resetChatUI();
            }
        } catch (e) { /* ignore */ }
    }

    function handleExportData() {
        window.open(apiUrl('/api/data/export'), '_blank');
    }

    async function handleChangePassword() {
        var cur  = (document.getElementById('setting-current-pw')  || {}).value || '';
        var nw   = (document.getElementById('setting-new-pw')       || {}).value || '';
        var conf = (document.getElementById('setting-confirm-pw')   || {}).value || '';
        var status = document.getElementById('change-pw-status');
        if (!cur || !nw || !conf) { if (status) { status.textContent = 'All fields are required.'; status.className = 'field-hint error'; } return; }
        if (nw !== conf) { if (status) { status.textContent = 'Passwords do not match.'; status.className = 'field-hint error'; } return; }
        try {
            const r = await fetch(apiUrl('/auth/change-password'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ current_password: cur, new_password: nw }),
            });
            const j = await readJsonBody(r);
            if (r.ok) {
                if (status) { status.textContent = 'Password updated successfully!'; status.className = 'field-hint success'; }
                ['setting-current-pw','setting-new-pw','setting-confirm-pw'].forEach(id => { var el = document.getElementById(id); if (el) el.value = ''; });
            } else {
                if (status) { status.textContent = (j && j.error) || 'Failed to change password.'; status.className = 'field-hint error'; }
            }
        } catch (e) { if (status) { status.textContent = 'Network error.'; status.className = 'field-hint error'; } }
    }

    async function handleSaveDisplayName() {
        var nameInput = document.getElementById('setting-display-name');
        var status    = document.getElementById('display-name-status');
        var name = (nameInput && nameInput.value.trim()) || '';
        if (!name) { if (status) { status.textContent = 'Name cannot be empty.'; status.className = 'field-hint error'; } return; }
        try {
            const r = await fetch(apiUrl('/api/settings'), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ display_name: name }),
            });
            if (r.ok) {
                if (currentUser) currentUser.display_name = name;
                renderUserInfo(currentUser);
                if (status) { status.textContent = 'Saved!'; status.className = 'field-hint success'; setTimeout(() => { status.textContent = ''; }, 2000); }
                // Update account panel
                var el = document.getElementById('account-profile-name'); if (el) el.textContent = name;
            } else {
                if (status) { status.textContent = 'Failed to save.'; status.className = 'field-hint error'; }
            }
        } catch (e) { if (status) { status.textContent = 'Network error.'; status.className = 'field-hint error'; } }
    }

    // ─── Sidebar toggle ───────────────────────────────────────────
    function toggleSidebar() {
        sidebar.classList.toggle('open');
    }

    // ─── Init ─────────────────────────────────────────────────────
    async function init() {
        // Auth check — redirect to login if not signed in
        try {
            const r = await fetch(apiUrl('/auth/me'));
            if (!r.ok) {
                window.location.href = '/login.html';
                return;
            }
            const data = await readJsonBody(r);
            if (!data) { window.location.href = '/login.html'; return; }
            currentUser  = data;
            userSettings = data.settings || {};
            renderUserInfo(currentUser);
            if (userSettings.theme)    applyTheme(userSettings.theme);
            if (userSettings.font_size) applyFontSize(userSettings.font_size);
        } catch (e) {
            window.location.href = '/login.html';
            return;
        }

        // Config (server key, OAuth status, default model)
        try {
            const r = await fetch(apiUrl('/api/config'));
            if (r.ok) {
                const j = await readJsonBody(r);
                if (j) {
                    serverKeyConfigured = !!j.openai_configured;
                    if (j.default_model) lastCfgDefault = j.default_model;
                }
            }
        } catch (e) { /* offline */ }

        // Load conversation list
        await loadConversations();

        // Model selector
        populateModelSelect(FALLBACK_MODELS, userSettings.default_model || lastCfgDefault);
        await refreshModelList();

        modelTrigger.addEventListener('click', e => { e.stopPropagation(); toggleModelList(); });
        modelTrigger.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (modelList.hidden) openModelList();
                const opts = modelList.querySelectorAll('.model-select-option');
                if (!opts.length) return;
                (e.key === 'ArrowDown' ? opts[0] : opts[opts.length-1]).focus();
            }
        });
        document.addEventListener('click', e => {
            if (modelWrap && !modelList.hidden && !modelWrap.contains(e.target)) closeModelList();
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && modelList && !modelList.hidden) { closeModelList(); modelTrigger.focus(); }
        });

        // File attach
        var attachBtn = document.getElementById('attach-btn');
        var fileInput = document.getElementById('file-input');
        if (attachBtn && fileInput) {
            attachBtn.addEventListener('click', () => fileInput.click());
            fileInput.addEventListener('change', () => void onFilesSelected(fileInput.files));
        }

        // Voice
        setupVoiceInput(document.getElementById('mic-btn'));

        // Send / input
        sendBtn.addEventListener('click', handleSend);
        messageInput.addEventListener('input', handleInputChange);
        messageInput.addEventListener('keydown', handleInputKeydown);

        // New chat
        newChatBtn.addEventListener('click', handleNewChat);

        // Sidebar
        sidebarToggle.addEventListener('click', toggleSidebar);
        document.addEventListener('click', e => {
            if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target !== sidebarToggle)
                sidebar.classList.remove('open');
        });

        // Suggestion chips
        document.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', () => {
                messageInput.value = chip.getAttribute('data-message');
                handleInputChange();
                handleSend();
            });
        });

        // Settings open/close
        if (settingsOpenBtn) settingsOpenBtn.addEventListener('click', openSettings);
        if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettings);
        if (settingsOverlay)  settingsOverlay.addEventListener('click', closeSettings);

        // Settings tabs
        document.querySelectorAll('.settings-tab').forEach(btn => {
            btn.addEventListener('click', () => switchSettingsTab(btn.getAttribute('data-tab')));
        });

        // Settings save
        if (settingsSaveBtn) settingsSaveBtn.addEventListener('click', saveSettings);

        // API key test
        var apiKeyTestBtn = document.getElementById('api-key-test-btn');
        if (apiKeyTestBtn) apiKeyTestBtn.addEventListener('click', testApiKey);

        // Security events
        var changePwBtn = document.getElementById('change-pw-btn');
        if (changePwBtn) changePwBtn.addEventListener('click', handleChangePassword);

        // Data
        var exportBtn = document.getElementById('export-data-btn');
        if (exportBtn) exportBtn.addEventListener('click', handleExportData);

        var deleteChatsBtn = document.getElementById('delete-chats-btn');
        if (deleteChatsBtn) deleteChatsBtn.addEventListener('click', handleDeleteAllChats);

        // Account
        var logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);

        var deleteAccBtn = document.getElementById('delete-account-btn');
        if (deleteAccBtn) deleteAccBtn.addEventListener('click', handleDeleteAccount);

        var saveNameBtn = document.getElementById('save-display-name-btn');
        if (saveNameBtn) saveNameBtn.addEventListener('click', handleSaveDisplayName);

        messageInput.focus();
    }

    // ─── Start ────────────────────────────────────────────────────
    init();
})();
