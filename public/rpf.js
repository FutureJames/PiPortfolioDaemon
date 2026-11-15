///////////////////////////////////////////////////////////////////////////////

let debug = false;

let ws = null;                  // the current WebSocket, or null
let reconnectTimer = null;
let reconnectDelay = 1000;      // grows to RECONNECT_MAX while the server is down
const RECONNECT_MAX = 10000;
let statusHideTimer = null;     // declared before startup: showStatus() uses it

// sent with each upload and download; the server tags progress and results
// with it so this page only shows its own (not crypto.randomUUID: that needs https)
const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
enableDownloadAll();
enableAskDialog();
enableServerControls();

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
    abandonUploads();
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
        abandonUploads();
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
                    portfolioAnswering();
                    break;
                case 'status':
                    showVersions(msg);
                    break;
                case 'notice':
                    showStatus(msg.text, 'info');
                    break;
                case 'download_progress':
                    handleDownloadProgress(msg);
                    break;
                case 'upload_progress':
                    handleUploadProgress(msg);
                    break;
                case 'upload_result':
                    handleUploadResult(msg);
                    break;
                case 'pofo_error':
                    if (msg.offline === false) portfolioReportedError(msg.reason);
                    else portfolioNotAnswering(msg.reason);
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
    document.getElementById('folder_new').addEventListener('click', newFolder);
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
    listing = { entries: [], full: false };
    showDownloadAll(false);
    showFreeSpace(null);
}

///////////////////////////////////////////////////////////////////////////////
// The Portfolio isn't answering: the message stays up and the list says so
// (rather than "No files") until a listing arrives. The server checks again
// by itself and sends the files when the Portfolio is back.
let portfolioOffline = false;

function portfolioNotAnswering(reason = '') {
    portfolioOffline = true;
    setListLoading(false);      // the listing failed; none is coming
    clearFileList();
    document.getElementById('dir_container').classList.remove('is-missing', 'is-nocard');
    document.getElementById('dir_container').classList.add('is-offline');
    const detail = reason.replace(/^\(|\)$/g, '');
    showStatus(/no connection/i.test(reason) || !detail
        ? 'No connection to the Atari Portfolio — is it in server mode? Checking again every few seconds…'
        : `Atari Portfolio: ${detail}`, 'error');
}

// it answered but reported an error (e.g. a protocol error): show it, stop
// the spinner, and leave the list as it was; this isn't a lost connection
function portfolioReportedError(reason = '') {
    setListLoading(false);
    // it did answer, so it is connected again
    portfolioOffline = false;
    document.getElementById('dir_container').classList.remove('is-offline');
    const detail = reason.replace(/^\(|\)$/g, '');
    showStatus(detail ? `Atari Portfolio reported an error: ${detail}` : 'Atari Portfolio reported an error', 'info');
}

function portfolioAnswering() {
    document.getElementById('dir_container').classList.remove('is-offline');
    if (!portfolioOffline) return;
    portfolioOffline = false;
    showStatus('Atari Portfolio connected', 'ok');
}

///////////////////////////////////////////////////////////////////////////////
// Loading state for the file list: hides "No files" and shows a spinner
// until the listing (or an error) arrives. The timeout is a safety net so
// the spinner can't get stuck if no reply ever comes. It is long because a
// listing waits for any transfer already under way (a big upload can take
// minutes at about 1 KB a second).
const LIST_LOADING_TIMEOUT = 5 * 60000;
let listLoadingTimer = null;

function setListLoading(loading) {
    clearTimeout(listLoadingTimer);
    document.getElementById('dir_container').classList.toggle('is-loading', loading);
    if (loading) listLoadingTimer = setTimeout(() => setListLoading(false), LIST_LOADING_TIMEOUT);
}

// empties the list and shows the spinner while a new listing is fetched
function startListLoading() {
    clearFileList();
    document.getElementById('dir_container').classList.remove('is-missing', 'is-nocard', 'is-offline');
    setListLoading(true);
}

