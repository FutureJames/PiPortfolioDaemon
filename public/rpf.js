///////////////////////////////////////////////////////////////////////////////

let debug = false;

const port = 40510;

///////////////////////////////////////////////////////////////////////////////

if (typeof window.WebSocket === 'undefined') {
    alert('Web sockets are not supported');
} else {
    let ws;
    connectWebSocket();
}
enableDropZone();


///////////////////////////////////////////////////////////////////////////////
// adds event listeners to the web sockets

function connectWebSocket() {
    try {
        ws = new WebSocket(`ws://${location.host}`);
        ws.addEventListener('open', () => {
            console.log('Connected to server!');
            ws.send(JSON.stringify({ command: 'page_loaded' }));
            initializeInputEvents(); 
        });

        ws.addEventListener('message', (event) => {
            const msg = JSON.parse(event.data);
            if (debug) console.log(msg);

            switch (msg.command) {
                case 'add_to_log':
                    updateLog(msg.data);
                    break;
                case 'set_log':
                    setLog(msg.data);
                    break;
                case 'set_folder':
                    getFolder(msg.folder);
                    break;
                case 'dir':
                    populateFileList(msg);
                    break;
                case 'pofo_error':
                    console.log('PoFo connection error!!');
                    alert('No connection to Atari Portfolio.');
                    break;
                default:
                    console.log('error');
                    break;
            }
        });

        ws.addEventListener('error', () => {
            console.log('WebSocket error');
            alert('Error connecting to WebSocket.');
        });

        ws.addEventListener('close', () => {
            ws = null;
            console.log('Disconnected!!');
            alert('WebSocket connection lost.');
            setTimeout(() => {
                ws = new WebSocket(`ws://${location.host}`);
            }, 5000);
        });
    } catch (error) {
        console.error(error);
        return;
    }
}
///////////////////////////////////////////////////////////////////////////////

// The Portfolio has two drives: A:\ (removable card) and C:\ (RAM disk).
const DRIVES = {
    'a:\\': 'Removable card',
    'c:\\': 'RAM disk',
};
let currentDrive = 'c:\\';

function initializeInputEvents() {
    // set up once, even though the WebSocket may reconnect
    if (initializeInputEvents.done) return;
    initializeInputEvents.done = true;

    const toggle = document.getElementById('drive_toggle');
    const options = Array.from(toggle.querySelectorAll('[role="radio"]'));

    // switching drives goes to that drive's root
    const choose = (drive) => {
        if (drive !== currentDrive) {
            document.getElementById('current_folder').value = '';
            sendFolder(drive);
        }
    };

    // directory field: Enter or Open lists that folder on the current drive
    const folderInput = document.getElementById('current_folder');
    folderInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            openFolder();
        }
    });
    document.getElementById('folder_open').addEventListener('click', openFolder);

    options.forEach((option, i) => {
        option.addEventListener('click', () => choose(option.dataset.drive));
        // arrow keys move between the two drives, like a radio group
        option.addEventListener('keydown', (event) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                event.preventDefault();
                const next = options[(i + 1) % options.length];
                choose(next.dataset.drive);
                next.focus();
            }
        });
    });

    showDrive(currentDrive);
}

///////////////////////////////////////////////////////////////////////////////
// shows the folder the server is using (sent as e.g. 'c:\' or 'c:\TESTDIR\')
function getFolder(folder) {
    folder = folder || '';
    const drive = folder.slice(0, 2).toLowerCase() + '\\';
    if (DRIVES[drive]) {
        currentDrive = drive;
        showDrive(drive);
        // the part after the drive, without the trailing backslash
        document.getElementById('current_folder').value = folder.slice(3).replace(/\\+$/, '');
    }
}

