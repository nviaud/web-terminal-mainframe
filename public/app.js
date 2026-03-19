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

socket.on('connected', name => {
    setStatus(name, 'connected');
    term.focus();
});

socket.on('disconnected', () => {
    setStatus('Disconnected', '');
    term.writeln('\r\n\x1b[33m--- Session ended ---\x1b[0m');
    setConnected(false);
    showForm();
});

socket.on('error', msg => {
    setStatus(msg, 'error');
    setConnected(false);
    showForm();
});

const connectBtn    = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const statusEl      = document.getElementById('status');
const serverSelect  = document.getElementById('server-select');

function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls;
}

function showForm() {
    document.getElementById('connect-form').classList.remove('hidden');
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
        if (defaultServer) {
            document.getElementById('connect-form').classList.add('hidden');
            connectTo(defaultServer);
        }
    })
    .catch(() => {
        serverSelect.innerHTML = '<option value="">Failed to load servers</option>';
    });

connectBtn.addEventListener('click', () => {
    const id = serverSelect.value;
    if (id) connectTo(id);
});

disconnectBtn.addEventListener('click', () => {
    socket.emit('connect_to_mainframe', null);
    setStatus('Disconnected', '');
    setConnected(false);
});
