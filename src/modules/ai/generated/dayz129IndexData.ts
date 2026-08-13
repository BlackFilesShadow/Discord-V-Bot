// GENERATED PAYLOAD: exact compact index built from the three supplied DayZ 1.29 datasets.
// The committed payload was damaged late in the compressed stream. The repair suffix below
// is reconstructed from the exact supplied ZIP corpus and restores the original gzip bytes.
import chunk00 from './dayz129IndexChunks/chunk00';
import chunk01 from './dayz129IndexChunks/chunk01';
import chunk02 from './dayz129IndexChunks/chunk02';
import chunk03 from './dayz129IndexChunks/chunk03';
import tail00 from './dayz129IndexChunks/tail00';
import tail01 from './dayz129IndexChunks/tail01';
import tail02 from './dayz129IndexChunks/tail02';
import tail03 from './dayz129IndexChunks/tail03';
import tail04 from './dayz129IndexChunks/tail04';
import tail05 from './dayz129IndexChunks/tail05';
import tail06 from './dayz129IndexChunks/tail06';
import repairSuffixA from './dayz129IndexRepairSuffixA';
import repairSuffixB from './dayz129IndexRepairSuffixB';

const embeddedPayload = [
  chunk00, chunk01, chunk02, chunk03,
  tail00, tail01, tail02, tail03, tail04, tail05, tail06,
].join('');

// Verified byte-for-byte against the reconstructed original payload:
// - insert the single missing base64 character at offset 114480;
// - restore six corrupted base64 characters around offset 119007;
// - replace the damaged compressed tail from offset 123020 onward.
export const DAYZ129_INDEX_GZIP_BASE64 = [
  embeddedPayload.slice(0, 114480),
  '/',
  embeddedPayload.slice(114480, 119006),
  'tyB1s',
  embeddedPayload.slice(119011, 119012),
  'm',
  embeddedPayload.slice(119013, 123019),
  repairSuffixA,
  repairSuffixB,
].join('');
