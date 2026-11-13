///////////////////////////////////////////////////////////////////////////////

const path = require('path');

///////////////////////////////////////////////////////////////////////////////

const config = {
    appPort: 80,
    wsPort: 40510,
    // how long to wait for the Portfolio to answer at all (not in server
    // mode, or not connected, if it doesn't)
    portfolioAnswerTimeout: 5000,
    // once it has answered, how long a transfer may go without progress
    // before it counts as stopped part-way
    portfolioStallTimeout: 15000,
    // while the Portfolio isn't answering and a page is open, how often to
    // check whether it is back
    portfolioRetryInterval: 15000,
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
    receiveCommand: 'rpfolio -r -f <drive><file> <dest>',
    transferCommand: 'rpfolio -f -t <file> <drive>',
    ID: 'Portfolio Folder Daemon',
    VERSION: 'v1.0 - LH 05/2023',
    BEEP: '\u0007',
};

///////////////////////////////////////////////////////////////////////////////
module.exports = config;
///////////////////////////////////////////////////////////////////////////////
