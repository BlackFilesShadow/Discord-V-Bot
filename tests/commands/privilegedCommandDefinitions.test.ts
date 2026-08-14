import {
  addMoneyCommand,
  removeMoneyCommand,
  forceLinkCommand,
  forceUnlinkCommand,
  confirmActionCommand,
} from '../../src/commands/dashboard/privileged';

function option(command: { data: { toJSON(): { options?: Array<Record<string, unknown>> } } }, name: string) {
  return command.data.toJSON().options?.find(o => o.name === name);
}

describe('Phase 8 privileged command surface', () => {
  it.each([
    [addMoneyCommand, 'add-money'],
    [removeMoneyCommand, 'remove-money'],
    [forceLinkCommand, 'force-link'],
    [forceUnlinkCommand, 'force-unlink'],
    [confirmActionCommand, 'confirm-action'],
  ] as const)('registers /%s', (command, expectedName) => {
    expect(command.data.toJSON().name).toBe(expectedName);
  });

  it.each([addMoneyCommand, removeMoneyCommand, forceLinkCommand, forceUnlinkCommand])(
    'limits explicit slot selection to 1..4',
    command => {
      const slot = option(command, 'slot');
      expect(slot).toMatchObject({ min_value: 1, max_value: 4, required: false });
    },
  );

  it('uses a fixed UUID-sized confirmation id', () => {
    const id = option(confirmActionCommand, 'id');
    expect(id).toMatchObject({ min_length: 36, max_length: 36, required: true });
  });
});
