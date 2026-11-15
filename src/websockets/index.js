///////////////////////////////////////////////////////////////////////////////

const WebSocket = require('ws');
const path = require('path');

const config = require('../config');
const {
    PortfolioError, getDirListFromPortfolio, folderExists, getLongDirList, folderExistsLong, getFreeSpace,
    deleteFile, makeFolder, removeFolder, quitServer, isDosName, isPortfolioFolder,
} = require('../utils');
const capabilities = require('../utils/capabilities');

let clients = [];
let loggedOffline = false;      // the log already says the Portfolio isn't answering
let lastListError = '(no connection to the Portfolio)';    // why the last listing failed

// Activity log kept on the server so it survives page reloads
// (uploads submit a form, which reloads the page). Capped to the last
// MAX_LOG_LINES lines so it can't grow without bound on the Pi.
const MAX_LOG_LINES = 500;
let activityLog = '';

function appendToActivityLog(text) {
    activityLog += text;
    const lines = activityLog.split('\n');
    if (lines.length > MAX_LOG_LINES + 1) {
        activityLog = lines.slice(-(MAX_LOG_LINES + 1)).join('\n');
    }
}

///////////////////////////////////////////////////////////////////////////////

function normalizePortfolioPath(path_str) {
    path_str = path.normalize(path_str);
    if (!path_str.endsWith('\\')) {
        path_str += '\\';
    }
    config.portfolioPath = path_str;
    sendSetFolder(config.portfolioPath);
}

///////////////////////////////////////////////////////////////////////////////

// the folder above, e.g. 'c:\GAMES\SAVES\' -> 'c:\GAMES\', 'c:\GAMES\' -> 'c:\'
function parentFolder(folder) {
    const parts = folder.slice(3).split('\\').filter(Boolean);
    parts.pop();
    return folder.slice(0, 3) + parts.map(part => part + '\\').join('');
}

// logs the current folder with the outcome of listing it, like uploads
// ('stale': another folder was opened meanwhile; that one gets logged instead)
function logFolder(status) {
    if (status === 'stale') return;
    const result = {
        ok: '\u{2705}',
        missing: '\u{274c} (folder not found)',
        nocard: '\u{274c} (no card in A:)',
        error: `\u{274c} ${lastListError}`,
    }[status];
    sendToActivityLog(`📁 ${config.portfolioPath} ${result}\n`);
}

// After a listing: if the folder doesn't exist, go up a level (logging
// each step) until one does. If that ends at A:\ with no card in, switch
// to C:\, the built-in RAM disk, which always exists.
async function leaveMissingFolder(status) {
    while (status === 'missing' && config.portfolioPath.length > 3) {
        console.log(`- folder not found, going up: ${config.portfolioPath}`);
        normalizePortfolioPath(parentFolder(config.portfolioPath));
        status = await sendDirList();
        logFolder(status);
    }
    if (status === 'nocard') {
        console.log('- no card in A:, switching to c:\\');
        normalizePortfolioPath('c:\\');
        logFolder(await sendDirList());
    }
}

/**
 * Lists the current folder again (e.g. after an upload). If it has gone
 * meanwhile (the A: card was taken out), logs that and moves to a folder
 * that exists, as on page load.
 */
async function refreshFolder() {
    const status = await sendDirList();
    if (status === 'missing' || status === 'nocard') {
        logFolder(status);
        await leaveMissingFolder(status);
    }
    return status;
}

///////////////////////////////////////////////////////////////////////////////

// tells the pages something went wrong with the Portfolio. offline: it isn't
// answering (the pages show a message that stays until a listing arrives);
// otherwise it answered but reported an error (the pages just show it)
function sendPortfolioError(reason, offline = true) {
    const newMessage = {
        command: 'pofo_error',
        reason,
        offline,
    };
    clients.forEach(client => client.send(JSON.stringify(newMessage)));
}

///////////////////////////////////////////////////////////////////////////////
// Which rpfolio and Portfolio server are in use (see utils/capabilities): the
// page's footer shows them, and the PortfolioServer features come and go
// with them. Every page hears of a change straight away.

function statusMessage() {
    return JSON.stringify({ command: 'status', ...capabilities.describe() });
}

capabilities.events.on('change', () => {
    const message = statusMessage();
    clients.forEach(client => client.send(message));
});

