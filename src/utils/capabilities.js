///////////////////////////////////////////////////////////////////////////////
// Which rpfolio and which Portfolio server are in use, and so which features
// the page offers. Every combination works:
//
//   rpfolio \ server    built-in (ROM) server   PortfolioServer (SERVER.COM)
//   original            the basic features      the basic features
//   patched             the basic features      everything
//
// The basic features (listing files, downloads, uploads) use the commands
// every rpfolio and both servers have. Folders in the list, file details,
// delete, new and removed folders, free space and stopping the server need
// both the patched rpfolio and PortfolioServer, and appear only once both are
// confirmed. The user can switch servers on the Portfolio, or swap rpfolio,
// at any time, so both are checked again on every page load and after errors.
//
// - rpfolio: run without arguments it prints its help (see detectRpfolio),
//   which names the PortfolioServer patch if it has it.
// - server (patched rpfolio only): rpfolio -i answers with PortfolioServer's
//   version, or exits with code 3 under the built-in server. No answer means
//   the Portfolio is offline: the last known server is kept (it isn't taken
//   to be the built-in one). The original rpfolio can't tell the servers apart.

const EventEmitter = require('events');

const config = require('../config');
const { detectRpfolio, getServerInfo } = require('./portfolioUtils');

const events = new EventEmitter();

const state = {
    rpfolio: { found: false, version: null, patch: null },
    // 'unknown' until rpfolio -i has answered; 'stopped' after the page
    // stopped PortfolioServer, until a server answers again
    server: { kind: 'unknown', version: null },
};

function setState(rpfolio, server) {
    const before = JSON.stringify(state);
    if (rpfolio) state.rpfolio = rpfolio;
    if (server) state.server = server;
    if (JSON.stringify(state) !== before) {
        console.log(`- rpfolio: ${rpfolioLabel()}; Portfolio server: ${serverLabel()}`);
        events.emit('change', describe());
    }
}

const isPatched = () => state.rpfolio.found && state.rpfolio.patch !== null;

/** Whether the PortfolioServer features can be used. */
const fullFeatures = () => isPatched() && state.server.kind === 'portfolioserver';

/** Checks which rpfolio is installed (doesn't touch the Portfolio). */
async function checkRpfolio() {
    setState(await detectRpfolio());
    return state.rpfolio;
}

/**
 * Asks the Portfolio which server it is running (patched rpfolio only). Waits
 * for any command already under way.
 * @returns {Promise<PortfolioError|null>} the error if the Portfolio didn't
 *   answer (or answered with an error), else null
 */
async function checkServer() {
    if (!isPatched()) return null;
    try {
        setState(null, { kind: 'portfolioserver', version: await getServerInfo() });
    } catch (error) {
        if (error.kind === 'notserver') setState(null, { kind: 'rom', version: null });
        // the rpfolio was swapped for one without the options
        else if (error.kind === 'notpatched') await checkRpfolio();
        // no answer, or an error: keep what was known
        else return error;
    }
    return null;
}

/** The page stopped PortfolioServer: no server runs until one is started. */
function noteServerStopped() {
    setState(null, { kind: 'stopped', version: null });
}

/**
 * Handles a PortfolioServer command that couldn't run: the Portfolio has
 * switched to its built-in server, or rpfolio to the original one. The page
 * then quietly loses the features.
 * @returns {Promise<boolean>} true if that was the reason
 */
async function noteCapabilityError(error) {
    if (!error) return false;
    if (error.kind === 'notserver') {
        setState(null, { kind: 'rom', version: null });
        return true;
    }
    if (error.kind === 'notpatched') {
        await checkRpfolio();
        return true;
    }
    return false;
}

/**
 * Runs the PortfolioServer version of something if it can, else the basic
 * one; also if the PortfolioServer one turns out not to be possible after all.
 */
async function withFullFeatures(full, basic) {
    if (fullFeatures()) {
        try {
            return await full();
        } catch (error) {
            if (!(await noteCapabilityError(error))) throw error;
        }
    }
    return basic();
}

function rpfolioLabel() {
    const { found, version, patch } = state.rpfolio;
    if (!found) return 'not found';
    return patch === null
        ? `Transfolio ${version} (original)`
        : `Transfolio ${version} + PortfolioServer patch ${patch}`;
}

function serverLabel() {
    if (!isPatched()) return 'unknown (needs the patched rpfolio to tell)';
    const { kind, version } = state.server;
    if (kind === 'portfolioserver') return `PortfolioServer ${version}`;
    if (kind === 'rom') return 'built-in server';
    if (kind === 'stopped') return 'none (PortfolioServer was stopped)';
    return 'unknown (the Portfolio hasn’t answered yet)';
}

/** What the page shows in its footer and which features it offers. */
function describe() {
    return {
        app: config.VERSION,
        rpfolio: rpfolioLabel(),
        patched: isPatched(),
        server: serverLabel(),
        serverKind: isPatched() ? state.server.kind : 'unknown',
        full: fullFeatures(),
    };
}

///////////////////////////////////////////////////////////////////////////////
module.exports = {
    events, fullFeatures, checkRpfolio, checkServer, noteServerStopped, noteCapabilityError, withFullFeatures, describe,
};
///////////////////////////////////////////////////////////////////////////////
