import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

interface CrudMatrix {
  operationalActions: Array<{ surface: string; evidence: string[] }>;
}

interface ActionSurface {
  surface: string;
  status: string;
  actionFamily: string;
  authScope: string;
  stepUp: string;
  idempotency: string;
  effect: string;
  evidence: string[];
}

interface ActionRow {
  id: string;
  surface: string;
  sourceUi: string;
  visibleName: string;
  permission: string;
  authN: string;
  authZ: string;
  scope: string;
  request: string;
  httpMethod: string;
  route: string;
  payload: string;
  validation: string;
  stepUpReAuth: string;
  idempotency: string;
  doubleClick: string;
  race: string;
  retry: string;
  timeout: string;
  statusCodes: string;
  realSideEffect: string;
  audit: string;
  successState: string;
  errorState: string;
  mobile: string;
  tests: string;
  residualRisk: string;
  status: string;
}

interface ActionMatrix {
  schemaVersion: number;
  stage: number;
  basedOnMainSha: string;
  contracts: Record<string, string>;
  surfaces: ActionSurface[];
  actions: ActionRow[];
}

const crud = JSON.parse(read('docs/dashboard-crud-matrix.json')) as CrudMatrix;
const actions = JSON.parse(read('docs/dashboard-action-matrix.json')) as ActionMatrix;
const v2 = read('src/dashboard/routes/v2.ts');
const incidentRoute = read('src/dashboard/routes/v2/devIncident.ts');
const incidentUi = read('dashboard-ui/src/pages/dev/IncidentResponse.tsx');

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

describe('Stage 27 dashboard action matrix architecture', () => {
  it('covers exactly every Stage-26 operational surface without silently dropping or inventing one', () => {
    const expected = sorted(crud.operationalActions.map(row => row.surface));
    const actual = sorted(actions.surfaces.map(row => row.surface));
    expect(actions.stage).toBe(27);
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it('requires complete operational contracts and repository-backed evidence for every surface', () => {
    for (const surface of actions.surfaces) {
      expect(surface.status.trim()).not.toBe('');
      expect(surface.actionFamily.trim()).not.toBe('');
      expect(surface.authScope.trim()).not.toBe('');
      expect(surface.stepUp.trim()).not.toBe('');
      expect(surface.idempotency.trim()).not.toBe('');
      expect(surface.effect.trim()).not.toBe('');
      expect(surface.evidence.length).toBeGreaterThan(0);
      for (const evidence of surface.evidence) {
        expect(fs.existsSync(path.join(root, evidence))).toBe(true);
      }
    }
  });

  it('keeps central request idempotency in front of all v2 operational actions', () => {
    const auth = v2.indexOf('v2Router.use(requireAuth);');
    const idempotency = v2.indexOf('v2Router.use(idempotency);');
    expect(auth).toBeGreaterThan(-1);
    expect(idempotency).toBeGreaterThan(auth);

    for (const mount of [
      "v2Router.use('/dev/nitrado-mirror'",
      "v2Router.use('/dev/incident'",
      "v2Router.use('/dev/stubs'",
      "v2Router.use('/dev/secure-export'",
    ]) {
      expect(v2.indexOf(mount)).toBeGreaterThan(idempotency);
    }
  });

  it('keeps sensitive DEV action families behind server-verified step-up', () => {
    expect(v2).toContain("v2Router.use('/dev/incident', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp, devIncidentRouter);");
    expect(v2).toContain("v2Router.use('/dev/stubs', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp, devDiagnosticsStubsRouter, devStubsRouter);");
    expect(v2).toContain("v2Router.use('/dev/secure-export', requireGlobalDeveloperIdentity, requireDev, requireVerifiedDevMutationStepUp, devSecureExportRouter);");

    const nitrado = read('src/dashboard/routes/v2/devNitradoMirror.ts');
    expect(nitrado).toContain("devNitradoMirrorRouter.post('/trigger', requireVerifiedDevMutationStepUp, triggerLimiter");
  });

  it('pins false-success incident controls fail closed until production coupling exists', () => {
    const incident = actions.surfaces.find(row => row.surface === 'dev-incident-response');
    expect(incident?.status).toBe('fail-closed-unavailable');
    expect(incidentRoute).toContain('export const OPERATIONAL_INCIDENT_ACTIONS: readonly IncidentAction[] = [];');
    expect(incidentRoute).toContain("bad(res, 503, 'incident_action_not_operational')");
    expect(incidentUi).toContain('const operationalActions = state?.operationalActions ?? [];');
    expect(incidentUi).toContain('Incident-Aktionen nicht freigegeben');
  });

  it('inventories concrete operational actions with Stage-27 Pflichtfelder and surface coverage', () => {
    expect(Array.isArray(actions.actions)).toBe(true);
    expect(actions.actions.length).toBeGreaterThanOrEqual(9);

    const required: Array<keyof ActionRow> = [
      'id', 'surface', 'sourceUi', 'visibleName', 'permission', 'authN', 'authZ', 'scope',
      'request', 'httpMethod', 'route', 'payload', 'validation', 'stepUpReAuth', 'idempotency',
      'doubleClick', 'race', 'retry', 'timeout', 'statusCodes', 'realSideEffect', 'audit',
      'successState', 'errorState', 'mobile', 'tests', 'residualRisk', 'status',
    ];

    const surfaceSet = new Set(actions.surfaces.map(row => row.surface));
    const actionSurfaces = new Set<string>();
    const ids = new Set<string>();

    for (const row of actions.actions) {
      for (const key of required) {
        expect(String(row[key] ?? '').trim()).not.toBe('');
      }
      expect(surfaceSet.has(row.surface)).toBe(true);
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
      actionSurfaces.add(row.surface);
    }

    expect(sorted([...actionSurfaces])).toEqual(sorted([...surfaceSet]));

    const incidentActions = actions.actions.filter(row => row.surface === 'dev-incident-response');
    expect(incidentActions.length).toBeGreaterThanOrEqual(4);
    expect(incidentActions.every(row => row.status === 'fail-closed-unavailable')).toBe(true);
    expect(incidentActions.some(row => row.id.includes('cache.flush'))).toBe(true);
    expect(incidentActions.some(row => row.id.includes('backup.trigger'))).toBe(true);
  });
});
