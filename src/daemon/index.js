const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const { runPortfolioCommand } = require('../utils');

const config = require('../config');
const { sendToWebsite, sendToActivityLog, sendDirList } = require('../websockets');

/**
 * Sets up a daemon to watch for added files in the shared folder and
 * transfers them to the specified drive.
 */
function setupDaemon() {
    chokidar.watch(config.sharedFolder, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        awaitWriteFinish: true
    }).on('add', async (filePath) => {
        const fileName = path.basename(filePath);
        sendToActivityLog(`\u{2b06}\u{fe0f} ${fileName} `);

        const result = transferFile(filePath);
        if (result.ok) {
            console.log(`- uploading ${fileName} to Portfolio \u{2705}`);
            sendToActivityLog(`\u{2705}\n`);
        } else {
            console.log(`- uploading ${fileName} to Portfolio \u{274c} ${result.reason}; removed from the Pi`);
            sendToActivityLog(`\u{274c} ${result.reason}\n`);
        }
        process.stdout.write(config.BEEP);
        sendDirList();
    });
}

/**
 * Turns rpfolio's error output into a short reason for the logs.
 * @param {Error} error - the error thrown by execFileSync
 * @returns {string}
 */
function failureReason(error) {
    const stderr = error.stderr ? error.stderr.toString() : '';
    const lines = stderr
        .split(/[\r\n]+/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('Waiting for Portfolio'));
    const text = lines.join(' ');
    if (/disk full|does not exist/i.test(text)) {
        return '(folder missing or Portfolio disk full)';
    }
    if (text) return `(${text})`;
    return error.code === 'ENOENT' ? '(rpfolio not found)' : `(${error.message})`;
}

/**
 * Transfers the specified file to the configured drive, then removes it from
 * the shared folder. The file is removed whether or not the transfer worked:
 * a failed file can't be reached from the web page, and leaving it would make
 * it upload unexpectedly on the next server start. The activity log says it
 * failed, so the user can simply upload it again.
 *
 * @param {string} filePath - The file path to transfer.
 * @returns {{ok: boolean, reason?: string}} - whether it worked, and why not
 */
const transferFile = (filePath) => {
    if (!fs.existsSync(filePath)) {
        return { ok: false, reason: '(file no longer exists)' };
    }
    let result = { ok: true };
    try {
        // keep stderr so a failure can say why
        runPortfolioCommand(config.transferCommand, { file: filePath, drive: config.portfolioPath },
            { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        result = { ok: false, reason: failureReason(error) };
    }
    try {
        fs.unlinkSync(filePath);
    } catch (error) {
        console.error(`- could not remove ${filePath}: ${error.message}`);
    }
    return result;
}

///////////////////////////////////////////////////////////////////////////////
module.exports = { setupDaemon };
///////////////////////////////////////////////////////////////////////////////