///////////////////////////////////////////////////////////////////////////////
// The folder's listing. With the built-in server (or the original rpfolio)
// it has only the file names. With PortfolioServer (`full`) it has folders
// too, listed first (clicking one opens it), and each entry's size, date and
// attributes; hidden and system files are shown dimmed and can't be
// downloaded (the Portfolio won't send them), and each entry has a delete
// button. `missing` means the folder doesn't exist on the Portfolio (shown as
// "Folder not found" instead of "No files"), `nocard` that the A: memory card
// is out (shown as "No card in A:\").
let listing = { entries: [], full: false };

// files that can be downloaded (all of them, without the details)
function downloadableFiles() {
    return listing.entries.filter(e => !e.folder && !e.hidden && !e.system);
}

const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">'
    + '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

// "2005-01-01" -> "1 Jan 2005"
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatDate(date) {
    const [y, m, d] = date.split('-').map(Number);
    return `${d} ${MONTHS[m - 1] || '?'} ${y}`;
}

function populateFileList({ entries, files = [], full = false, free = null, missing = false, nocard = false } = {}) {
    setListLoading(false);
    const container = document.getElementById('dir_container');
    container.classList.toggle('is-missing', missing === true);
    container.classList.toggle('is-nocard', nocard === true);
    container.classList.toggle('is-full', full === true);
    const fileList = document.getElementById('file_list');
    fileList.innerHTML = '';
    // an older server sends just the names
    listing = { entries: entries || files.map(name => ({ name })), full: full === true };
    showFreeSpace(free);
    showDownloadAll(downloadableFiles().length > 0);
    listing.entries.forEach(entry => fileList.appendChild(full ? fullRow(entry) : plainRow(entry.name)));
}

// a file name that downloads the file (the built-in server's listing)
function plainRow(name) {
    const listItem = document.createElement('li');
    const link = downloadLink(name);
    link.textContent = name;
    listItem.appendChild(link);
    return listItem;
}

function downloadLink(name) {
    const link = document.createElement('a');
    link.className = 'entry-main';
    link.href = `/download/${encodeURIComponent(name)}`;
    link.dataset.name = name;
    link.addEventListener('click', downloadFile);
    return link;
}

// a row of PortfolioServer's listing: name, size, date, delete button
function fullRow(entry) {
    const listItem = document.createElement('li');
    listItem.className = 'entry';
    const marks = [entry.readonly && 'r', entry.hidden && 'h', entry.system && 's'].filter(Boolean);
    let main;
    if (entry.folder) {
        listItem.classList.add('is-folder');
        main = document.createElement('button');
        main.type = 'button';
        main.className = 'entry-main';
        main.title = `Open ${entry.name}`;
        main.addEventListener('click', () => openSubfolder(entry.name));
    } else if (entry.hidden || entry.system) {
        // the Portfolio treats these as missing when asked for them
        listItem.classList.add('is-hidden');
        main = document.createElement('span');
        main.className = 'entry-main';
        main.title = `${entry.hidden ? 'Hidden' : 'System'} file: the Portfolio won’t send it, so it can’t be downloaded`;
    } else {
        main = downloadLink(entry.name);
    }
    if (entry.folder) main.insertAdjacentHTML('beforeend', `<span class="entry-icon">${FOLDER_ICON}</span>`);
    const name = document.createElement('span');
    name.className = 'entry-name';
    name.textContent = entry.name;
    main.appendChild(name);
    marks.forEach(mark => {
        const badge = document.createElement('span');
        badge.className = 'entry-mark';
        badge.textContent = mark;
        badge.title = { r: 'read-only', h: 'hidden', s: 'system' }[mark];
        main.appendChild(badge);
    });
    const size = document.createElement('span');
    size.className = 'entry-size';
    size.textContent = entry.folder ? '' : formatBytes(entry.size);
    const date = document.createElement('span');
    date.className = 'entry-date';
    date.textContent = formatDate(entry.date);
    date.title = `${entry.date} ${entry.time}`;
    main.append(size, date);
    listItem.appendChild(main);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'entry-delete';
    remove.innerHTML = TRASH_ICON;
    const what = entry.folder ? `folder ${entry.name}` : entry.name;
    remove.title = `Delete ${what}`;
    remove.setAttribute('aria-label', `Delete ${what}`);
    remove.addEventListener('click', () => (entry.folder ? askRemoveFolder(entry) : askDeleteFile(entry)));
    listItem.appendChild(remove);
    return listItem;
}

