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

const ANSWERED = /Transmitting file|Transferring file|Fetching (long )?directory listing/;

// how much of rpfolio's output to keep (see runNow)
const MAX_OUTPUT_KEPT = 64 * 1024;
const OUTPUT_KEPT_EACH_END = 8 * 1024;

class PortfolioError extends Error {
    /**
     * @param {'noanswer'|'stalled'|'failed'|'notserver'|'notpatched'} kind -
     *   no answer, stopped part-way, answered with an error, a PortfolioServer
     *   command reached the built-in server (rpfolio exit code 3), or this
     *   rpfolio doesn't have the PortfolioServer options (it printed its help)
     * @param {string} reason - short reason for the activity log
     */
    constructor(kind, reason) {
        super(reason);
        this.kind = kind;
        this.reason = reason;
    }
}

// rpfolio's exit code when a PortfolioServer option got no reply because the
// Portfolio is running its built-in server
const EXIT_NOT_PORTFOLIOSERVER = 3;

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
    // PortfolioServer's commands (-e, -m, -k, -s) give DOS's reason, e.g.
    // "Cannot delete C:\X.TXT: access denied (...) (DOS error 5)"
    const dos = /Cannot (delete|make folder|remove folder|read the free space on) .*\(DOS error (\d+)\)/.exec(text);
    if (dos) return dosReason(dos[1], Number(dos[2]));
    if (/disk full|does not exist/i.test(text)) return '(folder missing, no card in A:, or Portfolio disk full)';
    if (/not found/i.test(text)) return '(file not found on the Portfolio)';
    if (text) return `(${text})`;
    return `(rpfolio exited with code ${code})`;
}

// a short reason for a DOS error from one of PortfolioServer's commands
function dosReason(verb, code) {
    if (code === 5) {
        return {
            'delete': '(read-only file, can’t be deleted)',
            'make folder': '(a file or folder of that name already exists)',
            'remove folder': '(folder not empty)',
        }[verb] || '(access denied)';
    }
    return {
        2: verb === 'delete' ? '(file not found on the Portfolio)' : '(folder not found)',
        3: '(folder not found)',
        15: '(no such drive, or no card in A:)',
        16: '(it is the Portfolio’s current folder)',
    }[code] || `(DOS error ${code})`;
}

/**
 * Runs an rpfolio command template from the config, without a shell. The
 * template is split on spaces first and placeholders like <file> and <drive>
 * are filled in afterwards, so each value stays a single argument and is
 * never interpreted as shell syntax.
 * @param {string} template - e.g. 'rpfolio -f -t <file> <drive>'
 * @param {object} values - placeholder values, e.g. { file, drive }
 * @param {Function} [onOutput] - called with each chunk of rpfolio's output
 * @returns {Promise<string>} rpfolio's output; rejects with a PortfolioError
 */
function runPortfolioCommand(template, values, onOutput) {
    const all = { rpfolio: config.rpfolio, ...values };
    const [cmd, ...args] = template
        .split(' ')
        .filter(Boolean)
        .map(part => part.replace(/<(\w+)>/g, (match, key) => (key in all ? String(all[key]) : match)));
    return enqueue(() => runRetryingAfterStall(cmd, args, onOutput));
}

// After rpfolio is stopped part-way through a download, the Portfolio may
// still be sending the rest of that block, and with PortfolioServer the next
// command can fail once because of it (a limit of the protocol). So the
// command after a stopped transfer gets a second try.
let afterStall = false;

async function runRetryingAfterStall(cmd, args, onOutput) {
    const retry = afterStall;
    afterStall = false;
    try {
        return await runNow(cmd, args, onOutput);
    } catch (error) {
        if (error.kind === 'stalled') afterStall = true;
        if (!retry || (error.kind !== 'failed' && error.kind !== 'noanswer')) throw error;
        console.log(`- first command after a stopped transfer failed ${error.reason}; trying once more`);
        try {
            return await runNow(cmd, args, onOutput);
        } catch (again) {
            if (again.kind === 'stalled') afterStall = true;
            throw again;
        }
    }
}

