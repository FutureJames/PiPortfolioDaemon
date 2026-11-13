///////////////////////////////////////////////////////////////////////////////

const config = require('../config');

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

///////////////////////////////////////////////////////////////////////////////
// Running rpfolio
//
// rpfolio runs in the background so the web server stays responsive while
// the Portfolio is busy or missing, and one command at a time, because the
// Portfolio can only talk to one at a time.
//
// rpfolio first waits for the Portfolio to answer (printing "Waiting for
// Portfolio..." to stderr), forever if it never does. Once it answers,
// rpfolio prints what it is doing ("Transmitting file", "Transferring file",
// "Fetching directory listing") and a byte counter while data moves. So:
//  - no answer within portfolioAnswerTimeout: the Portfolio isn't in server
//    mode or isn't connected. Stopping rpfolio then is safe. (A listing is
//    too short to show progress, so it has to finish within this time; one
//    normally takes a second or two.)
//  - after it answered, no output for portfolioStallTimeout: the transfer
//    stopped part-way (cable pulled, server mode left). rpfolio is stopped,
//    and the Portfolio may need its server mode restarted.
// A transfer that keeps moving is never cut off, however long it takes.

const ANSWERED = /Transmitting file|Transferring file|Fetching directory listing/;

class PortfolioError extends Error {
    /**
     * @param {'noanswer'|'stalled'|'failed'} kind
     * @param {string} reason - short reason for the activity log
     */
    constructor(kind, reason) {
        super(reason);
        this.kind = kind;
        this.reason = reason;
    }
}

let queue = Promise.resolve();

// runs fn after every command queued before it has finished
function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
}

/**
 * Turns rpfolio's error output into a short reason, e.g. "(file not found on
 * the Portfolio)".
 */
function failureReason(stderr, stdout, code) {
    // a few failures are reported on stdout
    if (/File not found on Portfolio/.test(stdout)) return '(file not found on the Portfolio)';
    const text = stderr
        .split(/[\r\n]+/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('Waiting for Portfolio'))
        .join(' ');
    if (/disk full|does not exist/i.test(text)) return '(folder missing, no card in A:, or Portfolio disk full)';
    if (/not found/i.test(text)) return '(file not found on the Portfolio)';
    if (text) return `(${text})`;
    return `(rpfolio exited with code ${code})`;
}

/**
 * Runs an rpfolio command template from the config, without a shell. The
 * template is split on spaces first and placeholders like <file> and <drive>
 * are filled in afterwards, so each value stays a single argument and is
 * never interpreted as shell syntax.
 * @param {string} template - e.g. 'rpfolio -f -t <file> <drive>'
 * @param {object} values - placeholder values, e.g. { file, drive }
 * @returns {Promise<string>} rpfolio's output; rejects with a PortfolioError
 */
function runPortfolioCommand(template, values) {
    const [cmd, ...args] = template
        .split(' ')
        .filter(Boolean)
        .map(part => part.replace(/<(\w+)>/g, (match, key) => (key in values ? String(values[key]) : match)));
    return enqueue(() => runNow(cmd, args));
}

function runNow(cmd, args) {
    return new Promise((resolve, reject) => {
        // rpfolio prints a byte counter line for every byte it moves. stdbuf
        // passes its output on in 1 KB batches (about every 30 bytes moved)
        // rather than the usual 4 KB, so the counter shows a transfer is
        // alive many times a second without the Pi Zero having to handle
        // every line (that halved the transfer speed)
        let child;
        try {
            child = spawn('stdbuf', ['-o1024', cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            return reject(new PortfolioError('failed', `(${error.message})`));
        }
        let stdout = '';
        let stderr = '';
        let answered = false;
        let stoppedBecause = null;      // 'noanswer' | 'stalled' when we stop it
        let timer = null;

        const stop = (kind) => {
            stoppedBecause = kind;
            child.kill('SIGKILL');
        };
        const waitFor = (ms, kind) => {
            clearTimeout(timer);
            timer = setTimeout(() => stop(kind), ms);
        };

        waitFor(config.portfolioAnswerTimeout, 'noanswer');

        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (!answered && ANSWERED.test(stdout)) answered = true;
            // any output after the Portfolio answered means data is moving
            if (answered) waitFor(config.portfolioStallTimeout, 'stalled');
        });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        child.on('error', (error) => {
            clearTimeout(timer);
            reject(new PortfolioError('failed', error.code === 'ENOENT' ? '(rpfolio not found)' : `(${error.message})`));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (stoppedBecause === 'noanswer') {
                reject(new PortfolioError('noanswer', '(no connection to the Portfolio)'));
            } else if (stoppedBecause === 'stalled') {
                reject(new PortfolioError('stalled',
                    '(the Portfolio stopped answering part-way; restart its server mode)'));
            } else if (code !== 0) {
                reject(new PortfolioError('failed', failureReason(stderr, stdout, code)));
            } else {
                resolve(stdout);
            }
        });
    });
}

