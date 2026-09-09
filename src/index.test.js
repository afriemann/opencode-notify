import { jest } from '@jest/globals';

describe('resolveNotificationConfig', () => {
  let resolveNotificationConfig;

  beforeAll(async () => {
    ({ resolveNotificationConfig } = await import('./index.js'));
  });

  const defaults = { enabled: true, urgency: 'normal', expireTimeoutMs: 20000 };

  it('returns the defaults when the value is undefined', () => {
    expect(resolveNotificationConfig(undefined, defaults)).toEqual(defaults);
  });

  it('treats a boolean value as the legacy enable/disable shorthand', () => {
    expect(resolveNotificationConfig(false, defaults)).toEqual({ ...defaults, enabled: false });
    expect(resolveNotificationConfig(true, defaults)).toEqual({ ...defaults, enabled: true });
  });

  it('merges an object value over the defaults, overriding only the given keys', () => {
    expect(resolveNotificationConfig({ urgency: 'critical' }, defaults)).toEqual({
      ...defaults,
      urgency: 'critical',
    });
  });

  it('allows an object value to disable the event while overriding other keys', () => {
    expect(resolveNotificationConfig({ enabled: false, expireTimeoutMs: 5000 }, defaults)).toEqual({
      ...defaults,
      enabled: false,
      expireTimeoutMs: 5000,
    });
  });

  it('falls back to the defaults for a null or array value', () => {
    expect(resolveNotificationConfig(null, defaults)).toEqual(defaults);
    expect(resolveNotificationConfig([1, 2], defaults)).toEqual(defaults);
  });
});