function runNow(cmd, args, onOutput) {
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
            if (onOutput) onOutput(chunk.toString());
            stdout += chunk;
            // a transfer prints about 30 bytes per byte moved; keep only the
            // start (where rpfolio reports problems like "File not found")
            // and the end, not tens of MB. Listings are far below this.
            if (stdout.length > MAX_OUTPUT_KEPT) {
                stdout = stdout.slice(0, OUTPUT_KEPT_EACH_END) + stdout.slice(-OUTPUT_KEPT_EACH_END);
            }
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
            } else if (code === EXIT_NOT_PORTFOLIOSERVER && /built-in server/.test(stderr)) {
                reject(new PortfolioError('notserver', '(the Portfolio is running its built-in server, not PortfolioServer)'));
            } else if (code !== 0 && /^Syntax: /m.test(stdout)) {
                // rpfolio didn't know the options and printed its help
                reject(new PortfolioError('notpatched', '(this rpfolio doesn’t have the PortfolioServer options)'));
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
 * Gets a folder's file list.
 * FYI: rpfolio does not return an error if a folder does not exist;
 * see folderExists() to tell an empty folder from a missing one
 * @param {string} folder - e.g. 'a:\\GAMES\\'
 * @returns {Promise<string[]>} rejects with a PortfolioError
 */
const getDirListFromPortfolio = async (folder) =>
    parseListing(await runPortfolioCommand(config.listCommand, { drive: folder })).sort();

/**
 * Whether a folder exists on the Portfolio. Listings never show
 * folders, and an empty folder lists the same as a missing one, but every
 * existing DOS folder contains the NUL device: listing FOLDER\NUL finds it
 * only if the folder is there. This also works for the A:\ root, which has
 * no NUL while the memory card is out. C:\ is the built-in RAM disk and is
 * always there, so it isn't checked.
 * @param {string} folder - e.g. 'a:\\GAMES\\'
 * @returns {Promise<boolean>} rejects with a PortfolioError
 */
const folderExists = async (folder) => {
    if (folder.toLowerCase() === 'c:\\') return true;
    const output = await runPortfolioCommand(config.existsCommand, { drive: folder });
    return parseListing(output).some(name => name.toUpperCase() === 'NUL');
};

///////////////////////////////////////////////////////////////////////////////
// PortfolioServer's own commands. Each needs the patched rpfolio and
// PortfolioServer on the Portfolio; otherwise they reject with a
// PortfolioError of kind 'notserver' or 'notpatched' (see runNow).

// a line of rpfolio -x: attributes size date time NAME, e.g.
// "----a      100 2000-01-01 12:00:00 SMALL.TXT"
const LONG_ENTRY = /^([d-])([r-])([h-])([s-])([a-]) +(\d+) (\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (.+)$/;

/**
 * Lists files and folders matching a pattern, with their details (rpfolio -x).
 * Unlike the plain listing, it includes folders and hidden and system files.
 * @param {string} pattern - e.g. 'a:\\GAMES\\*.*'
 * @returns {Promise<Array<{name: string, folder: boolean, size: number, date: string, time: string,
 *   readonly: boolean, hidden: boolean, system: boolean}>>} rejects with a PortfolioError
 */
const getLongListing = async (pattern) => {
    const output = await runPortfolioCommand(config.longListCommand, { pattern });
    return output.toString().split(/\r?\n/)
        .map(line => LONG_ENTRY.exec(line.trim()))
        .filter(Boolean)
        .map(m => ({
            name: m[9], folder: m[1] === 'd', size: Number(m[6]), date: m[7], time: m[8],
            readonly: m[2] === 'r', hidden: m[3] === 'h', system: m[4] === 's',
        }));
};

// folders first, then files, each by name
const byFolderThenName = (a, b) =>
    (a.folder === b.folder ? 0 : a.folder ? -1 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * A folder's files and folders, with details, folders first.
 * @param {string} folder - e.g. 'a:\\GAMES\\'
 */
const getLongDirList = async (folder) => (await getLongListing(`${folder}*.*`)).sort(byFolderThenName);

/**
 * Whether a folder exists, using the long listing: listing the folder's own
 * name in its parent finds it as a folder only if it's there. A drive's root
 * isn't in a parent, so it uses the NUL check (see folderExists), which also
 * works with PortfolioServer.
 * @param {string} folder - e.g. 'a:\\GAMES\\'
 * @returns {Promise<boolean>} rejects with a PortfolioError
 */
const folderExistsLong = async (folder) => {
    if (folder.length <= 3) return folderExists(folder);
    const path = folder.replace(/\\+$/, '');
    const name = path.slice(path.lastIndexOf('\\') + 1).toUpperCase();
    return (await getLongListing(path)).some(entry => entry.folder && entry.name.toUpperCase() === name);
};

/**
 * PortfolioServer's version (rpfolio -i).
 * @returns {Promise<string>} e.g. '0.4'; rejects with a PortfolioError
 *   ('notserver' with the built-in server)
 */
const getServerInfo = async () => {
    const output = await runPortfolioCommand(config.infoCommand, {});
    const match = /PortfolioServer (\d+(?:\.\d+)*)/.exec(output);
    if (!match) throw new PortfolioError('failed', '(unexpected reply to the info command)');
    return match[1];
};

/**
 * Free and total bytes on a drive (rpfolio -s).
 * @param {string} drive - 'a:\\' or 'c:\\'
 * @returns {Promise<{free: number, total: number}>} rejects with a PortfolioError
 */
const getFreeSpace = async (drive) => {
    const letter = drive.slice(0, 2).toUpperCase();
    if (!/^[AC]:$/.test(letter)) throw new PortfolioError('failed', '(no such drive)');
    const output = await runPortfolioCommand(config.freeCommand, { drive: letter });
    const match = /^\S+ (\d+) bytes free of (\d+)$/m.exec(output);
    if (!match) throw new PortfolioError('failed', '(unexpected reply to the free space command)');
    return { free: Number(match[1]), total: Number(match[2]) };
};

/**
 * Deletes a file (rpfolio -e). Hidden and system files can be deleted too;
 * read-only ones can't.
 * @param {string} path - e.g. 'c:\\GAMES\\OLD.TXT'
 */
const deleteFile = (path) => runPortfolioCommand(config.deleteCommand, { path });

/** Makes a folder (rpfolio -m). @param {string} path - e.g. 'c:\\NEW' */
const makeFolder = (path) => runPortfolioCommand(config.mkdirCommand, { path });

/** Removes an empty folder (rpfolio -k). @param {string} path - e.g. 'c:\\OLD' */
const removeFolder = (path) => runPortfolioCommand(config.rmdirCommand, { path });

/** Stops PortfolioServer (rpfolio -q); the Portfolio goes back to DOS. */
const quitServer = () => runPortfolioCommand(config.quitCommand, {});

///////////////////////////////////////////////////////////////////////////////
// Which rpfolio is installed. Run without arguments, rpfolio prints its help
// and exits without touching the port, so this doesn't wait for the
// Portfolio or for other commands. The PortfolioServer patch adds the line
// "With PortfolioServer options, patch N" to the help.

/**
 * @returns {Promise<{found: boolean, version: string|null, patch: number|null}>}
 *   found: rpfolio could be run; version: transfolio's, e.g. '1.0';
 *   patch: the PortfolioServer patch's number, null for the original rpfolio
 */
const detectRpfolio = () => new Promise((resolve) => {
    let child;
    try {
        child = spawn(config.rpfolio, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        return resolve({ found: false, version: null, patch: null });
    }
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', () => {
        clearTimeout(timer);
        resolve({ found: false, version: null, patch: null });
    });
    child.on('close', () => {
        clearTimeout(timer);
        const version = /Transfolio (\S+)/.exec(output);
        const patch = /With PortfolioServer options, patch (\d+)/.exec(output);
        resolve({
            found: Boolean(version),
            version: version ? version[1] : null,
            patch: patch ? Number(patch[1]) : null,
        });
    });
});

/**
 * Receives a file from the current folder into a new temporary folder.
 * @param {string} fileName
 * @param {Function} [onProgress] - see receivedBytesCounter
 * @param {Map<string, number>} [knownSizes] - see receivedBytesCounter
 * @returns {Promise<{ok: true, path: string, cleanup: Function} | {ok: false, error: PortfolioError}>}
 *   on success, call cleanup() once the file has been sent on
 */
const receiveFileFromPortfolio = async (fileName, onProgress, knownSizes) => {
    const dir = fs.mkdtempSync(path.join(config.tmpFolder, 'pofo-'));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
        await runPortfolioCommand(config.receiveCommand, { file: fileName, drive: config.portfolioPath, dest: dir },
            onProgress && receivedBytesCounter(onProgress, knownSizes));
        const filePath = path.join(dir, fileName);
        if (!fs.existsSync(filePath)) throw new PortfolioError('failed', '(file not found on the Portfolio)');
        return { ok: true, path: filePath, cleanup };
    } catch (error) {
        cleanup();      // no partial files left behind
        return { ok: false, error: error instanceof PortfolioError ? error : new PortfolioError('failed', `(${error.message})`) };
    }
};

/**
 * Receives every file in a folder (one rpfolio command, using a wildcard)
 * into a new temporary folder. Folders inside it aren't included: the
 * Portfolio's listings don't contain them.
 * @param {string} folder - e.g. 'a:\\GAMES\\'
 * @param {Function} [onProgress] - see receivedBytesCounter
 * @param {Map<string, number>} [knownSizes] - see receivedBytesCounter
 * @returns {Promise<{ok: true, dir: string, files: string[], cleanup: Function} | {ok: false, error: PortfolioError}>}
 *   on success, call cleanup() once the files have been sent on
 */
const receiveAllFromPortfolio = async (folder, onProgress, knownSizes) => {
    const dir = fs.mkdtempSync(path.join(config.tmpFolder, 'pofo-'));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
        await runPortfolioCommand(config.receiveCommand, { file: '*.*', drive: folder, dest: dir },
            onProgress && receivedBytesCounter(onProgress, knownSizes));
        const files = fs.readdirSync(dir).sort();
        if (files.length === 0) throw new PortfolioError('failed', '(no files in this folder)');
        return { ok: true, dir, files, cleanup };
    } catch (error) {
        cleanup();      // no partial files left behind
        let failure = error instanceof PortfolioError ? error : new PortfolioError('failed', `(${error.message})`);
        // rpfolio says "File not found" when the wildcard matches nothing
        if (failure.reason === '(file not found on the Portfolio)') {
            failure = new PortfolioError('failed', '(no files in this folder)');
        }
        return { ok: false, error: failure };
    }
};

