// Tiny fixture builders: real formats, built in memory.
function crc32(data: Uint8Array): number {
  let c = ~0
  for (const b of data) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
export function makeZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const parts: number[] = []
  const central: number[] = []
  const le = (n: number, w: number) => Array.from({ length: w }, (_, i) => (n >>> (8 * i)) & 0xff)
  for (const e of entries) {
    const name = [...new TextEncoder().encode(e.name)]
    const crc = crc32(e.data)
    const offset = parts.length
    parts.push(...le(0x04034b50, 4), ...le(20, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(crc, 4), ...le(e.data.length, 4), ...le(e.data.length, 4), ...le(name.length, 2), ...le(0, 2), ...name, ...e.data)
    central.push(...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(crc, 4), ...le(e.data.length, 4), ...le(e.data.length, 4), ...le(name.length, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...name)
  }
  const cdOffset = parts.length
  return new Uint8Array([...parts, ...central, ...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(entries.length, 2), ...le(entries.length, 2), ...le(central.length, 4), ...le(cdOffset, 4), ...le(0, 2)])
}
export const enc = (s: string) => new TextEncoder().encode(s)
export function jpegWithExif(): Uint8Array {
  const exif = [...enc('Exif\0\0GPS 37.77,-122.41')]
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, exif.length + 2, ...exif, 0xff, 0xdb, 0, 4, 1, 2, 0xff, 0xda, 0, 2, 9, 9, 9, 0xff, 0xd9])
}
export function pngWithText(): Uint8Array {
  const chunk = (type: string, data: number[]) => [...[0, 0, 0, data.length], ...enc(type), ...data, 0, 0, 0, 0]
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), ...chunk('tEXt', [...enc('Author\0alice')]), ...chunk('IEND', [])])
}
