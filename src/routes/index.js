
const express = require('express');
const multer  = require('multer');
const config = require('../config');
const { getHomePage, serveStaticFiles, downloadFile, uploadFile } = require('../controllers');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, config.sharedFolder)
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname)
    }
});

const upload = multer({ storage: storage });
const router = express.Router();

router.get('/', getHomePage);
router.get('*.(html|css|js|png|ico)', serveStaticFiles);
router.get('/download/:filename', downloadFile);
// one or more files per upload (the page sends all dropped/chosen files at once)
router.post('/upload', upload.array('filesToUpload', 20), uploadFile);

module.exports = router;
