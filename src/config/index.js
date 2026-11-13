///////////////////////////////////////////////////////////////////////////////

const path = require('path');

///////////////////////////////////////////////////////////////////////////////

const config = {
    appPort: 80,
    wsPort: 40510,
    portfolioTimeout: 4000,
    portfolioPath: 'c:\\',
    webserverFolder: path.join(__dirname, '../..', 'public'),
    homepage: path.join(__dirname, '../..', 'public', 'rpf.html'),
    sharedFolder: path.join(__dirname, '../..', 'upload'),
    tmpFolder: '/tmp',
    // !!! TODO: be better w/ *.*
    listCommand: 'rpfolio -l <drive>*.*',
    // every existing DOS folder contains the NUL device, so this finds "NUL"
    // only if the folder exists (an empty and a missing folder list the same)
    existsCommand: 'rpfolio -l <drive>NUL',
    receiveCommand: 'rpfolio -r -f <drive><file> .',
    transferCommand: 'rpfolio -f -t <file> <drive>',
    ID: 'Portfolio Folder Daemon',
    VERSION: 'v1.0 - LH 05/2023',
    BEEP: '\u0007',
};

///////////////////////////////////////////////////////////////////////////////
module.exports = config;
///////////////////////////////////////////////////////////////////////////////
