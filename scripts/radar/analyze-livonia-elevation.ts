import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectGrayRleTga } from '../../src/modules/radar/elevationTga';

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) throw new Error('Verwendung: ts-node scripts/radar/analyze-livonia-elevation.ts <elevation.tga>');

  const source = await readFile(input);
  const info = inspectGrayRleTga(source);
  const populatedValues = info.histogram.reduce<number[]>((values, count, value) => {
    if (count > 0) values.push(value);
    return values;
  }, []);

  console.log(JSON.stringify({
    sha256: createHash('sha256').update(source).digest('hex'),
    ...info,
    distinctValues: populatedValues.length,
  }, null, 2));
}

void main();