/**
 * Checks the server again (e.g. after an error, or the Portfolio coming
 * back); if the PortfolioServer features came or went, lists the folder
 * again with or without them.
 */
async function recheckServer() {
    const before = capabilities.fullFeatures();
    await capabilities.checkServer();
    if (capabilities.fullFeatures() !== before) await refreshFolder();
}

///////////////////////////////////////////////////////////////////////////////
// Whether the Portfolio is answering. While it isn't and a page is open, the
// server tries a listing every portfolioRetryInterval; when one works, every
// page gets the files and its "no connection" message goes away, without a
// reload. Nothing is tried while no page is open (a page asks on load).

let portfolioOnline = null;     // null until the first command
let retryTimer = null;

/**
 * Notes the outcome of talking to the Portfolio.
 * @param {PortfolioError|null} error - null if it answered
 */
function notePortfolioResult(error) {
    // after an error the user may have switched servers: check (in the
    // background, after the commands already waiting)
    if (error && (error.kind === 'failed' || error.kind === 'stalled')) {
        setImmediate(() => recheckServer().catch(e => console.error('- server check failed', e)));
    }
    if (error && (error.kind === 'notserver' || error.kind === 'notpatched')) error = null;    // it answered
    const online = !error || error.kind === 'failed';   // 'failed': it answered, then refused
    if (online === portfolioOnline) {
        if (!online) scheduleRetry();
        return;
    }
    portfolioOnline = online;
    if (online) {
        clearTimeout(retryTimer);
        retryTimer = null;
    } else {
        console.log(`- Portfolio not answering ${error.reason}`);
        scheduleRetry();
    }
}

function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(async () => {
        retryTimer = null;
        if (portfolioOnline !== false || clients.length === 0) return;
        const status = await sendDirList();
        // still not answering (tried again later), or another folder was opened
        if (status === 'error' || status === 'stale') return;
        console.log('- Portfolio is answering again');
        logFolder(status);
        await leaveMissingFolder(status);
        // it may be running another server now
        await recheckServer();
    }, config.portfolioRetryInterval);
}

///////////////////////////////////////////////////////////////////////////////
/**
 * Sets up a WebSocket server and handles client connections.
 * @function setupWebSockets
 */
const setupWebSockets = (server) => {
    const wsServer = new WebSocket.Server({ server });

    wsServer.on('connection', (ws) => {
        ws.binaryType = 'arraybuffer';
        clients.push(ws);
//        console.log(`- client connected: ${clients.length}`);

        ws.on('message', (event) => {
            let message;
            try {
                message = JSON.parse(event);
            } catch (error) {
                return;
            }
            handleMessage(ws, message).catch(error => console.error('- error handling', message.command, error));
        });

        ws.on('close', () => {
            clients = clients.filter(client => client !== ws);
//            console.log(`- client disconnected: ${clients.length}`);
        });
    });
};

// Messages from a page. Portfolio commands run in the background, one at a
// time, so the server keeps answering (pings, other pages) meanwhile.
async function handleMessage(ws, message) {
    switch (message.command) {
        case 'page_loaded':
            console.log("- web page was loaded");
            ws.send(JSON.stringify({ command: 'set_log', data: activityLog }));
            normalizePortfolioPath(config.portfolioPath);
            // rpfolio may have been swapped, or the server switched, since
            // the last page load
            ws.send(statusMessage());
            await capabilities.checkRpfolio();
            {
                // no answer to the server check: don't wait for a listing
                // to time out as well
                const offline = await capabilities.checkServer();
                // the current folder may have disappeared since it was
                // opened (e.g. the RAM disk was wiped, or the A: card
                // was taken out): if so, say so and move to one that exists
                const status = offline && offline.kind === 'noanswer'
                    ? reportListFailure(offline)
                    : await sendDirList();
                if (status === 'missing' || status === 'nocard') {
                    logFolder(status);
                    await leaveMissingFolder(status);
                } else if (status === 'error') {
                    // say so in the log once, not on every page load
                    if (!loggedOffline) logFolder(status);
                    loggedOffline = true;
                }
            }
            break;
        case 'set_folder':
            console.log(`- setting Portfolio folder: ${message.folder}`);
            // only A: and C: (B: would make DOS ask for a disk on the Portfolio)
            if (typeof message.folder !== 'string' || !/^[ac]:\\/i.test(message.folder)) {
                sendToActivityLog(`📁 ${String(message.folder).slice(0, 80)} \u{274c} (only A: and C: can be used)\n`);
                normalizePortfolioPath(config.portfolioPath);
                await sendDirList();
                break;
            }
            normalizePortfolioPath(message.folder);
            {
                const status = await sendDirList();
                logFolder(status);
                await leaveMissingFolder(status);
            }
            break;
        case 'clear_log':
            activityLog = '';
            clients.forEach(client => client.send(JSON.stringify({ command: 'set_log', data: '' })));
            break;
        case 'ping':
            // liveness check from the page (e.g. after sleep or a network change)
            ws.send(JSON.stringify({ command: 'pong', id: message.id }));
            break;
        case 'delete_file':
        case 'make_folder':
        case 'remove_folder':
            await managePath(ws, message);
            break;
        case 'stop_server':
            await stopServer(ws);
            break;
        default:
            console.log('Unknown command:', message.command);
    }
}
  
