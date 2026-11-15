///////////////////////////////////////////////////////////////////////////////
// PortfolioServer's releases on GitHub: which version is the latest, and
// fetching its SERVER.COM, so the page can update PortfolioServer without the
// user downloading anything. Needs the Pi to be online; if GitHub can't be
// reached, there's simply no update offer.

const fs = require('fs');
const path = require('path');

const config = require('../config');
// network requests wait for any rpfolio command (and rpfolio for them): the
// Pi Zero can't do both at once without upsetting rpfolio's timing
const { runExclusive } = require('./portfolioUtils');

// GitHub allows 60 unauthenticated API requests an hour per address, so the
// answer is kept for a while; page loads within that time reuse it
const CACHE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 10000;
// a sane SERVER.COM: a DOS .COM file is at most 64 KB; PortfolioServer is ~2 KB
const MIN_SIZE = 256;
const MAX_SIZE = 64 * 1024;

let cached = null;      // { at, release }

/**
 * The latest release: { version: '0.4', url: download address of its
 * SERVER.COM, size }, or null if GitHub can't be reached or the release has
 * no SERVER.COM. Cached for half an hour.
 * @returns {Promise<{version: string, url: string, size: number}|null>}
 */
async function getLatestRelease() {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.release;
    return runExclusive(fetchLatestRelease);
}

async function fetchLatestRelease() {
    // another request may have fetched it while this one waited its turn
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.release;
    let release = null;
    try {
        const res = await fetch(config.serverReleaseApi, {
            headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'PiPortfolioDaemon' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) {
            const data = await res.json();
            const version = /^v?(\d+(?:\.\d+)*)$/.exec(String(data.tag_name || ''));
            const asset = (data.assets || []).find(a => String(a.name).toUpperCase() === 'SERVER.COM');
            if (version && asset) {
                release = { version: version[1], url: asset.browser_download_url, size: asset.size };
            }
        } else {
            console.log(`- checking for a PortfolioServer release: GitHub answered ${res.status}`);
        }
    } catch (error) {
        console.log(`- checking for a PortfolioServer release failed: ${error.message}`);
    }
    // a failed check is kept too (for less time), so an offline Pi doesn't
    // wait on GitHub at every page load
    cached = { at: release ? Date.now() : Date.now() - CACHE_MS + 5 * 60 * 1000, release };
    return release;
}

/**
 * Whether version a is newer than version b, e.g. '0.10' > '0.4'.
 */
function isNewer(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

/**
 * Downloads a release's SERVER.COM into a new temporary folder.
 * @param {{url: string}} release - from getLatestRelease
 * @returns {Promise<{path: string, cleanup: Function}>} rejects with an
 *   Error whose message is a short reason
 */
function downloadServerCom(release) {
    return runExclusive(() => fetchServerCom(release));
}

async function fetchServerCom(release) {
    let res;
    try {
        res = await fetch(release.url, {
            headers: { 'User-Agent': 'PiPortfolioDaemon' },
            signal: AbortSignal.timeout(TIMEOUT_MS * 3),
        });
    } catch (error) {
        throw new Error(`(couldn’t download it from GitHub: ${error.message})`);
    }
    if (!res.ok) throw new Error(`(couldn’t download it from GitHub: ${res.status})`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < MIN_SIZE || data.length > MAX_SIZE) {
        throw new Error(`(the download is ${data.length} bytes, which isn’t a SERVER.COM)`);
    }
    const dir = fs.mkdtempSync(path.join(config.tmpFolder, 'pofo-'));
    const file = path.join(dir, 'SERVER.COM');
    fs.writeFileSync(file, data);
    return { path: file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

///////////////////////////////////////////////////////////////////////////////
module.exports = { getLatestRelease, isNewer, downloadServerCom };
///////////////////////////////////////////////////////////////////////////////