// opens a folder shown in the list
function openSubfolder(name) {
    const parts = [...pathParts(currentPath), name];
    if (sendFolder(currentPath + name + '\\')) {
        document.getElementById('current_folder').value = parts.join('\\');
    }
}

// "C: 22,016 of 31,232 bytes free" under the drive toggle (PortfolioServer only)
let freeSpace = null;
function showFreeSpace(free) {
    freeSpace = free;
    const el = document.getElementById('free_space');
    el.hidden = !free;
    if (!free) return;
    const n = (bytes) => bytes.toLocaleString('en-US');
    el.textContent = `${free.drive.slice(0, 2).toUpperCase()} ${n(free.free)} of ${n(free.total)} bytes free`;
    el.classList.toggle('is-low', free.free < 4096);
}

///////////////////////////////////////////////////////////////////////////////
// Download progress: while rpfolio receives a file it counts the bytes, and
// the server passes that on a few times a second, tagged with this page and
// the download's id. Each running download registers a function here that
// shows it.
const downloadWatchers = new Map();     // download id -> function(progress)
let nextDownloadId = 1;

// a download's id and the query string that asks the server for its progress
function newDownload(onProgress) {
    const id = String(nextDownloadId++);
    downloadWatchers.set(id, onProgress);
    return { id, query: `page=${encodeURIComponent(PAGE_ID)}&request=${id}` };
}

function handleDownloadProgress(msg) {
    if (msg.owner !== PAGE_ID) return;
    const watcher = downloadWatchers.get(msg.request);
    if (watcher) watcher(msg);
}

// how far through a file, from 0 to 1 (0 while its size isn't known yet)
function fileFraction({ received, size }) {
    return size > 0 ? Math.min(1, received / size) : 0;
}

// e.g. "3.0 KB of 57.6 KB"; "3.0 KB of ~84.0 KB" while the size is only an
// estimate (rpfolio without the file size patch, for a file over one block)
function describeDownload({ received, size, estimated }) {
    if (size === null) return formatBytes(received);
    return `${formatBytes(received)} of ${estimated ? '~' : ''}${formatBytes(size)}`;
}

///////////////////////////////////////////////////////////////////////////////
// Downloads a file in the background, so a failure shows a message instead of
// leaving the page for an error page. The link fills up and shows how much
// has arrived meanwhile (a transfer runs at about 1.5 KB a second).
async function downloadFile(event) {
    event.preventDefault();
    const link = event.currentTarget;
    if (link.classList.contains('is-downloading')) return;
    const name = link.dataset.name;
    link.classList.add('is-downloading');
    link.dataset.progress = 'Waiting…';
    link.style.setProperty('--progress', '0%');
    const download = newDownload((progress) => {
        link.style.setProperty('--progress', `${fileFraction(progress) * 100}%`);
        link.dataset.progress = describeDownload(progress);
    });
    try {
        const res = await fetch(`${link.href}?${download.query}`);
        if (!res.ok) {
            const text = (await res.text()).trim();
            // 503: the Portfolio isn't answering; keep the message up until
            // it is back (the list says "Portfolio not connected" meanwhile)
            showStatus(text ? `Download failed: ${text}` : `Download of ${name} failed`,
                res.status === 503 ? 'error' : 'info');
            return;
        }
        const url = URL.createObjectURL(await res.blob());
        const save = document.createElement('a');
        save.href = url;
        save.download = name;
        document.body.appendChild(save);
        save.click();
        save.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
        showStatus(`Download of ${name} failed — check the connection to the Pi`, 'info');
    } finally {
        downloadWatchers.delete(download.id);
        link.classList.remove('is-downloading');
        link.style.removeProperty('--progress');
        delete link.dataset.progress;
    }
}

///////////////////////////////////////////////////////////////////////////////
// Download all: every file in the folder being shown, as one .zip. The
// button sits in the lower right of the file list and only shows when the
// list has files. The page names the folder, so the server sends the one
// the user is looking at. While it runs, the button fills like a pie chart:
// each file is an equal share, or, with PortfolioServer's listing (which
// gives every file's size), its share of the bytes.
const DOWNLOAD_ALL_TITLE = 'Download all files in this folder (.zip)';

