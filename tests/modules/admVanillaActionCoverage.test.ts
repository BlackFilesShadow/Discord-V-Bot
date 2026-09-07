import { newDateContext, parseAdmLine } from '../../src/modules/nitrado/adm/admLineParser';
import { categoryForEvent, kindForEvent } from '../../src/modules/gameplayFeeds/types';

function ctx() {
  return newDateContext(new Date(Date.UTC(2026, 8, 7)));
}

function parse(action: string) {
  return parseAdmLine(`12:00:00 | Player "Builder" (id=dayz-guid pos=<100.1, 20.2, 300.3>) ${action}`, ctx());
}

describe('ADM vanilla gameplay action coverage', () => {
  test('keeps placement strictly separate from the build feed', () => {
    const event = parseAdmLine(
      '12:00:00 | Player "Builder" (id=dayz-guid, pos=<100.1, 20.2, 300.3>) placed Nameless Object<GardenPlot>',
      ctx(),
    );

    expect(event).toMatchObject({
      eventType: 'PLACEMENT',
      objectType: 'Nameless Object<GardenPlot>',
      actorName: 'Builder',
      actorGameId: 'dayz-guid',
    });
    expect(kindForEvent(event!.eventType)).toBe('PLACEMENT');
    expect(categoryForEvent(event!.eventType)).toBe('PLACEMENT');
  });

  test('maps only constructive vanilla basebuilding actions to BUILD', () => {
    const built = parse('Built wall_base_down on Fence with Hatchet');
    expect(built).toMatchObject({
      eventType: 'BUILD',
      objectType: 'wall_base_down on Fence',
      toolOrWeapon: 'Hatchet',
    });

    // ActionMountBarbedWire.GetAdminLogMessage() contains its own Player token
    // inside the already prefixed PluginAdminLog action line.
    const mounted = parse('Player Builder<123> Mounted BarbedWire on Fence');
    expect(mounted).toMatchObject({
      eventType: 'BUILD',
      objectType: 'BarbedWire on Fence',
      toolOrWeapon: null,
    });

    expect(kindForEvent(built!.eventType)).toBe('BUILD');
    expect(categoryForEvent(built!.eventType)).toBe('BUILD');
    expect(kindForEvent(mounted!.eventType)).toBe('BUILD');
    expect(categoryForEvent(mounted!.eventType)).toBe('BUILD');
  });

  test('maps vanilla part dismantling to DISMANTLE without losing part, parent or tool', () => {
    const event = parse('Dismantled wall_base_down from Fence with Hatchet');
    expect(event).toMatchObject({
      eventType: 'DISMANTLE',
      objectType: 'wall_base_down from Fence',
      toolOrWeapon: 'Hatchet',
    });
    expect(kindForEvent(event!.eventType)).toBe('BUILD');
    expect(categoryForEvent(event!.eventType)).toBe('DISMANTLE');
  });

  test.each([
    ['packed tent', 'packed Large Tent with Hands', 'Large Tent', 'Hands'],
    ['packed improvised shelter', 'packed Improvised Shelter with Hands', 'Improvised Shelter', 'Hands'],
    ['packed leather shelter', 'packed Leather Shelter with Hands', 'Leather Shelter', 'Hands'],
    ['packed tarp shelter', 'packed Tarp Shelter with Hands', 'Tarp Shelter', 'Hands'],
    ['folded fence construction', 'folded Fence', 'Fence', null],
    ['folded watchtower construction', 'folded Watchtower', 'Watchtower', null],
    ['folded flag-pole construction', 'folded Flag Pole', 'Flag Pole', null],
  ])('classifies %s as DISMANTLE', (_label, action, objectType, tool) => {
    const event = parse(action);
    expect(event).toMatchObject({ eventType: 'DISMANTLE', objectType, toolOrWeapon: tool });
    expect(categoryForEvent(event!.eventType)).toBe('DISMANTLE');
  });

  test('classifies unmounted barbed wire as DISMANTLE and never BUILD', () => {
    const event = parse('Player Builder<123> Unmounted BarbedWire from Watchtower');
    expect(event).toMatchObject({
      eventType: 'DISMANTLE',
      objectType: 'BarbedWire from Watchtower',
      toolOrWeapon: null,
    });
    expect(categoryForEvent(event!.eventType)).toBe('DISMANTLE');
  });

  test('keeps destructive vanilla actions in DESTROY only', () => {
    const part = parse('destroyed Watchtower with Hatchet');
    const lock = parse('destroyed combination lock with Hacksaw');

    expect(part).toMatchObject({ eventType: 'DESTROY', objectType: 'Watchtower', toolOrWeapon: 'Hatchet' });
    expect(lock).toMatchObject({ eventType: 'DESTROY', objectType: 'combination lock', toolOrWeapon: 'Hacksaw' });
    expect(categoryForEvent(part!.eventType)).toBe('DESTROY');
    expect(categoryForEvent(lock!.eventType)).toBe('DESTROY');
  });

  test.each([
    ['repair', 'repaired Fence with Epoxy Putty'],
    ['deprecated re-pack', 're-packed Large Tent with Hands'],
    ['stash burial', 'Dug in Wooden Crate at position <100, 20, 300>'],
    ['stash dig-out', 'Dug out Wooden Crate at position <100, 20, 300>'],
  ])('does not mix %s into Placement/Build/Dismantle/Destroy', (_label, action) => {
    const event = parse(action);
    expect(event?.eventType).toBe('UNKNOWN');
    expect(kindForEvent(event!.eventType)).toBeNull();
    expect(categoryForEvent(event!.eventType)).toBeNull();
  });

  test('does not classify chat text containing build verbs as gameplay actions', () => {
    expect(parseAdmLine(
      '12:00:00 | Chat("Builder"(id=dayz-guid)): I dismantled Fence with Hammer',
      ctx(),
    )).toBeNull();
  });

  test('does not accept a pseudo build line without the canonical action position prefix', () => {
    const event = parseAdmLine(
      '12:00:00 | Player "Builder" (id=dayz-guid) dismantled Fence with Hammer',
      ctx(),
    );
    expect(event?.eventType).toBe('UNKNOWN');
  });

  test('accepts vanilla flag actions for TerritoryFlag and derived totem classes without build mixing', () => {
    const territory = parseAdmLine(
      '12:01:00 | Player "Builder" (id=dayz-guid pos=<100, 20, 300>) has raised Flag_Base on TerritoryFlag at <101, 21, 301>',
      ctx(),
    );
    const staticPole = parseAdmLine(
      '12:02:00 | Player "Builder" (id=dayz-guid pos=<100, 20, 300>) has lowered Flag_Base on StaticFlagPole at <101, 21, 301>',
      ctx(),
    );

    expect(territory).toMatchObject({ eventType: 'FLAG_RAISED', targetName: 'TerritoryFlag' });
    expect(staticPole).toMatchObject({ eventType: 'FLAG_LOWERED', targetName: 'StaticFlagPole' });
    expect(kindForEvent(territory!.eventType)).toBe('FLAG');
    expect(kindForEvent(staticPole!.eventType)).toBe('FLAG');
  });
});
