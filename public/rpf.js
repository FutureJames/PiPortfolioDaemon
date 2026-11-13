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
                    // a new folder is about to be listed (also when the server
                    // moves up from a missing folder): drop the old list and
                    // its "not found" state so neither carries over
                    startListLoading();
                    getFolder(msg.folder);
                    break;
                case 'dir':
                    populateFileList(msg);
                    break;
                case 'upload_result':
                    handleUploadResult(msg);
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
    document.getElementById('dir_container').classList.remove('is-missing', 'is-nocard');
    setListLoading(true);
}

///////////////////////////////////////////////////////////////////////////////
// lists all the files for the folder; `missing` means the folder doesn't
// exist on the Portfolio (shown as "Folder not found" instead of "No files"),
// `nocard` that the A: memory card is out (shown as "No card in A:\")
function populateFileList({ files = [], missing = false, nocard = false } = {}) {
    setListLoading(false);
    const container = document.getElementById('dir_container');
    container.classList.toggle('is-missing', missing === true);
    container.classList.toggle('is-nocard', nocard === true);
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

// Upload progress bar: counts the files of the current batch as the server
// reports each one reaching the Portfolio (or failing). Not a byte-level
// progress bar: rpfolio doesn't report that.
const uploadProgress = {
    total: 0,
    done: 0,
    failed: 0,
    pending: new Map(),     // file name -> how many of that name are still due
    hideTimer: null,
};

function renderUploadProgress() {
    const p = uploadProgress;
    const box = document.getElementById('upload_progress');
    const fill = document.getElementById('progress_fill');
    const text = document.getElementById('progress_text');
    const track = box.querySelector('.progress-track');
    box.classList.toggle('is-active', p.total > 0);
    box.classList.toggle('has-failures', p.failed > 0);
    fill.style.width = p.total ? `${(p.done / p.total) * 100}%` : '0%';
    track.setAttribute('aria-valuemax', String(p.total));
    track.setAttribute('aria-valuenow', String(p.done));
    if (p.total === 0) {
        text.innerHTML = '&nbsp;';
    } else if (p.done < p.total) {
        text.textContent = `Sending to the Portfolio: ${p.done} of ${p.total}` + (p.failed ? ` (${p.failed} failed)` : '');
    } else {
        const sent = p.total - p.failed;
        text.textContent = p.failed ? `${sent} of ${p.total} sent, ${p.failed} failed — see Activity` : `${sent} of ${p.total} sent`;
    }
}

// files the page has just handed to the server: wait for their results
function trackUploads(files) {
    const p = uploadProgress;
    clearTimeout(p.hideTimer);
    if (p.total > 0 && p.done === p.total) {
        // the previous batch had finished: start counting afresh
        Object.assign(p, { total: 0, done: 0, failed: 0 });
        p.pending.clear();
    }
    files.forEach(file => p.pending.set(file.name, (p.pending.get(file.name) || 0) + 1));
    p.total += files.length;
    renderUploadProgress();
}

// the server didn't take the files after all: stop waiting for them
function untrackUploads(files) {
    const p = uploadProgress;
    files.forEach(file => {
        const left = (p.pending.get(file.name) || 0) - 1;
        if (left > 0) p.pending.set(file.name, left); else p.pending.delete(file.name);
    });
    p.total = Math.max(0, p.total - files.length);
    renderUploadProgress();
    finishUploadsIfDone();
}

// one file finished on the server (ignores uploads from other pages or the shared folder)
function handleUploadResult({ file, ok }) {
    const p = uploadProgress;
    const left = p.pending.get(file) || 0;
    if (!left) return;
    if (left > 1) p.pending.set(file, left - 1); else p.pending.delete(file);
    p.done += 1;
    if (!ok) p.failed += 1;
    renderUploadProgress();
    finishUploadsIfDone();
}

function finishUploadsIfDone() {
    const p = uploadProgress;
    if (p.done < p.total) return;
    clearTimeout(p.hideTimer);
    // leave the summary up for a moment, then clear the bar
    p.hideTimer = setTimeout(() => {
        Object.assign(p, { total: 0, done: 0, failed: 0 });
        p.pending.clear();
        renderUploadProgress();
    }, p.failed ? 8000 : 4000);
}

// Upload box: files dropped on it are sent straight away; Choose files +
// Upload does the same for touch screens and keyboards. Several files can
// be sent at once. Uploads go in the background (no page reload); the
// progress bar and the activity log then show each file reaching the Portfolio.
function enableDropZone() {
    const dropZone = document.getElementById('drop_zone');
    const form = dropZone.querySelector('form');
    const fileInput = document.getElementById('filesToUpload');
    const submitButton = document.getElementById('file_submit');
    const fileName = document.getElementById('file_name');
    const hint = document.getElementById('drop_hint');
    const hintText = hint.textContent;
    const maxSizeInMB = 2;
    const maxSize = maxSizeInMB * 1024 * 1024;

    let selected = [];          // files chosen with Choose files, waiting for Upload
    let uploading = false;

    // keeps the files that can be sent; says which ones are skipped and why
    function sendable(files) {
        const ok = [];
        const tooBig = [];
        for (const file of files) (file.size > maxSize ? tooBig : ok).push(file);
        if (tooBig.length) {
            const names = tooBig.map(f => f.name).join(', ');
            showStatus(`${names} ${tooBig.length === 1 ? 'is' : 'are'} over ${maxSizeInMB} MB and won’t be sent`, 'info');
        }
        return ok;
    }

    function describe(files) {
        if (files.length === 1) return files[0].name;
        return `${files.length} files: ${files.map(f => f.name).join(', ')}`;
    }

    function showSelection(text) {
        fileName.textContent = text;
        submitButton.disabled = uploading || selected.length === 0;
    }

    async function uploadFiles(files) {
        if (files.length === 0) return;
        if (uploading) {
            showStatus('Please wait for the current upload to finish', 'info');
            return;
        }
        uploading = true;
        dropZone.classList.add('is-uploading');
        hint.textContent = `Uploading ${files.length === 1 ? files[0].name : files.length + ' files'}…`;
        showSelection('');

        // start counting before sending: results can arrive before the reply
        trackUploads(files);
        const data = new FormData();
        files.forEach(file => data.append('filesToUpload', file, file.name));
        let sent = false;
        try {
            const res = await fetch('/upload', { method: 'POST', body: data });
            sent = res.ok;
        } catch (error) {
            sent = false;
        }

        uploading = false;
        dropZone.classList.remove('is-uploading');
        hint.textContent = hintText;
        selected = [];
        fileInput.value = '';
        showSelection('');
        if (!sent) {
            untrackUploads(files);
            showStatus('Upload failed — check the connection to the Pi and try again', 'info');
        }
    }

    // Choose files: show what was picked and enable Upload
    fileInput.addEventListener('change', () => {
        selected = sendable([...fileInput.files]);
        showSelection(selected.length ? describe(selected) : '');
    });

    // Upload button (or Enter): send the chosen files without reloading
    form.addEventListener('submit', (evt) => {
        evt.preventDefault();
        uploadFiles(selected);
    });

    dropZone.addEventListener('dragenter', (evt) => { evt.preventDefault(); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragover', (evt) => { evt.preventDefault(); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragleave', (evt) => {
        if (!dropZone.contains(evt.relatedTarget)) dropZone.classList.remove('over');
    });

    // Drop: send the files straight away
    dropZone.addEventListener('drop', (evt) => {
        // always stop the browser from opening the dropped files
        evt.preventDefault();
        dropZone.classList.remove('over');
        // take files from the drop items so folders can be told apart and skipped
        const items = [...(evt.dataTransfer.items || [])];
        let files = [];
        let folders = 0;
        if (items.length) {
            for (const item of items) {
                if (item.kind !== 'file') continue;
                const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                if (entry && entry.isDirectory) { folders++; continue; }
                const file = item.getAsFile();
                if (file) files.push(file);
            }
        } else {
            files = [...evt.dataTransfer.files];
        }
        if (folders) showStatus('Folders can’t be uploaded — drop the files inside them instead', 'info');
        uploadFiles(sendable(files));
    });

    showSelection('');
}

///////////////////////////////////////////////////////////////////////////////