// rpfolio's output, line by line: a counter line ends in "\r" (it is
// overwritten on a terminal), other lines in "\n". onLine gets each whole
// line, onChunkEnd is called once per chunk after its lines.
function lineReader(onLine, onChunkEnd) {
    let carry = '';         // a line split across chunks
    return (chunk) => {
        const lines = (carry + chunk).split(/[\r\n]/);
        carry = lines.pop();
        lines.forEach(onLine);
        onChunkEnd();
    };
}

// While sending, rpfolio splits the file into blocks (the Portfolio says how
// big) and counts the bytes of each block: "Sent 1 of 512 bytes.\r", "Sent 2
// of 512 bytes.\r", ..., with a newline after a block's last byte. The
// counter starts again for every block, so the bytes of finished blocks are
// added up here.
const SENT_COUNTER = /^Sent (\d+) of (\d+) bytes\.$/;

/**
 * Turns rpfolio's output while sending into a running total of bytes sent.
 * @param {Function} onProgress - called with the bytes sent so far
 * @returns {Function} takes each chunk of output
 */
function sentBytesCounter(onProgress) {
    let finishedBlocks = 0; // bytes in blocks already sent
    let sent = -1;          // -1: nothing new in this chunk
    return lineReader((line) => {
        const match = SENT_COUNTER.exec(line);
        if (!match) return;
        const done = Number(match[1]);
        const blockSize = Number(match[2]);
        if (done >= blockSize) {
            finishedBlocks += blockSize;
            sent = finishedBlocks;
        } else {
            sent = finishedBlocks + done;
        }
    }, () => {
        if (sent >= 0) onProgress(sent);
        sent = -1;
    });
}