///////////////////////////////////////////////////////////////////////////////
// The last listing's file sizes (from the long listing only), so downloads
// can show exact progress from the start
let knownSizes = { folder: null, sizes: new Map() };

/**
 * The exact sizes of a folder's files, if the last listing was of that
 * folder and had them.
 * @param {string} folder
 * @returns {Map<string, number>|undefined} upper-case name -> bytes
 */
const getKnownSizes = (folder) =>
    (knownSizes.folder && knownSizes.folder.toUpperCase() === folder.toUpperCase() ? knownSizes.sizes : undefined);

/**
 * Lists a folder. With PortfolioServer: files and folders with details, and
 * the drive's free space; otherwise just the file names.
 * @returns {Promise<{entries: object[], exists: boolean, full: boolean, free: object|null}>}
 *   entries: { name } or, with PortfolioServer, see getLongListing
 */
async function listFolder(folder) {
    return capabilities.withFullFeatures(async () => {
        const entries = await getLongDirList(folder);
        const exists = entries.length > 0 || await folderExistsLong(folder);
        let free = null;
        if (exists) {
            try {
                free = { drive: folder.slice(0, 3).toLowerCase(), ...(await getFreeSpace(folder)) };
            } catch (error) {
                // a listing without the free space is still a listing,
                // unless the server has changed
                if (error.kind === 'notserver' || error.kind === 'notpatched') throw error;
            }
        }
        return { entries, exists, full: true, free };
    }, async () => {
        const names = await getDirListFromPortfolio(folder);
        // an empty listing may mean the folder doesn't exist; only check then
        const exists = names.length > 0 || await folderExists(folder);
        return { entries: names.map(name => ({ name })), exists, full: false, free: null };
    });
}

// tells the pages a listing failed; returns sendDirList's 'error'
function reportListFailure(failure) {
    notePortfolioResult(failure);
    lastListError = failure.reason;
    // 'failed': it answered but reported an error; not "not connected"
    sendPortfolioError(failure.reason, failure.kind !== 'failed');
    return 'error';
}

/**
 * Sends the current folder's file list to every open page.
 *
 * Portfolio commands wait their turn, so the folder may change before this
 * finishes (another page, or the user, opens one). The folder is fixed at the
 * start, every command uses it, and if another folder is open by the end the
 * result is dropped: the listing for that folder is queued behind this one.
 * @returns {Promise<'ok'|'missing'|'nocard'|'error'|'stale'>} listed, folder
 *   doesn't exist, no card in A:, the Portfolio failed, or another folder was
 *   opened meanwhile
 */
async function sendDirList() {
    const folder = config.portfolioPath;
    let listing;
    let failure = null;
    try {
        listing = await listFolder(folder);
    } catch (error) {
        // includes the Portfolio stopping between the requests: report
        // it like any other lost contact, not as "No files"
        failure = error;
    }
    if (config.portfolioPath !== folder) return 'stale';
    if (failure) return reportListFailure(failure);
    notePortfolioResult(null);
    loggedOffline = false;
    const { entries, exists, full, free } = listing;
    knownSizes = full
        ? { folder, sizes: new Map(entries.filter(e => !e.folder).map(e => [e.name.toUpperCase(), e.size])) }
        : { folder: null, sizes: new Map() };
    const newMessage = {
        command: 'dir',
        folder,
        entries,
        // just the names of the files, as before
        files: entries.filter(entry => !entry.folder).map(entry => entry.name),
        full,
        free,
    };
    if (exists === false) {
        // a missing drive root means the A: memory card is out
        if (folder.length <= 3) {
            newMessage.nocard = true;
        } else {
            newMessage.missing = true;
        }
    }
    clients.forEach(client => client.send(JSON.stringify(newMessage)));
    if (newMessage.nocard) return 'nocard';
    return newMessage.missing ? 'missing' : 'ok';
}

