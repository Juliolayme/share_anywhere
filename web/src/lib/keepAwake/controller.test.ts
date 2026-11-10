import { describe, expect, it, vi } from 'vitest';
import { KeepAwakeController, type KeepAwakeEnv } from './controller';

function stub(mode: 'granted' | 'refused' | 'unsupported') {
  const calls = { request: 0, release: 0 };
  let visible = true;
  let onVis: () => void = () => undefined;
  const releaseHandlers: (() => void)[] = [];
  const env: KeepAwakeEnv = {
    isSecure: true,
    isVisible: () => visible,
    onVisibility: (fn) => {
      onVis = fn;
      return () => undefined;
    },
    wakeLock:
      mode === 'unsupported'
        ? undefined
        : {
            request: async () => {
              calls.request++;
              if (mode === 'refused') throw new DOMException('denied', 'NotAllowedError');
              return {
                release: async () => {
                  calls.release++;
                },
                addEventListener: (_: 'release', fn: () => void) => releaseHandlers.push(fn),
              };
            },
          },
  };
  return {
    env,
    calls,
    hide: () => {
      visible = false;
      releaseHandlers.forEach((f) => f()); // the browser releases on hide
      onVis();
    },
    show: () => {
      visible = true;
      onVis();
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('KeepAwakeController', () => {
  it('acquires while active, releases when inactive, re-requests on visible', async () => {
    const s = stub('granted');
    const c = new KeepAwakeController(s.env);
    expect(c.state).toBe('paused');
    c.setActive(true);
    await flush();
    expect(s.calls.request).toBe(1);
    expect(c.state).toBe('on');
    s.hide();
    await flush();
    s.show();
    await flush();
    expect(s.calls.request).toBe(2);
    c.setActive(false);
    await flush();
    expect(s.calls.release).toBe(1);
    expect(c.state).toBe('paused');
  });

  it('never requests with the setting off, and the pill turns the setting back on', async () => {
    const s = stub('granted');
    const c = new KeepAwakeController(s.env);
    c.setSetting(false);
    c.setActive(true);
    await flush();
    expect(s.calls.request).toBe(0);
    expect(c.state).toBe('setoff');
    expect(c.tap()).toBe('setting');
  });

  it('user can turn it off for this transfer; the choice resets for the next one', async () => {
    const s = stub('granted');
    const c = new KeepAwakeController(s.env);
    c.setActive(true);
    await flush();
    c.tap();
    await flush();
    expect(c.state).toBe('off');
    expect(s.calls.release).toBe(1);
    c.setActive(false);
    c.setActive(true);
    await flush();
    expect(c.state).toBe('on');
  });

  it('reports unsupported and refused, and retries a refused request on tap', async () => {
    const u = new KeepAwakeController(stub('unsupported').env);
    u.setActive(true);
    await flush();
    expect(u.state).toBe('unsupported');
    const r = stub('refused');
    const c = new KeepAwakeController(r.env);
    const seen = vi.fn();
    c.subscribe(seen);
    c.setActive(true);
    await flush();
    expect(c.state).toBe('refused');
    c.tap();
    await flush();
    expect(r.calls.request).toBe(2);
    expect(seen).toHaveBeenCalledWith('refused');
  });
});
