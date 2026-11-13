
const express = require('express');
const multer  = require('multer');
const config = require('../config');
const { getHomePage, serveStaticFiles, downloadFile, uploadFile } = require('../controllers');
const { expectUpload, forgetUpload } = require('../websockets');

// most files the page sends in one request (it splits bigger batches)
const MAX_FILES_PER_UPLOAD = 20;

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, config.sharedFolder)
    },
    filename: function (req, file, cb) {
        // remember which page sent it, so only that page counts its result
        // (the page sends its id before the files, so req.body has it here)
        expectUpload(file.originalname, req.body.page);
        (req.expectedUploads = req.expectedUploads || []).push(file.originalname);
        cb(null, file.originalname)
    }
});

// one file per name per upload: two would be saved under the same name on
// the Pi, overwriting or mixing each other, and only one would be sent
function oneFilePerName(req, file, cb) {
    req.uploadNames = req.uploadNames || new Set();
    if (req.uploadNames.has(file.originalname)) return cb(null, false);
    req.uploadNames.add(file.originalname);
    cb(null, true);
}

const upload = multer({ storage: storage, fileFilter: oneFilePerName });
const router = express.Router();

router.get('/', getHomePage);
router.get('*.(html|css|js|png|ico)', serveStaticFiles);
router.get('/download/:filename', downloadFile);
// one or more files per upload (the page sends them in groups of up to 20)
const receiveFiles = upload.array('filesToUpload', MAX_FILES_PER_UPLOAD);
router.post('/upload', (req, res, next) => {
    receiveFiles(req, res, (err) => {
        if (!err) return next();
        // multer deletes the files of a failed request, so no results will
        // come for them: forget who sent them
        (req.expectedUploads || []).forEach(name => forgetUpload(name, req.body.page));
        console.log(`- upload failed: ${err.message}`);
        res.status(400).send('Upload failed.');
    });
}, uploadFile);

module.exports = router;
