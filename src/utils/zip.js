///////////////////////////////////////////////////////////////////////////////
// A minimal .zip writer for "download all files in this folder".
//
// The Portfolio's drives hold at most a few hundred KB, so the archive is
// built in memory. Each file is deflated, or stored as is when that isn't
// smaller. Only what every unzip tool needs is written: no folders, no
// extra fields, no zip64.

const zlib = require('zlib');

// MS-DOS date and time, as zip headers expect them
function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

/**
 * Builds a zip archive.
 * @param {{name: string, data: Buffer}[]} files - plain file names (no folders)
 * @param {Date} [date] - modification time for every entry
 * @returns {Buffer}
 */
function createZip(files, date = new Date()) {
    const { time, day } = dosDateTime(date);
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of files) {
        const nameBytes = Buffer.from(name, 'utf8');
        const deflated = zlib.deflateRawSync(data);
        const stored = deflated.length >= data.length;
        const body = stored ? data : deflated;
        const crc = zlib.crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);         // local file header
        local.writeUInt16LE(20, 4);                 // version needed (2.0)
        local.writeUInt16LE(0, 6);                  // flags
        local.writeUInt16LE(stored ? 0 : 8, 8);     // method: store / deflate
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(day, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);       // compressed size
        local.writeUInt32LE(data.length, 22);       // uncompressed size
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);                 // extra field length
        locals.push(local, nameBytes, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);       // central directory header
        central.writeUInt16LE(20, 4);               // version made by
        central.writeUInt16LE(20, 6);               // version needed
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(stored ? 0 : 8, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(day, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        // extra, comment, disk number, internal attributes: 0
        central.writeUInt32LE(0, 38);               // external attributes
        central.writeUInt32LE(offset, 42);          // where the local header is
        centrals.push(central, nameBytes);

        offset += local.length + nameBytes.length + body.length;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);               // end of central directory
    end.writeUInt16LE(files.length, 8);             // entries on this disk
    end.writeUInt16LE(files.length, 10);            // entries in total
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);                  // where the central directory is
    return Buffer.concat([...locals, ...centrals, end]);
}

///////////////////////////////////////////////////////////////////////////////
module.exports = { createZip };
///////////////////////////////////////////////////////////////////////////////