///////////////////////////////////////////////////////////////////////////////
// File management (PortfolioServer only): delete a file, make a folder,
// remove an empty folder. The page names the folder it is showing and the
// entry's name. Each result goes in the activity log, then the folder is
// listed again. If the Portfolio has switched to its built-in server (or
// rpfolio to the original), the page quietly loses the buttons instead.

const MANAGE = {
    delete_file: { run: deleteFile, icon: '\u{1f5d1}\u{fe0f}', what: '', verb: 'deleting' },
    make_folder: { run: makeFolder, icon: '📁', what: ' (new folder)', verb: 'making folder' },
    remove_folder: { run: removeFolder, icon: '\u{1f5d1}\u{fe0f}', what: ' (folder)', verb: 'removing folder' },
};

async function managePath(ws, { command, folder, name }) {
    const action = MANAGE[command];
    if (!isPortfolioFolder(folder) || !isDosName(name)) {
        ws.send(JSON.stringify({ command: 'pofo_error', reason: '(not a valid DOS name)', offline: false }));
        return;
    }
    const path = folder.toUpperCase() + name.toUpperCase();
    if (!capabilities.fullFeatures()) {
        ws.send(JSON.stringify({ command: 'notice', text: 'That needs PortfolioServer on the Portfolio' }));
        return;
    }
    console.log(`- ${action.verb} ${path}`);
    try {
        await action.run(path);
        notePortfolioResult(null);
        console.log(`- ${action.verb} ${path} \u{2705}`);
        sendToActivityLog(`${action.icon} ${path}${action.what} \u{2705}\n`);
    } catch (error) {
        if (await capabilities.noteCapabilityError(error)) {
            // nothing was done; the page now shows the features as gone
            console.log(`- ${action.verb} ${path}: ${error.reason}`);
            ws.send(JSON.stringify({ command: 'notice', text: `Not done: ${error.reason.replace(/^\(|\)$/g, '')}` }));
        } else {
            const reason = error instanceof PortfolioError ? error.reason : `(${error.message})`;
            console.log(`- ${action.verb} ${path} \u{274c} ${reason}`);
            sendToActivityLog(`${action.icon} ${path}${action.what} \u{274c} ${reason}\n`);
            notePortfolioResult(error);
            if (error.kind === 'noanswer' || error.kind === 'stalled') {
                sendPortfolioError(reason);
                return;
            }
        }
    }
    await refreshFolder();
}

/**
 * Stops PortfolioServer (only ever on the user's request: it keeps the
 * Portfolio from switching itself off, which drains the batteries). The
 * Portfolio then goes back to DOS, so it stops answering until a server is
 * started on it again.
 */
async function stopServer(ws) {
    if (!capabilities.fullFeatures()) {
        ws.send(JSON.stringify({ command: 'notice', text: 'PortfolioServer isn’t running' }));
        return;
    }
    console.log('- stopping PortfolioServer');
    try {
        await quitServer();
    } catch (error) {
        if (await capabilities.noteCapabilityError(error)) {
            ws.send(JSON.stringify({ command: 'notice', text: `Not done: ${error.reason.replace(/^\(|\)$/g, '')}` }));
            await refreshFolder();
            return;
        }
        const reason = error instanceof PortfolioError ? error.reason : `(${error.message})`;
        console.log(`- stopping PortfolioServer \u{274c} ${reason}`);
        sendToActivityLog(`\u{23f9}\u{fe0f} PortfolioServer \u{274c} ${reason}\n`);
        notePortfolioResult(error);
        return;
    }
    console.log('- stopping PortfolioServer \u{2705}');
    sendToActivityLog('\u{23f9}\u{fe0f} PortfolioServer stopped \u{2705}\n');
    capabilities.noteServerStopped();
    // nothing answers now: show "no connection" and look for a server
    // every few seconds, as when the Portfolio is switched off
    const reason = '(no connection to the Portfolio)';
    lastListError = reason;
    loggedOffline = true;
    notePortfolioResult(new PortfolioError('noanswer', reason));
    sendPortfolioError(reason);
}

