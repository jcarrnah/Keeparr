import { describe, it, expect } from 'vitest';
import { checkSessionSecret } from '@/instrumentation';

const INSECURE = 'dev-insecure-session-secret-change-me';
const STRONG = 'a'.repeat(64); // 64 hex chars, e.g. openssl rand -hex 32

describe('checkSessionSecret', () => {
  it('is fatal in production when unset', () => {
    expect(checkSessionSecret(undefined, true).level).toBe('fatal');
  });

  it('is fatal in production on the insecure default', () => {
    expect(checkSessionSecret(INSECURE, true).level).toBe('fatal');
  });

  it('is only a dev-fallback (not fatal) outside production', () => {
    expect(checkSessionSecret(undefined, false).level).toBe('ok');
    expect(checkSessionSecret(INSECURE, false).level).toBe('ok');
  });

  it('warns on a set-but-short secret', () => {
    expect(checkSessionSecret('short', true).level).toBe('warn');
    expect(checkSessionSecret('short', false).level).toBe('warn');
  });

  it('is ok with a strong secret', () => {
    expect(checkSessionSecret(STRONG, true).level).toBe('ok');
  });
});