function showDownloadAll(show) {
    const button = document.getElementById('download_all');
    // keep a running download's button visible until it finishes
    if (!show && button.classList.contains('is-busy')) return;
    button.hidden = !show;
    button.parentElement.classList.toggle('has-download-all', show);
    if (button.classList.contains('is-busy')) return;
    const files = downloadableFiles();
    if (show && listing.full) {
        const bytes = files.reduce((sum, file) => sum + file.size, 0);
        const plural = files.length === 1 ? '' : 's';
        button.title = `Download ${files.length === 1 ? 'the' : `all ${files.length}`} file${plural} in this folder`
            + ` (${formatBytes(bytes)}) as a .zip`;
    } else {
        button.title = DOWNLOAD_ALL_TITLE;
    }
}

function enableDownloadAll() {
    const button = document.getElementById('download_all');
    const label = button.getAttribute('aria-label');
    const busyText = 'Downloading all files…';
    button.addEventListener('click', async () => {
        if (button.classList.contains('is-busy')) return;
        const folder = currentPath;
        // with PortfolioServer: each file's size, to share the progress by bytes
        const sizes = new Map(listing.full ? downloadableFiles().map(f => [f.name.toUpperCase(), f.size]) : []);
        const totalBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
        let doneBytes = 0;          // bytes of the files already received
        let lastIndex = 0;
        let lastSize = 0;
        button.classList.add('is-busy');
        button.style.setProperty('--progress', '0%');
        button.setAttribute('aria-label', busyText);
        button.title = `${busyText} (about 1.5 KB a second)`;
        const download = newDownload((progress) => {
            const { file, index, count } = progress;
            if (index !== lastIndex) {
                if (lastIndex) doneBytes += lastSize;
                lastIndex = index;
            }
            lastSize = progress.size || 0;
            let overall;
            if (totalBytes > 0 && sizes.has(file.toUpperCase())) {
                overall = (doneBytes + progress.received) / totalBytes;
            } else {
                overall = count ? (index - 1 + fileFraction(progress)) / count : fileFraction(progress);
            }
            overall = Math.min(1, overall);
            button.style.setProperty('--progress', `${overall * 100}%`);
            const of = count ? ` of ${count}` : '';
            const text = `Downloading file ${index}${of}: ${file}, ${describeDownload(progress)}`;
            button.title = text;
            button.setAttribute('aria-label', text);
        });
        try {
            const res = await fetch(`/download-all?folder=${encodeURIComponent(folder)}&${download.query}`);
            if (!res.ok) {
                const text = (await res.text()).trim();
                showStatus(text ? `Download failed: ${text}` : 'Download of all files failed',
                    res.status === 503 ? 'error' : 'info');
                return;
            }
            // the server names the .zip after the folder, e.g. GAMES.zip
            const disposition = res.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="?([^";]+)"?/);
            const url = URL.createObjectURL(await res.blob());
            const save = document.createElement('a');
            save.href = url;
            save.download = match ? match[1] : 'portfolio.zip';
            document.body.appendChild(save);
            save.click();
            save.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
        } catch (error) {
            showStatus('Download of all files failed — check the connection to the Pi', 'info');
        } finally {
            downloadWatchers.delete(download.id);
            button.classList.remove('is-busy');
            button.style.removeProperty('--progress');
            button.setAttribute('aria-label', label);
            // the list may have changed meanwhile
            showDownloadAll(downloadableFiles().length > 0);
        }
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

// Upload progress bar: follows the bytes of the current batch as the server
// reports them reaching the Portfolio. rpfolio counts every byte it sends;
// the server passes that on a few times a second for the file being sent,
// and says when each file has finished (or failed).
const uploadProgress = {
    total: 0,               // files in the batch
    done: 0,                // files finished (sent or failed)
    failed: 0,
    totalBytes: 0,
    doneBytes: 0,           // bytes of the finished files
    current: null,          // the file being sent: { file, sent, size }
    lost: false,            // the connection dropped before every result came
    pending: new Map(),     // file name -> sizes of the files of that name still due
    hideTimer: null,
};

function resetUploadProgress() {
    Object.assign(uploadProgress, {
        total: 0, done: 0, failed: 0, totalBytes: 0, doneBytes: 0, current: null, lost: false,
    });
    uploadProgress.pending.clear();
}

// e.g. "512 bytes", "3.4 KB"
function formatBytes(bytes) {
    if (bytes === 1) return '1 byte';
    return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
}

function renderUploadProgress() {
    const p = uploadProgress;
    const box = document.getElementById('upload_progress');
    const fill = document.getElementById('progress_fill');
    const text = document.getElementById('progress_text');
    const track = box.querySelector('.progress-track');
    box.classList.toggle('is-active', p.total > 0);
    box.classList.toggle('has-failures', p.failed > 0 || p.lost);
    let fraction = 0;
    if (p.done >= p.total && p.total > 0) {
        fraction = 1;
    } else if (p.totalBytes > 0) {
        fraction = (p.doneBytes + (p.current ? p.current.sent : 0)) / p.totalBytes;
    } else if (p.total > 0) {
        fraction = p.done / p.total;    // only empty files
    }
    const percent = Math.min(100, Math.floor(fraction * 100));
    fill.style.width = `${percent}%`;
    track.setAttribute('aria-valuenow', String(percent));
    const failed = p.failed ? ` (${p.failed} failed)` : '';
    const which = p.total > 1 ? ` · file ${p.done + 1} of ${p.total}` : '';
    if (p.total === 0) {
        text.innerHTML = '&nbsp;';
    } else if (p.lost) {
        text.textContent = `Connection lost after ${p.done} of ${p.total} — see Activity for the rest`;
    } else if (p.done < p.total && p.current) {
        const { file, sent, size } = p.current;
        text.textContent = `Sending ${file}: ${formatBytes(sent)} of ${formatBytes(size)}${which}${failed}`;
    } else if (p.done < p.total) {
        text.textContent = `Waiting for the Portfolio…${which}${failed}`;
    } else {
        const sent = p.total - p.failed;
        text.textContent = p.failed ? `${sent} of ${p.total} sent, ${p.failed} failed — see Activity` : `${sent} of ${p.total} sent`;
    }
}

// files the page has just handed to the server: wait for their results
function trackUploads(files) {
    const p = uploadProgress;
    clearTimeout(p.hideTimer);
    if (p.total > 0 && (p.done === p.total || p.lost)) {
        // the previous batch had finished (or was given up): start counting afresh
        resetUploadProgress();
    }
    files.forEach(file => {
        const sizes = p.pending.get(file.name) || [];
        sizes.push(file.size);
        p.pending.set(file.name, sizes);
    });
    p.total += files.length;
    p.totalBytes += files.reduce((sum, file) => sum + file.size, 0);
    renderUploadProgress();
}

// the server didn't take the files after all: stop waiting for them
function untrackUploads(files) {
    const p = uploadProgress;
    if (p.lost) return;     // already given up on this batch
    files.forEach(file => {
        const sizes = p.pending.get(file.name);
        if (!sizes) return;
        sizes.pop();
        if (sizes.length === 0) p.pending.delete(file.name);
        p.total = Math.max(0, p.total - 1);
        p.totalBytes = Math.max(0, p.totalBytes - file.size);
    });
    renderUploadProgress();
    finishUploadsIfDone();
}

// how far the file being sent has got (ignores uploads from other pages)
function handleUploadProgress({ file, sent, size, owner }) {
    const p = uploadProgress;
    if (owner !== PAGE_ID || p.lost) return;
    const sizes = p.pending.get(file);
    if (!sizes) return;
    // the size this page counted for it (the same file, so normally the same)
    const ownSize = sizes[0];
    const ownSent = size > 0 ? Math.round((sent / size) * ownSize) : 0;
    p.current = { file, sent: ownSent, size: ownSize };
    renderUploadProgress();
}

// one file finished on the server (ignores uploads from other pages or the shared folder)
function handleUploadResult({ file, ok, owner }) {
    const p = uploadProgress;
    if (owner !== PAGE_ID || p.lost) return;
    const sizes = p.pending.get(file);
    if (!sizes) return;
    p.doneBytes += sizes.shift();
    if (sizes.length === 0) p.pending.delete(file);
    if (p.current && p.current.file === file) p.current = null;
    p.done += 1;
    if (!ok) p.failed += 1;
    renderUploadProgress();
    finishUploadsIfDone();
}

function finishUploadsIfDone() {
    const p = uploadProgress;
    if (p.done < p.total && !p.lost) return;
    clearTimeout(p.hideTimer);
    // leave the summary up for a moment, then clear the bar
    p.hideTimer = setTimeout(() => {
        resetUploadProgress();
        renderUploadProgress();
    }, p.failed || p.lost ? 8000 : 4000);
}

// The connection dropped: results sent meanwhile are lost and aren't replayed,
// so stop waiting for them. The activity log, reloaded on reconnect, has them.
function abandonUploads() {
    const p = uploadProgress;
    if (p.total === 0 || p.done >= p.total || p.lost) return;
    p.lost = true;
    p.current = null;
    p.pending.clear();
    renderUploadProgress();
    finishUploadsIfDone();
}

// With PortfolioServer the free space is known: warn before an upload that
// won't fit (files of the same names are replaced, so their space counts as
// free). DOS stores files in whole clusters, so this is a little generous.
async function roomFor(files) {
    if (!freeSpace || !listing.full || freeSpace.drive !== currentDrive) return true;
    const replaced = new Map(listing.entries.filter(e => !e.folder).map(e => [e.name.toUpperCase(), e.size]));
    const needed = files.reduce((sum, file) => sum + file.size - (replaced.get(file.name.toUpperCase()) || 0), 0);
    if (needed <= freeSpace.free) return true;
    const drive = currentDrive.toUpperCase();
    const ok = await ask({
        title: 'Not enough space',
        text: `${files.length === 1 ? files[0].name : `These ${files.length} files`} need ${formatBytes(needed)}, `
            + `but ${drive} has only ${formatBytes(freeSpace.free)} free. Upload anyway?`,
        ok: 'Upload anyway',
    });
    return ok === true;
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
    const MAX_FILES_PER_UPLOAD = 20;    // matches the server's limit per request
    const maxSize = maxSizeInMB * 1024 * 1024;

    let selected = [];          // files chosen with Choose files, waiting for Upload
    let uploading = false;

    // keeps the files that can be sent; says which ones are skipped and why
    function sendable(files) {
        const ok = [];
        const tooBig = [];
        const repeated = new Set();
        const names = new Set();
        for (const file of files) {
            if (file.size > maxSize) { tooBig.push(file); continue; }
            // one file per name: same-named files (from different folders)
            // would overwrite each other on the Pi and the Portfolio anyway
            if (names.has(file.name)) { repeated.add(file.name); continue; }
            names.add(file.name);
            ok.push(file);
        }
        const notes = [];
        if (tooBig.length) {
            const list = tooBig.map(f => f.name).join(', ');
            notes.push(`${list} ${tooBig.length === 1 ? 'is' : 'are'} over ${maxSizeInMB} MB and won’t be sent`);
        }
        if (repeated.size) {
            notes.push(`only one file named ${[...repeated].join(', ')} will be sent`);
        }
        if (notes.length) {
            const text = notes.join('; ');
            showStatus(text.charAt(0).toUpperCase() + text.slice(1), 'info');
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
        if (!(await roomFor(files))) return;
        uploading = true;
        dropZone.classList.add('is-uploading');
        hint.textContent = `Uploading ${files.length === 1 ? files[0].name : files.length + ' files'}…`;
        showSelection('');

        // start counting before sending: results can arrive before the reply
        trackUploads(files);
        // the server takes up to MAX_FILES_PER_UPLOAD files per request:
        // send bigger batches in groups, one after another
        let sent = true;
        for (let i = 0; i < files.length; i += MAX_FILES_PER_UPLOAD) {
            const group = files.slice(i, i + MAX_FILES_PER_UPLOAD);
            const data = new FormData();
            data.append('page', PAGE_ID);   // before the files: the server reads it first
            group.forEach(file => data.append('filesToUpload', file, file.name));
            try {
                const res = await fetch('/upload', { method: 'POST', body: data });
                sent = res.ok;
            } catch (error) {
                sent = false;
            }
            if (!sent) {
                untrackUploads(files.slice(i));     // this group and the ones not sent yet
                break;
            }
        }

        uploading = false;
        dropZone.classList.remove('is-uploading');
        hint.textContent = hintText;
        selected = [];
        fileInput.value = '';
        showSelection('');
        if (!sent) {
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
// Questions in a small dialog: confirm a delete, name a new folder.
// ask() resolves with true (or the text typed) on OK, null on Cancel or Esc.

let askResolve = null;
let askValidate = null;

function enableAskDialog() {
    const dialog = document.getElementById('ask_dialog');
    const input = document.getElementById('ask_input');
    const error = document.getElementById('ask_error');
    dialog.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault();
        let answer = true;
        if (!document.getElementById('ask_field').hidden) {
            answer = input.value.trim();
            const problem = askValidate ? askValidate(answer) : '';
            if (problem) {
                error.textContent = problem;
                input.focus();
                return;
            }
        }
        finishAsk(answer);
    });
    document.getElementById('ask_cancel').addEventListener('click', () => finishAsk(null));
    // Esc closes the dialog by itself
    dialog.addEventListener('close', () => finishAsk(null));
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) finishAsk(null);   // the backdrop area
    });
    input.addEventListener('input', () => { error.textContent = ''; });
}