///////////////////////////////////////////////////////////////////////////////
/**
 * Sends the new folder name to the HTML page.
 * @param {string} folder - The folder name to send.
 */
function sendSetFolder(folder) {
    const newMessage = {
        command: 'set_folder',
        folder: folder
    };
    clients.forEach(client => client.send(JSON.stringify(newMessage)));
}


///////////////////////////////////////////////////////////////////////////////
/**
 * Sends a message to the connected clients.
 * @param {string} message - The message to send.
 */
const sendToActivityLog = (message) => {
    appendToActivityLog(message);
    const newMessage = {
        command: 'add_to_log',
        data: message
    };
    clients.forEach(item => item.send(JSON.stringify(newMessage)));
}

///////////////////////////////////////////////////////////////////////////////
// file name -> ids of the pages that uploaded files of that name, oldest first
const uploadOwners = new Map();

/**
 * Notes which page uploaded a file, so its result can be matched to that page.
 * @param {string} file - the file name as saved in the shared folder
 * @param {string} [page] - the uploading page's id
 */
const expectUpload = (file, page) => {
    const owner = typeof page === 'string' ? page.slice(0, 64) : null;
    const queue = uploadOwners.get(file) || [];
    queue.push(owner);
    uploadOwners.set(file, queue);
}

/**
 * Undoes expectUpload for a file whose upload failed before it was saved.
 */
const forgetUpload = (file, page) => {
    const owner = typeof page === 'string' ? page.slice(0, 64) : null;
    const queue = uploadOwners.get(file);
    if (!queue) return;
    const i = queue.lastIndexOf(owner);
    if (i >= 0) queue.splice(i, 1);
    if (queue.length === 0) uploadOwners.delete(file);
}

/**
 * Tells the pages that one uploaded file has finished, for the upload
 * progress bar (the activity log gets its own human-readable line). Carries the id of
 * the page that uploaded it; other pages ignore it. Files put in the shared
 * folder some other way have no owner.
 */
const sendUploadResult = (file, ok) => {
    const queue = uploadOwners.get(file);
    const owner = queue && queue.length ? queue.shift() : null;
    if (queue && queue.length === 0) uploadOwners.delete(file);
    const message = JSON.stringify({ command: 'upload_result', file, ok, owner });
    clients.forEach(client => client.send(message));
}

/**
 * Tells the pages how far the file being sent to the Portfolio has got, for
 * the upload progress bar. Carries the id of the page that uploaded it, like
 * sendUploadResult (the file's result hasn't come yet, so it is still first
 * in line for that name).
 * @param {string} file - the file name
 * @param {number} sent - bytes sent so far
 * @param {number} size - the file's size in bytes
 */
const sendUploadProgress = (file, sent, size) => {
    const queue = uploadOwners.get(file);
    const owner = queue && queue.length ? queue[0] : null;
    const message = JSON.stringify({ command: 'upload_progress', file, sent, size, owner });
    clients.forEach(client => client.send(message));
}

/**
 * Tells the pages how far a download from the Portfolio has got. Only the
 * page that asked for it (owner) shows it; request tells its downloads apart.
 * @param {string|null} owner - the downloading page's id
 * @param {string|null} request - the page's id for this download
 * @param {object} progress - { file, index, count, received, size, estimated }, see receivedBytesCounter
 */
const sendDownloadProgress = (owner, request, progress) => {
    if (!owner) return;
    const message = JSON.stringify({ command: 'download_progress', owner, request, ...progress });
    clients.forEach(client => client.send(message));
}

///////////////////////////////////////////////////////////////////////////////
module.exports = { setupWebSockets, sendToActivityLog, sendDirList, sendPortfolioError, sendUploadResult, sendUploadProgress, sendDownloadProgress, expectUpload, forgetUpload, notePortfolioResult, refreshFolder, getKnownSizes };
///////////////////////////////////////////////////////////////////////////////
  