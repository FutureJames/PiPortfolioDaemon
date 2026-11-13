///////////////////////////////////////////////////////////////////////////////

let debug = false;

let ws = null;                  // the current WebSocket, or null
let reconnectTimer = null;
let reconnectDelay = 1000;      // grows to RECONNECT_MAX while the server is down
const RECONNECT_MAX = 10000;
let statusHideTimer = null;     // declared before startup: showStatus() uses it

///////////////////////////////////////////////////////////////////////////////

if (typeof window.WebSocket === 'undefined') {
    showStatus('This browser does not support WebSockets.', 'error');
} else {
    connectWebSocket();
    // after sleep, backgrounding or a network change the connection may be
    // gone, or dead while still looking open: check it on return
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkConnection();
    });
    window.addEventListener('online', checkConnection);
}
enableDropZone();
enableHelp();

///////////////////////////////////////////////////////////////////////////////
// Help panel: opens from the Activity header; closes with Close, Esc
// (built into <dialog>) or a click outside the panel

function enableHelp() {
    const dialog = document.getElementById('help_dialog');
    const openButton = document.getElementById('help_open');
    if (!dialog || !openButton) return;
    openButton.addEventListener('click', () => dialog.showModal());
    document.getElementById('help_close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();    // the backdrop area
    });
}


///////////////////////////////////////////////////////////////////////////////
// connection status message (bottom of the page)

// kind: 'warn' (stays until cleared), 'error' (stays), 'ok' / 'info' (fade out)
function showStatus(text, kind = 'warn') {
    const el = document.getElementById('conn_status');
    if (!el) return;
    clearTimeout(statusHideTimer);
    el.textContent = text;
    el.dataset.kind = kind;
    el.hidden = false;
    if (kind === 'ok' || kind === 'info') {
        statusHideTimer = setTimeout(hideStatus, kind === 'ok' ? 2000 : 6000);
    }
}

function hideStatus() {
    const el = document.getElementById('conn_status');
    if (el) el.hidden = true;
}

///////////////////////////////////////////////////////////////////////////////
// WebSocket connection with automatic reconnect

function isConnected() {
    return ws !== null && ws.readyState === WebSocket.OPEN;
}

// sends a command if connected; returns false (and says so) if not
function sendMessage(message) {
    if (!isConnected()) {
        showStatus('Not connected to the server — reconnecting…');
        return false;
    }
    ws.send(JSON.stringify(message));
    return true;
}

function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWebSocket, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
}

function reconnectNow() {
    clearTimeout(reconnectTimer);
    reconnectDelay = 1000;
    connectWebSocket();
}

// Liveness check: a socket can look OPEN after sleep or a network change
// while the connection is actually dead. Ping the server and replace the
// socket if no pong arrives in time. The timeout is generous because the
// server can't answer while it is busy with a Portfolio transfer.
const PING_TIMEOUT = 10000;
let pingId = 0;
let pendingPing = null;     // { id, timer } while waiting for a pong

function checkConnection() {
    if (!isConnected()) {
        reconnectNow();
        return;
    }
    if (pendingPing) return;    // a check is already running
    const id = ++pingId;
    pendingPing = { id, timer: setTimeout(replaceDeadSocket, PING_TIMEOUT) };
    ws.send(JSON.stringify({ command: 'ping', id }));
}

function clearPendingPing() {
    if (pendingPing) clearTimeout(pendingPing.timer);
    pendingPing = null;
}

// drops the current socket without waiting for it to close, and reconnects
function replaceDeadSocket() {
    clearPendingPing();
    const old = ws;
    ws = null;              // from here on the old socket's events are ignored
    try { if (old) old.close(); } catch (e) { /* already closed */ }
    showStatus('Connection to the server lost — reconnecting…');
    reconnectNow();
}

