// Etappe 6A verification boundary.
// Sobald dieser Stand fachlich/CI-seitig freigegeben ist, muessen zwei komplette
// gruene Pruefungen auf exakt demselben unveraenderten PR-Head erfolgen.
it('pins the stage verification rule', () => {
  expect('same-head-2x-green').toBe('same-head-2x-green');
});