function finishAsk(answer) {
    const dialog = document.getElementById('ask_dialog');
    const resolve = askResolve;
    askResolve = null;
    if (dialog.open) dialog.close();
    if (resolve) resolve(answer);
}

/**
 * @param {object} question - { title, text, ok: button label, danger: red OK
 *   button, input: { label, prefix, validate(text) -> problem or '' } }
 * @returns {Promise<true|string|null>}
 */
function ask({ title, text, ok = 'OK', danger = false, input = null }) {
    finishAsk(null);        // only one question at a time
    const dialog = document.getElementById('ask_dialog');
    document.getElementById('ask_title').textContent = title;
    document.getElementById('ask_text').textContent = text || '';
    document.getElementById('ask_text').hidden = !text;
    document.getElementById('ask_error').textContent = '';
    const okButton = document.getElementById('ask_ok');
    okButton.textContent = ok;
    okButton.classList.toggle('is-danger', danger);
    const field = document.getElementById('ask_field');
    field.hidden = !input;
    askValidate = input ? input.validate : null;
    const textBox = document.getElementById('ask_input');
    if (input) {
        document.getElementById('ask_label').textContent = input.label;
        document.getElementById('ask_prefix').textContent = input.prefix || '';
        textBox.value = '';
    }
    return new Promise((resolve) => {
        askResolve = resolve;
        dialog.showModal();
        (input ? textBox : document.getElementById('ask_cancel')).focus();
    });
}

