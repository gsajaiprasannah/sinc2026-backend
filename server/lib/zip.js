// Minimal ZIP writer, used by the bulk "download these documents" routes.
//
// Deliberately no dependency and no compression: every file that goes in here
// is a JPEG, PNG or PDF, all of which are already compressed — deflating them
// again buys ~0% and costs CPU on a small Render instance. So entries are
// stored (method 0), which also keeps this small enough to read in one sitting.
//
// Format reference: PKWARE APPNOTE 4.3 — local file header, then one central
// directory header per entry, then the end-of-central-directory record.
// ZIP64 is not implemented: the archive must stay under 4GB and 65535 files,
// which a congress-sized document export is never close to.

// CRC-32 (IEEE 802.3), table built once on first use.
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// MS-DOS date/time, which is what ZIP stores. Seconds have 2-second
// resolution and the year is offset from 1980 — both are format limitations,
// not bugs.
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ name, data }] — name is the path inside the archive, data a Buffer.
// Duplicate names are de-duplicated with a numeric suffix, since two people
// can easily upload "scan.jpg" and a ZIP with repeated names extracts badly.
function createZip(entries) {
  const now = new Date();
  const { time, date } = dosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;
  const usedNames = new Set();

  for (const entry of entries) {
    let name = entry.name;
    if (usedNames.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (usedNames.has(`${stem} (${n})${ext}`)) n++;
      name = `${stem} (${n})${ext}`;
    }
    usedNames.add(name);

    const nameBuf = Buffer.from(name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);  // local file header signature
    local.writeUInt16LE(20, 4);          // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6);      // flags: bit 11 = filename is UTF-8
    local.writeUInt16LE(0, 8);           // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size == uncompressed
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);     // central directory header signature
    cd.writeUInt16LE(20, 4);             // version made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra length
    cd.writeUInt16LE(0, 32);             // comment length
    cd.writeUInt16LE(0, 34);             // disk number start
    cd.writeUInt16LE(0, 36);             // internal attributes
    cd.writeUInt32LE(0, 38);             // external attributes
    cd.writeUInt32LE(offset, 42);        // offset of local header
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);     // end of central directory signature
  eocd.writeUInt16LE(0, 4);              // this disk number
  eocd.writeUInt16LE(0, 6);              // disk with central directory
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);// total entries
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);        // central directory offset
  eocd.writeUInt16LE(0, 20);             // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// Filename sanitiser for entries *inside* an archive. Deliberately gentler
// than uploadHelper's safeName(), which is for storage keys and flattens
// spaces to underscores — a ZIP someone opens in Finder or Explorer should
// read "Mrs Aruna Anand - SINC2026-0058.pdf", not "Mrs_Aruna_Anand_-_...".
// Only strips what a filesystem actually rejects, plus leading/trailing dots
// and spaces (which Windows silently mangles).
function zipSafeName(s) {
  return String(s == null ? '' : s)
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120) || 'unnamed';
}

module.exports = { createZip, crc32, zipSafeName };
