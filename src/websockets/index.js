///////////////////////////////////////////////////////////////////////////////

const WebSocket = require('ws');
const path = require('path');

const config = require('../config');
const { getDirListFromPortfolio } = require('../utils');

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
                    sendDirList();
                    break;
                case 'set_folder':
                    // Handle the 'set_folder' command here
                    console.log(`- setting Portfolio folder: ${message.folder}`);
                    normalizePortfolioPath(message.folder);
                    sendToActivityLog(`📁 ${config.portfolioPath}\n`);
                    sendDirList();
                    break;
                case 'clear_log':
                    activityLog = '';
                    clients.forEach(client => client.send(JSON.stringify({ command: 'set_log', data: '' })));
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
 * Sends the new folder name to the HTML page.
 * @param {string} folder - The folder name to send.
 */
function sendDirList() {
    const files = getDirListFromPortfolio();
    if (!files) {
        sendPortfolioError();
        return;
    }
    const newMessage = {
        command: 'dir',
        files: files
    };
    clients.forEach(client => client.send(JSON.stringify(newMessage)));
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
module.exports = { setupWebSockets, sendToActivityLog, sendDirList, sendPortfolioError };
///////////////////////////////////////////////////////////////////////////////
  