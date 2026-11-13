///////////////////////////////////////////////////////////////////////////////

const WebSocket = require('ws');
const path = require('path');

const config = require('../config');
const { getDirListFromPortfolio, folderExists } = require('../utils');

let clients = [];
let loggedOffline = false;      // the log already says the Portfolio isn't answering

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
function logFolder(status) {
    const result = {
        ok: '\u{2705}',
        missing: '\u{274c} (folder not found)',
        nocard: '\u{274c} (no card in A:)',
        error: '\u{274c} (no connection to the Portfolio)',
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

// tells the pages the Portfolio isn't answering (they show a message that
// stays until a listing arrives)
function sendPortfolioError(reason) {
    const newMessage = {
        command: 'pofo_error',
        reason,
    };
    clients.forEach(client => client.send(JSON.stringify(newMessage)));
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
        if (status === 'error') return;     // still not answering; tried again later
        console.log('- Portfolio is answering again');
        logFolder(status);
        await leaveMissingFolder(status);
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
            {
                // the current folder may have disappeared since it was
                // opened (e.g. the RAM disk was wiped, or the A: card
                // was taken out): if so, say so and move to one that exists
                const status = await sendDirList();
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
        default:
            console.log('Unknown command:', message.command);
    }
}
  
///////////////////////////////////////////////////////////////////////////////
/**
 * Sends the current folder's file list to every open page.
 * @returns {Promise<'ok'|'missing'|'nocard'|'error'>} listed, folder doesn't
 *   exist, no card in A:, or the Portfolio didn't answer
 */
async function sendDirList() {
    let files;
    let exists = true;
    try {
        files = await getDirListFromPortfolio();
        // an empty listing may mean the folder doesn't exist; only check then
        if (files.length === 0) exists = await folderExists();
    } catch (error) {
        // includes the Portfolio stopping between the two requests: report
        // it like any other lost contact, not as "No files"
        notePortfolioResult(error);
        sendPortfolioError(error.reason);
        return 'error';
    }
    notePortfolioResult(null);
    loggedOffline = false;
    const newMessage = {
        command: 'dir',
        files: files
    };
    if (exists === false) {
        // a missing drive root means the A: memory card is out
        if (config.portfolioPath.length <= 3) {
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

///////////////////////////////////////////////////////////////////////////////
module.exports = { setupWebSockets, sendToActivityLog, sendDirList, sendPortfolioError, sendUploadResult, expectUpload, forgetUpload, notePortfolioResult, refreshFolder };
///////////////////////////////////////////////////////////////////////////////
  