// lists the directory typed in the field (blank = drive root)
function openFolder() {
    const name = document.getElementById('current_folder').value
        .trim()
        .replace(/\//g, '\\')           // accept / as well as \
        .replace(/^\\+|\\+$/g, '');     // the drive prefix supplies the leading \
    sendFolder(currentDrive + (name ? name + '\\' : ''));
}

function showDrive(drive) {
    const toggle = document.getElementById('drive_toggle');
    toggle.dataset.drive = drive;   // moves the thumb (see styles.css)
    toggle.querySelectorAll('[role="radio"]').forEach(option => {
        const selected = option.dataset.drive === drive;
        option.setAttribute('aria-checked', String(selected));
        option.tabIndex = selected ? 0 : -1;
    });
    document.getElementById('path_prefix').textContent = drive.toUpperCase();
}

///////////////////////////////////////////////////////////////////////////////

function clearFileList() {
    const fileList = document.getElementById('file_list');
    fileList.innerHTML = '';
}

///////////////////////////////////////////////////////////////////////////////
// lists all the files for the folder
function populateFileList({ files = [] } = {}) {
    const fileList = document.getElementById('file_list');
    fileList.innerHTML = '';
    if (files === false) return;
    files.forEach(file => {
        const listItem = document.createElement('li');
        const link = document.createElement('a');
        link.href = `/download/${file}`;
        link.textContent = file;
        listItem.appendChild(link);
        fileList.appendChild(listItem);
    });
}

///////////////////////////////////////////////////////////////////////////////
// adds an entry to the upload log
function updateLog(data) {
    const log = document.getElementById('log');
    log.value += data;
    log.scrollTop = log.scrollHeight;
}

///////////////////////////////////////////////////////////////////////////////
// replaces the whole log (sent by the server on page load and on clear)
function setLog(data) {
    const log = document.getElementById('log');
    log.value = data || '';
    log.scrollTop = log.scrollHeight;
}

///////////////////////////////////////////////////////////////////////////////
// asks the server to clear the log for every open page
function clearLog() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ command: 'clear_log' }));
    } else {
        setLog('');
    }
}

///////////////////////////////////////////////////////////////////////////////
// asks the server to switch to another folder (e.g. 'a:\' or 'c:\TESTDIR\')
function sendFolder(folder) {
    currentDrive = folder.slice(0, 3).toLowerCase();
    showDrive(currentDrive);
    const message = {
        command: 'set_folder',
        folder,
    };
    ws.send(JSON.stringify(message));
    clearFileList();
}

///////////////////////////////////////////////////////////////////////////////

function enableDropZone() {
    let dropZone = document.getElementById('drop_zone');
    let fileInput = document.getElementById('filesToUpload');
    let maxSizeInMB = 2; // Maximum size allowed in MB
    let maxSize = maxSizeInMB * 1024 * 1024; // Convert size to bytes

    dropZone.ondragover = dropZone.ondragenter = function(evt) {
        evt.preventDefault();
        this.classList.add('over'); 
    };

    let submitButton = document.getElementById('file_submit');
    let fileName = document.getElementById('file_name');

    // shows the chosen file and enables Upload only for a valid file
    function updateSelection() {
        const file = fileInput.files[0];
        if (file && file.size > maxSize) {
            alert('File size should not exceed ' + maxSizeInMB + ' MB');
            fileInput.value = '';
        }
        const chosen = fileInput.files[0];
        fileName.textContent = chosen ? chosen.name : '';
        submitButton.disabled = !chosen;
    }

    dropZone.ondrop = function(evt) {
        // always stop the browser from opening the dropped file
        evt.preventDefault();
        this.classList.remove('over');
        if (!evt.dataTransfer.files.length) return;
        fileInput.files = evt.dataTransfer.files;
        updateSelection();
    };

    dropZone.ondragleave = function(evt) {
        if (!this.contains(evt.relatedTarget)) {
            this.classList.remove('over');
        }
    };

    fileInput.onchange = updateSelection;
    updateSelection();
}

///////////////////////////////////////////////////////////////////////////////
