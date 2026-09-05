export interface ElevationTgaInfo {
  width: number;
  height: number;
  imageType: number;
  pixelDepth: number;
  topOrigin: boolean;
  minValue: number;
  maxValue: number;
  histogram: readonly number[];
}

function readUint16(buffer: Buffer, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8);
}

/** Decodes the RLE-gray TGA variant used by the official Livonia CE layer. */
export function inspectGrayRleTga(buffer: Buffer): ElevationTgaInfo {
  if (buffer.length < 18) throw new Error('TGA-Header ist unvollstaendig.');
  const idLength = buffer[0];
  const colorMapType = buffer[1];
  const imageType = buffer[2];
  const width = readUint16(buffer, 12);
  const height = readUint16(buffer, 14);
  const pixelDepth = buffer[16];
  const descriptor = buffer[17];
  if (colorMapType !== 0 || imageType !== 11 || pixelDepth !== 8 || width === 0 || height === 0) {
    throw new Error('Erwartet wird ein ungepalettiertes 8-Bit-RLE-Graustufen-TGA.');
  }

  const pixelCount = width * height;
  const histogram = new Array<number>(256).fill(0);
  let offset = 18 + idLength;
  let decoded = 0;
  let minValue = 255;
  let maxValue = 0;
  const record = (value: number, count: number): void => {
    histogram[value] += count;
    minValue = Math.min(minValue, value);
    maxValue = Math.max(maxValue, value);
  };

  while (decoded < pixelCount) {
    if (offset >= buffer.length) throw new Error('TGA-RLE-Daten enden vor dem erwarteten Pixelumfang.');
    const packet = buffer[offset++];
    const count = (packet & 0x7f) + 1;
    if (decoded + count > pixelCount) throw new Error('TGA-RLE-Paket überschreitet den Pixelumfang.');
    if ((packet & 0x80) !== 0) {
      if (offset >= buffer.length) throw new Error('TGA-RLE-Wiederholungspaket ist unvollstaendig.');
      record(buffer[offset++], count);
    } else {
      if (offset + count > buffer.length) throw new Error('TGA-Rohdatenpaket ist unvollstaendig.');
      for (let index = 0; index < count; index += 1) record(buffer[offset + index], 1);
      offset += count;
    }
    decoded += count;
  }

  return { width, height, imageType, pixelDepth, topOrigin: (descriptor & 0x20) !== 0, minValue, maxValue, histogram };
}