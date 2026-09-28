'use strict';
const zlib = require('node:zlib');

// Fixed timestamp (1980-01-01 00:00) so the same input always gives the same bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

// Builds a ZIP archive in memory: deflate-compressed entries, UTF-8 names.
// entries: [{ name: string, data: Buffer }]. Needs Node 22.2+ for zlib.crc32.
function createZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // local file header signature
    local.writeUInt16LE(20, 4);              // version needed to extract
    local.writeUInt16LE(0x0800, 6);          // flags: names are UTF-8
    local.writeUInt16LE(8, 8);               // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    // extra field length (28) stays 0

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);     // central directory header signature
    header.writeUInt16LE(20, 4);             // version made by
    header.writeUInt16LE(20, 6);             // version needed to extract
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    // extra, comment, disk, attributes (30..41) stay 0
    header.writeUInt32LE(offset, 42);        // where this entry's local header starts

    parts.push(local, nameBuf, packed);
    central.push(header, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);          // end of central directory signature
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

module.exports = { createZip };
