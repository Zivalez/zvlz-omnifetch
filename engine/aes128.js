/* Dekripsi HLS AES-128-CBC (METHOD=AES-128). IV default = nomor urut media segmen. */

export function defaultIv(sequenceNumber) {
  const iv = new Uint8Array(16);
  const dv = new DataView(iv.buffer);
  dv.setUint32(12, sequenceNumber >>> 0);
  return iv;
}

export function parseIv(hex) {
  const clean = String(hex).replace(/^0x/i, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

export async function decryptAes128(data, keyBytes, ivBytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('webcrypto_unavailable');
  const key = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, data);
  return new Uint8Array(plain);
}
