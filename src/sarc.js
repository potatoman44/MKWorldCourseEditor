// SARC archives (System/GymlArchive/*.sarc.zs): file name -> bytes
export function parseSarc(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (String.fromCharCode(...d.subarray(0, 4)) !== 'SARC') throw new Error('not a SARC archive');
  const hdr = dv.getUint16(4, true), dataOff = dv.getUint32(12, true);
  const sfat = hdr, n = dv.getUint16(sfat + 6, true);
  const sfnt = sfat + 12 + 16 * n, names = sfnt + dv.getUint16(sfnt + 4, true);
  const out = new Map(), dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const e = sfat + 12 + 16 * i, attr = dv.getUint32(e + 4, true);
    const s = dv.getUint32(e + 8, true), en = dv.getUint32(e + 12, true);
    let name = '';
    if (attr >>> 24) { const o = names + (attr & 0xffffff) * 4; let z = o; while (d[z]) z++; name = dec.decode(d.subarray(o, z)); }
    out.set(name, d.subarray(dataOff + s, dataOff + en));
  }
  return out;
}