///////////////////////////////////////////////////////////////////////////////

// the names in rpfolio's listing output: the lines after "Fetching directory
// listing", without the counter's carriage returns
const parseListing = (output) => {
    const lines = output.toString().split(/\r?\n/);
    const start = lines.findIndex(line => line.startsWith('Fetching directory listing'));
    return lines
        .slice(start + 1)
        .map(line => line.trim())
        .filter(Boolean)
        // rpfolio prints "No files." for an empty drive; that is not a file
        .filter(name => name !== 'No files.');
};

/**
 * Gets the current folder's file list.
 * FYI: rpfolio does not return an error if a folder does not exist;
 * see folderExists() to tell an empty folder from a missing one
 * @returns {Promise<string[]>} rejects with a PortfolioError
 */
const getDirListFromPortfolio = async () =>
    parseListing(await runPortfolioCommand(config.listCommand, { drive: config.portfolioPath })).sort();

/**
 * Whether the current folder exists on the Portfolio. Listings never show
 * folders, and an empty folder lists the same as a missing one, but every
 * existing DOS folder contains the NUL device: listing FOLDER\NUL finds it
 * only if the folder is there. This also works for the A:\ root, which has
 * no NUL while the memory card is out. C:\ is the built-in RAM disk and is
 * always there, so it isn't checked.
 * @returns {Promise<boolean>} rejects with a PortfolioError
 */
const folderExists = async () => {
    if (config.portfolioPath.toLowerCase() === 'c:\\') return true;
    const output = await runPortfolioCommand(config.existsCommand, { drive: config.portfolioPath });
    return parseListing(output).some(name => name.toUpperCase() === 'NUL');
};

/**
 * Receives a file from the current folder into a new temporary folder.
 * @param {string} fileName
 * @returns {Promise<{ok: true, path: string, cleanup: Function} | {ok: false, error: PortfolioError}>}
 *   on success, call cleanup() once the file has been sent on
 */
const receiveFileFromPortfolio = async (fileName) => {
    const dir = fs.mkdtempSync(path.join(config.tmpFolder, 'pofo-'));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
        await runPortfolioCommand(config.receiveCommand, { file: fileName, drive: config.portfolioPath, dest: dir });
        const filePath = path.join(dir, fileName);
        if (!fs.existsSync(filePath)) throw new PortfolioError('failed', '(file not found on the Portfolio)');
        return { ok: true, path: filePath, cleanup };
    } catch (error) {
        cleanup();      // no partial files left behind
        return { ok: false, error: error instanceof PortfolioError ? error : new PortfolioError('failed', `(${error.message})`) };
    }
};

/**
 * Sends a file to the current folder.
 * @returns {Promise<void>} rejects with a PortfolioError
 */
const transmitFileToPortfolio = (filePath) =>
    runPortfolioCommand(config.transferCommand, { file: filePath, drive: config.portfolioPath });

///////////////////////////////////////////////////////////////////////////////
module.exports = {
    PortfolioError, runPortfolioCommand, getDirListFromPortfolio, folderExists,
    receiveFileFromPortfolio, transmitFileToPortfolio,
};
///////////////////////////////////////////////////////////////////////////////
