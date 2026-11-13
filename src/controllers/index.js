
///////////////////////////////////////////////////////////////////////////////

const path = require('path');
const fs = require('fs');

const config = require('../config');
const { receiveFileFromPortfolio, receiveAllFromPortfolio } = require('../utils');
const { createZip } = require('../utils/zip');
const { sendToActivityLog, sendPortfolioError, notePortfolioResult } = require('../websockets');

const multer  = require('multer');
const upload = multer({ dest: config.sharedFolder });

///////////////////////////////////////////////////////////////////////////////
/**
 * Sends the homepage as a response.
 * @param {object} req - Express request object.
 * @param {object} res - Express response object.
 */
const getHomePage = (req, res) => {
  res.sendFile(config.homepage);
};

///////////////////////////////////////////////////////////////////////////////
/**
 * Serves static files (html, css, js) requested by the client.
 * @param {object} req - Express request object.
 * @param {object} res - Express response object.
 */
const serveStaticFiles = (req, res) => {
  const filePath = path.join(config.webserverFolder, req.path);
  res.sendFile(filePath);
};

///////////////////////////////////////////////////////////////////////////////
/**
 * Handles the download of a file from the server.
 * @param {object} req - Express request object.
 * @param {object} res - Express response object.
 */
const downloadFile = async (req, res) => {
  const fileName = req.params.filename;
  // Only plain file names: no paths, so the download and the delete below
  // can't reach files outside the working directory.
  if (!fileName || fileName !== path.basename(fileName) || /[\\/\0]/.test(fileName) || fileName === '..' || fileName === '.') {
    return res.status(400).send('Invalid file name.');
  }
  console.log(`- downloading ${fileName} from Portfolio`);

  // runs in the background (the server keeps answering meanwhile) and lands
  // in a temporary folder of its own, removed afterwards
  const result = await receiveFileFromPortfolio(fileName);
  if (!result.ok) {
    const { reason, kind } = result.error;
    console.log(`- downloading ${fileName} from Portfolio \u{274c} ${reason}`);
    sendToActivityLog(`\u{2b07}\u{fe0f} ${fileName} \u{274c} ${reason}\n`);
    notePortfolioResult(result.error);
    if (kind !== 'failed') sendPortfolioError(reason);
    // the page shows this text; 503 when the Portfolio isn't answering
    return res.status(kind === 'failed' ? 500 : 503).type('text/plain').send(`${fileName} ${reason}`);
  }
  notePortfolioResult(null);

  res.download(result.path, fileName, (err) => {
    result.cleanup();
    if (err) {
      // e.g. the browser gave up part-way
      console.error(`- sending ${fileName} to the browser failed: ${err.message}`);
      sendToActivityLog(`\u{2b07}\u{fe0f} ${fileName} \u{274c} (not received by the browser)\n`);
      return;
    }
    console.log(`- downloading ${fileName} from Portfolio \u{2705}`);
    sendToActivityLog(`\u{2b07}\u{fe0f} ${fileName} \u{2705}\n`);
  });
};

///////////////////////////////////////////////////////////////////////////////

// The files are already saved to the upload folder by multer; the daemon
// picks each one up from there and sends it to the Portfolio.
const uploadFile = (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).send('No file uploaded.');
  }
  res.redirect('/');
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
// A Portfolio folder: drive A: or C:, then DOS names (up to 8 characters,
// optionally a dot and up to 3 more), each followed by a backslash
const DOS_NAME = "[A-Za-z0-9_$~!#%&'()@^{}-]{1,8}(?:\\.[A-Za-z0-9_$~!#%&'()@^{}-]{1,3})?";
const PORTFOLIO_FOLDER = new RegExp(`^[ac]:\\\\(?:${DOS_NAME}\\\\)*$`, 'i');

/**
 * Sends every file in a Portfolio folder as one .zip, e.g. GAMES.zip, or
 * C-drive.zip for a drive's root. The page says which folder (the one it is
 * showing), so another page opening a folder meanwhile doesn't matter.
 * @param {object} req - Express request object (?folder=a:\GAMES\).
 * @param {object} res - Express response object.
 */
const downloadAllFiles = async (req, res) => {
  const folder = String(req.query.folder || '');
  if (!PORTFOLIO_FOLDER.test(folder)) {
    return res.status(400).type('text/plain').send('Invalid folder.');
  }
  const parts = folder.slice(3).split('\\').filter(Boolean);
  const zipName = parts.length ? `${parts[parts.length - 1]}.zip` : `${folder[0].toUpperCase()}-drive.zip`;
  console.log(`- downloading all files in ${folder} from Portfolio`);

  // one rpfolio command for the whole folder, in the background like any
  // other transfer; lands in a temporary folder of its own
  const result = await receiveAllFromPortfolio(folder);
  if (!result.ok) {
    const { reason, kind } = result.error;
    console.log(`- downloading all files in ${folder} from Portfolio \u{274c} ${reason}`);
    sendToActivityLog(`\u{2b07}\u{fe0f} ${folder} (all files) \u{274c} ${reason}\n`);
    notePortfolioResult(result.error);
    if (kind !== 'failed') sendPortfolioError(reason);
    return res.status(kind === 'failed' ? 500 : 503).type('text/plain').send(`${zipName} ${reason}`);
  }
  notePortfolioResult(null);

  let zip;
  try {
    zip = createZip(result.files.map(name => ({ name, data: fs.readFileSync(path.join(result.dir, name)) })));
  } finally {
    result.cleanup();
  }
  const count = `${result.files.length} file${result.files.length === 1 ? '' : 's'}`;
  res.attachment(zipName).type('application/zip').send(zip);
  console.log(`- downloading all files in ${folder} from Portfolio \u{2705} ${count}`);
  sendToActivityLog(`\u{2b07}\u{fe0f} ${folder} (${count}) \u{2705}\n`);
};

module.exports = { getHomePage, serveStaticFiles, downloadFile, downloadAllFiles, uploadFile };
///////////////////////////////////////////////////////////////////////////////