function connectWebSocket() {
    // don't open a second connection while one is open or opening
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    let wasOpen = false;
    const socket = new WebSocket(`ws://${location.host}`);
    ws = socket;

    socket.addEventListener('open', () => {
        if (ws !== socket) return;      // replaced while connecting
        wasOpen = true;
        const reconnected = reconnectDelay > 1000 || document.getElementById('conn_status').hidden === false;
        reconnectDelay = 1000;
        if (debug) console.log('Connected to server');
        // drop the old listing first: the server's folder may have changed
        // while we were away, and if the new listing fails, stale links
        // would download same-named files from the wrong folder
        startListLoading();
        // the server answers with the log, the current folder and its files
        socket.send(JSON.stringify({ command: 'page_loaded' }));
        initializeInputEvents();
        if (reconnected) showStatus('Reconnected', 'ok'); else hideStatus();
    });

    // a failed connect also fires 'close', which handles the retry
    socket.addEventListener('error', () => {
        if (debug) console.log('WebSocket error');
    });

    socket.addEventListener('close', () => {
        if (ws !== socket) return;      // an older socket; already replaced
        ws = null;
        clearPendingPing();
        setListLoading(false);          // no listing is coming on this socket
        showStatus(wasOpen ? 'Connection to the server lost — reconnecting…'
                           : 'Can’t reach the server — retrying…');
        scheduleReconnect();
    });

    socket.addEventListener('message', (event) => {
            if (ws !== socket) return;  // late message from a replaced socket
            const msg = JSON.parse(event.data);
            if (debug) console.log(msg);

            switch (msg.command) {
                case 'pong':
                    if (pendingPing && msg.id === pendingPing.id) clearPendingPing();
                    break;
                case 'add_to_log':
                    updateLog(msg.data);
                    break;
                case 'set_log':
                    setLog(msg.data);
                    break;
                case 'set_folder':
                    getFolder(msg.folder);
                    break;
                case 'dir':
                    populateFileList(msg);
                    break;
                case 'pofo_error':
                    setListLoading(false);  // the listing failed; none is coming
                    showStatus('No connection to the Atari Portfolio — is it in server mode?', 'info');
                    break;
                default:
                    if (debug) console.log('Unknown message', msg);
                    break;
            }
    });
}
///////////////////////////////////////////////////////////////////////////////

// The Portfolio has two drives: A:\ (removable card) and C:\ (RAM disk).
const DRIVES = {
    'a:\\': 'Removable card',
    'c:\\': 'RAM disk',
};
let currentDrive = 'c:\\';
let currentPath = 'c:\\';       // full folder being listed, e.g. 'c:\GAMES\SAVES\'

function initializeInputEvents() {
    // set up once, even though the WebSocket may reconnect
    if (initializeInputEvents.done) return;
    initializeInputEvents.done = true;

    const toggle = document.getElementById('drive_toggle');
    const options = Array.from(toggle.querySelectorAll('[role="radio"]'));

    // switching drives goes to that drive's root
    // only clear the folder field once the server has the request
    const choose = (drive) => {
        if (drive !== currentDrive && sendFolder(drive)) {
            document.getElementById('current_folder').value = '';
        }
    };

    // directory field: Enter or Open lists that folder on the current drive
    const folderInput = document.getElementById('current_folder');
    folderInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            openFolder();
        }
    });
    document.getElementById('folder_open').addEventListener('click', openFolder);
    document.getElementById('dir_up').addEventListener('click', goUp);

    options.forEach((option, i) => {
        option.addEventListener('click', () => choose(option.dataset.drive));
        // arrow keys move between the two drives, like a radio group
        option.addEventListener('keydown', (event) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                event.preventDefault();
                const next = options[(i + 1) % options.length];
                choose(next.dataset.drive);
                next.focus();
            }
        });
    });

    showDrive(currentDrive);
}

///////////////////////////////////////////////////////////////////////////////
// shows the folder the server is using (sent as e.g. 'c:\' or 'c:\TESTDIR\')
function getFolder(folder) {
    folder = folder || '';
    const drive = folder.slice(0, 2).toLowerCase() + '\\';
    if (DRIVES[drive]) {
        currentDrive = drive;
        showDrive(drive);
        // the part after the drive, without the trailing backslash
        document.getElementById('current_folder').value = folder.slice(3).replace(/\\+$/, '');
        setCurrentPath(folder);
    }
}

///////////////////////////////////////////////////////////////////////////////
// up-one-level row at the top of the file list

// the folders below the drive, e.g. 'c:\GAMES\SAVES\' -> ['GAMES', 'SAVES']
function pathParts(path) {
    return path.slice(3).split('\\').filter(Boolean);
}

function setCurrentPath(path) {
    currentPath = path.slice(0, 3).toLowerCase() + path.slice(3);
    const parts = pathParts(currentPath);
    const up = document.getElementById('dir_up');
    up.hidden = parts.length === 0;     // nothing above a drive's root
    if (!up.hidden) {
        const parent = currentPath.slice(0, 3) + parts.slice(0, -1).map(p => p + '\\').join('');
        document.getElementById('dir_up_target').textContent = parent.toUpperCase();
        up.title = `Up to ${parent.toUpperCase()}`;
    }
}

// opens the parent of the current folder
function goUp() {
    const parentParts = pathParts(currentPath).slice(0, -1);
    const parent = currentPath.slice(0, 3) + parentParts.map(p => p + '\\').join('');
    if (sendFolder(parent)) {
        document.getElementById('current_folder').value = parentParts.join('\\');
    }
}

