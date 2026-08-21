import fs from 'node:fs';
import path from 'node:path';

const routePath = path.join(process.cwd(), 'src/dashboard/routes/v2/devIncident.ts');
const route = fs.readFileSync(routePath, 'utf8');

describe('stage 27 incident operational action architecture', () => {
  it('keeps state read behind requireDev only', () => {
    expect(route).toContain("devIncidentRouter.get('/state', requireDev");
  });

  it.each(['/activate', '/deactivate', '/oneshot'])('%s requires cryptographically verified DEV step-up after requireDev', endpoint => {
    const escaped = endpoint.replace('/', '\\/');
    const pattern = new RegExp(
      `devIncidentRouter\\.post\\('${escaped}',\\s*requireDev,\\s*requireVerifiedDevMutationStepUp,`,
    );
    expect(route).toMatch(pattern);
  });

  it('does not regress to shape-only step-up validation inside the incident router', () => {
    expect(route).not.toContain("from '../../middleware/devSecurity'");
    expect(route).not.toContain('validateStepUpInput(');
  });
});
