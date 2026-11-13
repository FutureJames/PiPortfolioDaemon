const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const { transmitFileToPortfolio, PortfolioError } = require('../utils');

const config = require('../config');
const {
    sendToActivityLog, refreshFolder, sendUploadResult, sendPortfolioError, notePortfolioResult,
} = require('../websockets');

/**
 * Sets up a daemon to watch for added files in the shared folder and
 * transfers them to the specified drive. Transfers run in the background,
 * one at a time and in order, so the web server keeps answering meanwhile.
 * Files already in the folder when the server starts are sent too (and, like
 * any upload, removed if the Portfolio doesn't take them).
 */
function setupDaemon() {
    chokidar.watch(config.sharedFolder, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        awaitWriteFinish: true
    }).on('add', (filePath) => {
        uploadFile(filePath).catch(error => console.error('- upload error', error));
    });
}

async function uploadFile(filePath) {
    const fileName = path.basename(filePath);
    const result = await transferFile(filePath);
    // only claim the file is gone if deleting it actually worked
    const cleanup = result.removed
        ? (result.ok ? '' : '; removed from the Pi')
        : `; could not be removed from the Pi (${result.removeError}) and may be sent again on the next start`;
    // one whole line, written once the result is known: other transfers and
    // folder changes may log in between
    if (result.ok) {
        console.log(`- uploading ${fileName} to Portfolio \u{2705}${cleanup}`);
        sendToActivityLog(`\u{2b06}\u{fe0f} ${fileName} \u{2705}\n`);
    } else {
        console.log(`- uploading ${fileName} to Portfolio \u{274c} ${result.reason}${cleanup}`);
        sendToActivityLog(`\u{2b06}\u{fe0f} ${fileName} \u{274c} ${result.reason}\n`);
    }
    sendUploadResult(fileName, result.ok);
    // (no terminal beep: the server runs as a service, and the bell
    // character hid the next log line in the system journal)
    if (result.offline) {
        // no listing either: the pages already say there's no connection,
        // and the server checks again by itself
        sendPortfolioError(result.reason);
    } else {
        // also notices a folder that has gone, e.g. the A: card pulled mid-upload
        await refreshFolder();
    }
}

/**
 * Transfers the specified file to the configured drive, then removes it from
 * the shared folder. The file is removed whether or not the transfer worked:
 * a failed file can't be reached from the web page, and leaving it would make
 * it upload unexpectedly on the next server start. The activity log says it
 * failed, so the user can simply upload it again.
 *
 * @param {string} filePath - The file path to transfer.
 * @returns {Promise<{ok: boolean, reason?: string, offline?: boolean, removed: boolean, removeError?: string}>}
 *   whether the transfer worked (and why not), whether the Portfolio wasn't
 *   answering, and whether the file was removed
 */
const transferFile = async (filePath) => {
    if (!fs.existsSync(filePath)) {
        return { ok: false, reason: '(file no longer exists)', removed: true };
    }
    let result = { ok: true };
    try {
        await transmitFileToPortfolio(filePath);
        notePortfolioResult(null);
    } catch (error) {
        let reason = error instanceof PortfolioError ? error.reason : `(${error.message})`;
        if (error.kind === 'stalled') {
            // the Portfolio keeps what it received so far (the Pi can't delete it)
            reason = '(the Portfolio stopped answering part-way, a partial copy may be left on it; restart its server mode)';
        }
        result = { ok: false, reason, offline: error.kind === 'noanswer' || error.kind === 'stalled' };
        notePortfolioResult(error);
    }
    try {
        fs.unlinkSync(filePath);
        result.removed = true;
    } catch (error) {
        result.removed = false;
        result.removeError = error.code || error.message;
    }
    return result;
}

///////////////////////////////////////////////////////////////////////////////
module.exports = { setupDaemon };
///////////////////////////////////////////////////////////////////////////////