///////////////////////////////////////////////////////////////////////////////
// File management (PortfolioServer only). Every delete is confirmed, one file
// at a time: it can't be undone. The server logs the result and lists the
// folder again.

// a DOS name: up to 8 characters, optionally a dot and up to 3 more
const DOS_NAME = /^[A-Za-z0-9_$~!#%&'()@^{}-]{1,8}(\.[A-Za-z0-9_$~!#%&'()@^{}-]{1,3})?$/;

async function askDeleteFile(entry) {
    const where = currentPath.toUpperCase();
    const ok = await ask({
        title: `Delete ${entry.name}?`,
        text: `${where}${entry.name} (${formatBytes(entry.size)}) will be deleted from the Portfolio. This can’t be undone.`
            + (entry.readonly ? ' It is read-only, so the Portfolio will probably refuse.' : ''),
        ok: 'Delete',
        danger: true,
    });
    if (ok) sendMessage({ command: 'delete_file', folder: currentPath, name: entry.name });
}

async function askRemoveFolder(entry) {
    const where = currentPath.toUpperCase();
    const ok = await ask({
        title: `Remove folder ${entry.name}?`,
        text: `${where}${entry.name} will be removed from the Portfolio. Only an empty folder can be removed:`
            + ' delete the files in it first.',
        ok: 'Remove',
        danger: true,
    });
    if (ok) sendMessage({ command: 'remove_folder', folder: currentPath, name: entry.name });
}

async function newFolder() {
    if (!serverStatus.full) return;
    const where = currentPath.toUpperCase();
    const taken = new Set(listing.entries.map(e => e.name.toUpperCase()));
    const name = await ask({
        title: 'New folder',
        ok: 'Make folder',
        input: {
            label: 'Folder name',
            prefix: where,
            validate: (text) => {
                if (!text) return 'Type a name for the folder';
                if (!DOS_NAME.test(text)) return 'Up to 8 letters or digits, optionally a dot and 3 more (e.g. GAMES)';
                if (taken.has(text.toUpperCase())) return 'There is already a file or folder of that name';
                return '';
            },
        },
    });
    if (name) sendMessage({ command: 'make_folder', folder: currentPath, name: name.toUpperCase() });
}

///////////////////////////////////////////////////////////////////////////////
// Footer: the web app's version, rpfolio's, and the Portfolio's server. The
// server sends them on page load and whenever they change (the user can
// switch servers on the Portfolio, or swap rpfolio, at any time). The
// PortfolioServer features (New folder, Stop, Update) follow them.

let serverStatus = { full: false };

function showVersions(status) {
    serverStatus = status;
    document.getElementById('ver_app').textContent = status.app;
    document.getElementById('ver_rpfolio').textContent = status.rpfolio;
    document.getElementById('ver_server').textContent = status.server;
    document.getElementById('server_actions').hidden = !status.full;
    // New folder: greyed out unless PortfolioServer is running; hidden while
    // the original rpfolio can't tell
    const newButton = document.getElementById('folder_new');
    newButton.hidden = !status.patched;
    newButton.disabled = !status.full;
    newButton.title = status.full ? 'New folder' : 'New folder (needs PortfolioServer on the Portfolio)';
    const hint = document.getElementById('server_hint');
    let text = '';
    if (status.patched && (status.serverKind === 'rom' || status.serverKind === 'stopped')) {
        text = 'For folders in the list, file sizes and dates, delete, new folders and free space, '
            + 'run SERVER.COM on the Portfolio instead of the built-in server.';
    } else if (!status.patched && status.rpfolio !== 'not found') {
        text = 'With PortfolioServer (SERVER.COM) on the Portfolio and the rpfolio that supports it, '
            + 'this page can also show folders, delete files and more.';
    }
    hint.textContent = text;
    hint.hidden = !text;
}

function enableServerControls() {
    document.getElementById('server_stop').addEventListener('click', async () => {
        const ok = await ask({
            title: 'Stop PortfolioServer?',
            text: 'The Portfolio goes back to DOS and this page can’t reach it until a server is started on it again. '
                + 'While PortfolioServer runs, the Portfolio doesn’t switch itself off, so stop it when you’re done '
                + 'to save the batteries.',
            ok: 'Stop',
            danger: true,
        });
        if (ok) sendMessage({ command: 'stop_server' });
    });

    // Update: send a new SERVER.COM to C:\SERVER.COM; it takes over once
    // PortfolioServer is restarted on the Portfolio
    const fileInput = document.getElementById('server_file');
    const updateButton = document.getElementById('server_update');
    updateButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        if (!/\.com$/i.test(file.name)) {
            showStatus('PortfolioServer is a .COM file (SERVER.COM)', 'info');
            return;
        }
        const ok = await ask({
            title: 'Update PortfolioServer?',
            text: `${file.name} (${formatBytes(file.size)}) will replace C:\\SERVER.COM on the Portfolio. `
                + 'Afterwards press Esc on the Portfolio and start SERVER.COM again.',
            ok: 'Send',
        });
        if (!ok) return;
        updateButton.disabled = true;
        showStatus(`Sending ${file.name} to C:\\SERVER.COM…`, 'warn');
        try {
            const data = new FormData();
            data.append('server', file, file.name);
            const res = await fetch('/update-server', { method: 'POST', body: data });
            const text = (await res.text()).trim();
            showStatus(res.ok ? text : `Update failed: ${text}`, res.ok ? 'ok' : 'info');
            if (res.ok) {
                // long enough to read
                clearTimeout(statusHideTimer);
                statusHideTimer = setTimeout(hideStatus, 10000);
            }
        } catch (error) {
            showStatus('Update failed — check the connection to the Pi', 'info');
        } finally {
            updateButton.disabled = false;
        }
    });
}

///////////////////////////////////////////////////////////////////////////////
