import { createWakeupSignal } from '../../src/utils/wakeupSignal';

describe('createWakeupSignal', () => {
  it('ruft alle abonnierten Listener bei fire() synchron auf', () => {
    const signal = createWakeupSignal();
    const first = jest.fn();
    const second = jest.fn();
    signal.subscribe(first);
    signal.subscribe(second);

    signal.fire();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('ruft nach unsubscribe keinen entfernten Listener mehr auf', () => {
    const signal = createWakeupSignal();
    const listener = jest.fn();
    const unsubscribe = signal.subscribe(listener);

    unsubscribe();
    signal.fire();

    expect(listener).not.toHaveBeenCalled();
  });

  it('feuert ohne Listener folgenlos', () => {
    const signal = createWakeupSignal();
    expect(() => signal.fire()).not.toThrow();
  });

  it('isoliert einen werfenden Listener von den uebrigen Listenern und dem Producer', () => {
    const signal = createWakeupSignal();
    const broken = jest.fn(() => { throw new Error('boom'); });
    const healthy = jest.fn();
    signal.subscribe(broken);
    signal.subscribe(healthy);

    expect(() => signal.fire()).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('erlaubt mehrfaches Feuern ueber mehrere Ticks hinweg', () => {
    const signal = createWakeupSignal();
    const listener = jest.fn();
    signal.subscribe(listener);

    signal.fire();
    signal.fire();

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
