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
    // the rpfolio program (transfolio's Raspberry Pi build); RPFOLIO=/path
    // runs another build, e.g. for testing. <rpfolio> in the commands below
    // stands for it.
    rpfolio: process.env.RPFOLIO || 'rpfolio',
    // !!! TODO: be better w/ *.*
    listCommand: '<rpfolio> -l <drive>*.*',
    // every existing DOS folder contains the NUL device, so this finds "NUL"
    // only if the folder exists (an empty and a missing folder list the same)
    existsCommand: '<rpfolio> -l <drive>NUL',
    receiveCommand: '<rpfolio> -r -f <drive><file> <dest>',
    transferCommand: '<rpfolio> -f -t <file> <drive>',
    // PortfolioServer's own commands (SERVER.COM, which replaces the
    // Portfolio's built-in server), in the rpfolio with
    // rpfolio-portfolioserver.patch. The built-in server ignores them, and
    // rpfolio then exits with code 3; the original rpfolio prints its help.
    infoCommand: '<rpfolio> -i',
    // files and folders, with attributes, size, date and time
    longListCommand: '<rpfolio> -x <pattern>',
    deleteCommand: '<rpfolio> -e <path>',
    mkdirCommand: '<rpfolio> -m <path>',
    rmdirCommand: '<rpfolio> -k <path>',
    freeCommand: '<rpfolio> -s <drive>',
    quitCommand: '<rpfolio> -q',
    // where updating PortfolioServer puts the new SERVER.COM
    serverComPath: 'C:\\SERVER.COM',
    // PortfolioServer's latest release on GitHub (the API's answer names its
    // SERVER.COM), and the release page for people to look at
    serverReleaseApi: 'https://api.github.com/repos/FutureJames/Atari-Portfolio_Server/releases/latest',
    serverReleasePage: 'https://github.com/FutureJames/Atari-Portfolio_Server/releases/latest',
    ID: 'Portfolio Folder Daemon',
    // the web app's version, shown on the page
    VERSION: require('../../package.json').version,
    BEEP: '\u0007',
};

///////////////////////////////////////////////////////////////////////////////
module.exports = config;
///////////////////////////////////////////////////////////////////////////////
