# Changelog

## 1.1.0 (11-14-2026)

Support for PortfolioServer (`SERVER.COM`), a replacement for the Portfolio's
built-in file transfer server. The page works with every combination of
server (built-in or PortfolioServer) and `rpfolio` (original or with
`extras/rpfolio-portfolioserver.patch`); the new features appear only with
PortfolioServer and the patched `rpfolio`, and come and go as you switch.

- footer with the web app's version, the `rpfolio` build and the Portfolio's server
- the server checks which `rpfolio` it has (from its help text) and which server the Portfolio runs (`rpfolio -i`), on start-up, on every page load, after errors and when the Portfolio comes back
- with PortfolioServer: folders in the list (click to open), file sizes and dates, hidden and system files shown dimmed (not downloadable)
- with PortfolioServer: delete a file or an empty folder (confirmed each time), make a folder, free space under the drive toggle, and a warning before an upload that won't fit
- with PortfolioServer: stop it, or send it a new `SERVER.COM`, from the footer
- with PortfolioServer: exact download progress from the start, and the download-all button says how many files and bytes it will fetch
- the first command after a stopped download is tried twice (it can fail once with PortfolioServer)
- `extras/rpfolio-portfolioserver.patch`, and the README's build steps apply it
- only drives A: and C: are ever used (B: makes DOS ask for a disk on the Portfolio)
- `RPFOLIO` environment variable to run another `rpfolio` build

## 05-28-2023

- detecting portfolio connection error
- created a separate portfolioUtil.js lib
- checking if folders and `rpfolio` command exists
- checking whether web server port is already in use
- normalizing pi folder path & updating it
- showing "open folder" in log

## 05-27-2023

- the HTML page has now a file upload form & a drag & drop-zone for files
- the file list refreshes after an upload
- the directory list is now sorted alphabetically
- removed config.dirContent setting
- renamed websocket functions
- added try-catch for websocket setup

## 05-13-2023

- Updated README
- Updated HTML and CSS of the client
- Improved feedback on upload and download
- Refactored code and created `src/` structure
