import { inspectGrayRleTga } from '../../src/modules/radar/elevationTga';

function tgaWithPackets(packets: number[]): Buffer {
  const header = Buffer.alloc(18);
  header[2] = 11;
  header[12] = 4;
  header[14] = 1;
  header[16] = 8;
  header[17] = 0x20;
  return Buffer.from([...header, ...packets]);
}

describe('Livonia elevation TGA analyzer', () => {
  it('liest 8-Bit-RLE-Graustufenwerte und den Top-Origin deterministisch', () => {
    const info = inspectGrayRleTga(tgaWithPackets([0x81, 12, 0x01, 20, 30]));
    expect(info).toMatchObject({ width: 4, height: 1, imageType: 11, pixelDepth: 8, topOrigin: true, minValue: 12, maxValue: 30 });
    expect(info.histogram[12]).toBe(2);
    expect(info.histogram[20]).toBe(1);
    expect(info.histogram[30]).toBe(1);
  });

  it('lehnt nicht belegte TGA-Varianten und defekte RLE-Daten ab', () => {
    expect(() => inspectGrayRleTga(Buffer.alloc(17))).toThrow('Header');
    expect(() => inspectGrayRleTga(tgaWithPackets([0x84, 1]))).toThrow('überschreitet');
  });
});