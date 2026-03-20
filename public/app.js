const socket = io();

const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: '"Cascadia Code", "Courier New", monospace',
    theme: { background: '#0d0d1a', foreground: '#c8c8d4', cursor: '#a0c4ff' },
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();

window.addEventListener('resize', () => {
    fitAddon.fit();
    socket.emit('resize', { cols: term.cols, rows: term.rows });
});

term.onData(data => socket.emit('input', data));
socket.on('output', data => term.write(data));

const SESSION_KEY = 'web3270_session';

socket.on('connected', ({ name, sessionId }) => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId, serverId: serverSelect.value, serverName: name }));
    setStatus(name, 'connected');
    setConnected(true);
    term.focus();
});

// Fired when the browser reconnects to an existing c3270 session after a page refresh.
socket.on('reconnected', ({ name, buffer }) => {
    setStatus(name, 'connected');
    term.clear();
    if (buffer) term.write(buffer);
    setConnected(true);
    term.focus();
});

socket.on('disconnected', () => {
    sessionStorage.removeItem(SESSION_KEY);
    setStatus('Disconnected', '');
    term.writeln('\r\n\x1b[33m--- Session ended ---\x1b[0m');
    setConnected(false);
});

socket.on('error', msg => {
    sessionStorage.removeItem(SESSION_KEY);
    setStatus(msg, 'error');
    setConnected(false);
});

const connectBtn    = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const statusEl      = document.getElementById('status');
const serverSelect  = document.getElementById('server-select');

function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls;
}

function setConnected(connected) {
    connectBtn.disabled = connected;
    disconnectBtn.disabled = !connected;
    serverSelect.disabled = connected;
}

function connectTo(id) {
    const name = serverSelect.querySelector(`option[value="${id}"]`)?.textContent ?? id;
    term.clear();
    setStatus(`Connecting to ${name}…`, 'connecting');
    setConnected(true);
    socket.emit('connect_to_mainframe', { id, cols: term.cols, rows: term.rows });
}

fetch('/api/init')
    .then(r => r.json())
    .then(({ servers, defaultServer }) => {
        serverSelect.innerHTML = servers.map(s =>
            `<option value="${s.id}">${s.name}</option>`
        ).join('');

        // Try to reattach to an existing session from a previous page load.
        const saved = sessionStorage.getItem(SESSION_KEY);
        if (saved) {
            try {
                const { sessionId, serverId, serverName } = JSON.parse(saved);
                if (serverId) serverSelect.value = serverId;
                setStatus(`Reconnecting to ${serverName}…`, 'connecting');
                setConnected(true);
                socket.emit('connect_to_mainframe', { id: serverId, sessionId, cols: term.cols, rows: term.rows });
                return;
            } catch {
                sessionStorage.removeItem(SESSION_KEY);
            }
        }

        if (defaultServer) connectTo(defaultServer);
    })
    .catch(() => {
        serverSelect.innerHTML = '<option value="">Failed to load servers</option>';
    });

connectBtn.addEventListener('click', () => {
    const id = serverSelect.value;
    if (id) connectTo(id);
});

disconnectBtn.addEventListener('click', () => {
    sessionStorage.removeItem(SESSION_KEY);
    socket.emit('connect_to_mainframe', null);
    setStatus('Disconnected', '');
    setConnected(false);
});
