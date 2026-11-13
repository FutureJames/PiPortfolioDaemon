///////////////////////////////////////////////////////////////////////////////

const WebSocket = require('ws');
const path = require('path');

const config = require('../config');
const { getDirListFromPortfolio, folderExists } = require('../utils');

let clients = [];

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
function leaveMissingFolder(status) {
    while (status === 'missing' && config.portfolioPath.length > 3) {
        console.log(`- folder not found, going up: ${config.portfolioPath}`);
        normalizePortfolioPath(parentFolder(config.portfolioPath));
        status = sendDirList();
        logFolder(status);
    }
    if (status === 'nocard') {
        console.log('- no card in A:, switching to c:\\');
        normalizePortfolioPath('c:\\');
        logFolder(sendDirList());
    }
}

///////////////////////////////////////////////////////////////////////////////

function sendPortfolioError() {
    const newMessage = {
        command: 'pofo_error',
    };
    clients.forEach(client => client.send(JSON.stringify(newMessage)));
    // console.log("- PoFo connection error");
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
            const message = JSON.parse(event);
            let reply;
            switch (message.command) {
                case 'page_loaded':
                    console.log("- web page was loaded");
                    ws.send(JSON.stringify({ command: 'set_log', data: activityLog }));
                    normalizePortfolioPath(config.portfolioPath);
                    {
                        // the current folder may have disappeared since it was
                        // opened (e.g. the RAM disk was wiped, or the A: card
                        // was taken out): if so, say so and move to one that exists
                        const status = sendDirList();
                        if (status === 'missing' || status === 'nocard') {
                            logFolder(status);
                            leaveMissingFolder(status);
                        }
                    }
                    break;
                case 'set_folder':
                    console.log(`- setting Portfolio folder: ${message.folder}`);
                    normalizePortfolioPath(message.folder);
                    {
                        const status = sendDirList();
                        logFolder(status);
                        leaveMissingFolder(status);
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
        });

        ws.on('close', () => {
            clients = clients.filter(client => client !== ws);
//            console.log(`- client disconnected: ${clients.length}`);
        });
    });
};
  
///////////////////////////////////////////////////////////////////////////////
/**
 * Sends the current folder's file list to every open page.
 * @returns {'ok'|'missing'|'error'} listed, folder doesn't exist, or the
 *   Portfolio didn't answer
 */
function sendDirList() {
    const files = getDirListFromPortfolio();
    if (!files) {
        sendPortfolioError();
        return 'error';
    }
    const newMessage = {
        command: 'dir',
        files: files
    };
    // an empty listing may mean the folder doesn't exist; only check then
    if (files.length === 0) {
        const exists = folderExists();
        if (exists === null) {
            // the Portfolio stopped answering between the two requests:
            // report it like any other lost contact, not as "No files"
            sendPortfolioError();
            return 'error';
        }
        if (exists === false) {
            // a missing drive root means the A: memory card is out
            if (config.portfolioPath.length <= 3) {
                newMessage.nocard = true;
            } else {
                newMessage.missing = true;
            }
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
/**
 * Tells the pages that one uploaded file has finished, for the upload
 * progress bar (the activity log gets its own human-readable line).
 * @param {string} file - the file name
 * @param {boolean} ok - whether it reached the Portfolio
 */
const sendUploadResult = (file, ok) => {
    const message = JSON.stringify({ command: 'upload_result', file, ok });
    clients.forEach(client => client.send(message));
}

///////////////////////////////////////////////////////////////////////////////
module.exports = { setupWebSockets, sendToActivityLog, sendDirList, sendPortfolioError, sendUploadResult };
///////////////////////////////////////////////////////////////////////////////
  