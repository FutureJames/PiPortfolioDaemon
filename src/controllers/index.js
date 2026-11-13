
///////////////////////////////////////////////////////////////////////////////

const path = require('path');
const fs = require('fs');

const config = require('../config');
const { receiveFileFromPortfolio } = require('../utils');
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
module.exports = { getHomePage, serveStaticFiles, downloadFile, uploadFile };
///////////////////////////////////////////////////////////////////////////////
