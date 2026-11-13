
///////////////////////////////////////////////////////////////////////////////

const path = require('path');
const fs = require('fs');

const config = require('../config');
const { receiveFileFromPortfolio } = require('../utils');
const { sendToActivityLog, sendDirList, sendPortfolioError } = require('../websockets');

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
const downloadFile = (req, res) => {
  const fileName = req.params.filename;
  // Only plain file names: no paths, so the download and the delete below
  // can't reach files outside the working directory.
  if (!fileName || fileName !== path.basename(fileName) || /[\\/\0]/.test(fileName) || fileName === '..' || fileName === '.') {
    return res.status(400).send('Invalid file name.');
  }
  process.stdout.write(`- downloading ${fileName} from Portfolio `);
  
  if (receiveFileFromPortfolio(fileName)) {
    const filePath = path.join('./', fileName);
    sendToActivityLog(`\u{2b07}\u{fe0f} ${fileName} `);
    
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send(`Error downloading the file: ${fileName}`);
      }
      
      try {
        fs.unlinkSync(filePath);
        sendToActivityLog('\u{2705}\n');
        console.log('\u{2705}');
      } catch (error) {
        console.error('Error during deletion:', error.message);
        sendToActivityLog('\u{274c}\n');
        console.log('\u{274c}');
      }
    });
  } else {
    sendPortfolioError();
  }
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
