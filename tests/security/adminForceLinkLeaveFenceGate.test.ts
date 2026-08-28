import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/linking/adminForceLink.ts'), 'utf8');

describe('admin force-link leave fence gate', () => {
  it('keeps fast and transactional leave cleanup guards', () => {
    expect(source).toContain('await assertNoOpenLeaveCleanupRequest');
    expect(source).toContain('leaveCleanupJobKey');
    expect(source).toContain('leaveCleanupReceiptFingerprint');
    expect(source).toContain('LeaveCleanupPendingError');
  });
});
