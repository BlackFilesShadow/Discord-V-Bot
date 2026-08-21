import fs from 'node:fs';
import path from 'node:path';

const routePath = path.join(process.cwd(), 'src/dashboard/routes/v2/devIncident.ts');
const servicePath = path.join(process.cwd(), 'src/dashboard/services/incidentResponse.ts');
const route = fs.readFileSync(routePath, 'utf8');
const service = fs.readFileSync(servicePath, 'utf8');

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

  it('does not advertise incident actions until real production coupling is allowlisted', () => {
    expect(route).toContain('export const OPERATIONAL_INCIDENT_ACTIONS: readonly IncidentAction[] = [];');
    expect(route).toContain('operationalActions: OPERATIONAL_INCIDENT_ACTIONS');
    expect(route.match(/incident_action_not_operational/g)?.length).toBe(3);
  });

  it('documents the exact coupling gap rather than treating audit state as runtime effect', () => {
    expect(service).toContain('export function isIncidentActive(');
    expect(service).toContain("'cache.flush'");
    expect(service).toContain("'backup.trigger'");
    expect(route).toContain('no production consumer of `isIncidentActive(...)`');
    expect(route).toContain('did not');
    expect(route).toContain('execute the UI-advertised cache/backup effects');
  });
});