// lists the directory typed in the field (blank = drive root)
function openFolder() {
    const name = document.getElementById('current_folder').value
        .trim()
        .replace(/\//g, '\\')           // accept / as well as \
        .replace(/^\\+|\\+$/g, '');     // the drive prefix supplies the leading \
    sendFolder(currentDrive + (name ? name + '\\' : ''));
}

function showDrive(drive) {
    const toggle = document.getElementById('drive_toggle');
    toggle.dataset.drive = drive;   // moves the thumb (see styles.css)
    toggle.querySelectorAll('[role="radio"]').forEach(option => {
        const selected = option.dataset.drive === drive;
        option.setAttribute('aria-checked', String(selected));
        option.tabIndex = selected ? 0 : -1;
    });
    document.getElementById('path_prefix').textContent = drive.toUpperCase();
}

///////////////////////////////////////////////////////////////////////////////

function clearFileList() {
    const fileList = document.getElementById('file_list');
    fileList.innerHTML = '';
}

///////////////////////////////////////////////////////////////////////////////
// Loading state for the file list: hides "No files" and shows a spinner
// until the listing (or an error) arrives. The timeout is a safety net so
// the spinner can't get stuck if no reply ever comes.
const LIST_LOADING_TIMEOUT = 30000;
let listLoadingTimer = null;

function setListLoading(loading) {
    clearTimeout(listLoadingTimer);
    document.getElementById('dir_container').classList.toggle('is-loading', loading);
    if (loading) listLoadingTimer = setTimeout(() => setListLoading(false), LIST_LOADING_TIMEOUT);
}

// empties the list and shows the spinner while a new listing is fetched
function startListLoading() {
    clearFileList();
    document.getElementById('dir_container').classList.remove('is-missing');
    setListLoading(true);
}

///////////////////////////////////////////////////////////////////////////////
// lists all the files for the folder; `missing` means the folder doesn't
// exist on the Portfolio (shown as "Folder not found" instead of "No files")
function populateFileList({ files = [], missing = false } = {}) {
    setListLoading(false);
    document.getElementById('dir_container').classList.toggle('is-missing', missing === true);
    const fileList = document.getElementById('file_list');
    fileList.innerHTML = '';
    if (files === false) return;
    files.forEach(file => {
        const listItem = document.createElement('li');
        const link = document.createElement('a');
        link.href = `/download/${file}`;
        link.textContent = file;
        listItem.appendChild(link);
        fileList.appendChild(listItem);
    });
}

///////////////////////////////////////////////////////////////////////////////
// adds an entry to the upload log
function updateLog(data) {
    const log = document.getElementById('log');
    log.value += data;
    log.scrollTop = log.scrollHeight;
}

///////////////////////////////////////////////////////////////////////////////
// replaces the whole log (sent by the server on page load and on clear)
function setLog(data) {
    const log = document.getElementById('log');
    log.value = data || '';
    log.scrollTop = log.scrollHeight;
}

///////////////////////////////////////////////////////////////////////////////
// asks the server to clear the log for every open page
function clearLog() {
    sendMessage({ command: 'clear_log' });
}

///////////////////////////////////////////////////////////////////////////////
// asks the server to switch to another folder (e.g. 'a:\' or 'c:\TESTDIR\')
// returns false (changing nothing on the page) if not connected
function sendFolder(folder) {
    if (!sendMessage({ command: 'set_folder', folder })) return false;
    currentDrive = folder.slice(0, 3).toLowerCase();
    showDrive(currentDrive);
    setCurrentPath(folder);
    startListLoading();
    return true;
}

///////////////////////////////////////////////////////////////////////////////

function enableDropZone() {
    let dropZone = document.getElementById('drop_zone');
    let fileInput = document.getElementById('filesToUpload');
    let maxSizeInMB = 2; // Maximum size allowed in MB
    let maxSize = maxSizeInMB * 1024 * 1024; // Convert size to bytes

    dropZone.ondragover = dropZone.ondragenter = function(evt) {
        evt.preventDefault();
        this.classList.add('over'); 
    };

    let submitButton = document.getElementById('file_submit');
    let fileName = document.getElementById('file_name');

    // shows the chosen file and enables Upload only for a valid file
    function updateSelection() {
        const file = fileInput.files[0];
        if (file && file.size > maxSize) {
            alert('File size should not exceed ' + maxSizeInMB + ' MB');
            fileInput.value = '';
        }
        const chosen = fileInput.files[0];
        fileName.textContent = chosen ? chosen.name : '';
        submitButton.disabled = !chosen;
    }

    dropZone.ondrop = function(evt) {
        // always stop the browser from opening the dropped file
        evt.preventDefault();
        this.classList.remove('over');
        if (!evt.dataTransfer.files.length) return;
        fileInput.files = evt.dataTransfer.files;
        updateSelection();
    };

    dropZone.ondragleave = function(evt) {
        if (!this.contains(evt.relatedTarget)) {
            this.classList.remove('over');
        }
    };

    fileInput.onchange = updateSelection;
    updateSelection();
}

///////////////////////////////////////////////////////////////////////////////