// While receiving, rpfolio prints for each file:
//   Transferring file 2 of 5: NAME.TXT
//   File size: 1300 bytes.                         (patched rpfolio only)
//   Transmission consists of 3 blocks of payload.  (more than one block only)
//   Received 1 of 512 bytes\r ... Received 512 of 512 bytes\r \n  (each block)
// An unpatched rpfolio doesn't print the size: it is then estimated from the
// number of blocks times the first block's size, and is exact once the last
// block starts (for a single block, from the start). Whether rpfolio is
// patched shows before the first counter: "File size" came first or not.
// Estimated sizes are flagged, so the page can mark them. With PortfolioServer
// the long listing has already given every file's exact size.
const RECEIVING_FILE = /^Transferring file (\d+)(?: of (\d+))?: (.*)$/;
const FILE_SIZE = /^File size: (\d+) bytes\.$/;
const BLOCK_COUNT = /^Transmission consists of (\d+) blocks/;
const RECEIVED_COUNTER = /^Received (\d+) of (\d+) bytes$/;

/**
 * Turns rpfolio's output while receiving into progress for each file.
 * @param {Function} onProgress - called with { file, index, count, received, size, estimated }:
 *   the file being received, which one it is (from 1) and of how many
 *   (null if unknown), bytes received so far, the file's size (null until
 *   known) and whether that size is only an estimate
 * @param {Map<string, number>} [knownSizes] - upper-case file name -> size,
 *   from the long listing, for sizes that are exact from the start
 * @returns {Function} takes each chunk of output
 */
function receivedBytesCounter(onProgress, knownSizes) {
    let current = null;
    let changed = false;
    return lineReader((line) => {
        let match;
        if ((match = RECEIVING_FILE.exec(line))) {
            current = {
                file: match[3].trim(), index: Number(match[1]), count: match[2] ? Number(match[2]) : null,
                received: 0, size: null, exactSize: false, estimated: false,
                blocks: 1, blocksDone: 0, firstBlock: 0, finishedBytes: 0,
            };
            const known = knownSizes && knownSizes.get(current.file.toUpperCase());
            if (known !== undefined) {
                current.size = known;
                current.exactSize = true;
            }
            changed = true;
        } else if (!current) {
            return;
        } else if ((match = FILE_SIZE.exec(line))) {
            current.size = Number(match[1]);
            current.exactSize = true;
            changed = true;
        } else if ((match = BLOCK_COUNT.exec(line))) {
            current.blocks = Number(match[1]);
        } else if ((match = RECEIVED_COUNTER.exec(line))) {
            const done = Number(match[1]);
            const blockSize = Number(match[2]);
            if (!current.firstBlock) current.firstBlock = blockSize;
            if (!current.exactSize) {
                const lastBlock = current.blocksDone >= current.blocks - 1;
                current.size = lastBlock
                    ? current.finishedBytes + blockSize             // exact from here
                    : current.blocks * current.firstBlock;          // at most this
                current.estimated = !lastBlock;
            }
            if (done >= blockSize) {
                current.finishedBytes += blockSize;
                current.blocksDone += 1;
                current.received = current.finishedBytes;
            } else {
                current.received = current.finishedBytes + done;
            }
            changed = true;
        }
    }, () => {
        if (!changed || !current) return;
        changed = false;
        const { file, index, count, received, size, estimated } = current;
        onProgress({ file, index, count, received, size: size === null ? null : Math.max(size, received), estimated });
    });
}

/**
 * Sends a file to the current folder (or another destination).
 * @param {string} filePath
 * @param {Function} [onProgress] - called with the bytes sent so far
 * @param {string} [dest] - a folder ending in \\, or a full file name such
 *   as C:\\SERVER.COM; the current folder if left out
 * @returns {Promise<void>} rejects with a PortfolioError
 */
const transmitFileToPortfolio = (filePath, onProgress, dest = config.portfolioPath) =>
    runPortfolioCommand(config.transferCommand, { file: filePath, drive: dest },
        onProgress && sentBytesCounter(onProgress));

///////////////////////////////////////////////////////////////////////////////
// Portfolio paths from the page. Only drives A: and C: are ever used: on the
// Portfolio B: is a phantom of the card slot, and DOS would stop and ask for
// a disk on the Portfolio's screen.

// a DOS name: up to 8 characters, optionally a dot and up to 3 more
const DOS_NAME_PART = "[A-Za-z0-9_$~!#%&'()@^{}-]{1,8}(?:\\.[A-Za-z0-9_$~!#%&'()@^{}-]{1,3})?";
const DOS_NAME = new RegExp(`^${DOS_NAME_PART}$`);
// drive A: or C:, then DOS names, each followed by a backslash
const PORTFOLIO_FOLDER = new RegExp(`^[ac]:\\\\(?:${DOS_NAME_PART}\\\\)*$`, 'i');

const isDosName = (name) => typeof name === 'string' && DOS_NAME.test(name);
const isPortfolioFolder = (folder) => typeof folder === 'string' && PORTFOLIO_FOLDER.test(folder);

///////////////////////////////////////////////////////////////////////////////
module.exports = {
    isDosName, isPortfolioFolder,
    PortfolioError, runPortfolioCommand, getDirListFromPortfolio, folderExists,
    receiveFileFromPortfolio, receiveAllFromPortfolio, transmitFileToPortfolio,
    getLongDirList, folderExistsLong, getServerInfo, getFreeSpace,
    deleteFile, makeFolder, removeFolder, quitServer, detectRpfolio,
};
///////////////////////////////////////////////////////////////////////////////
