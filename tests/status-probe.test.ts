import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StatusService } from '../src/main/status-service';
import { DEFAULT_LAUNCH_OPTIONS } from '../src/shared/types';

/**
 * Regression cover for a latch that froze the whole UI.
 *
 * `probe()` guards re-entry with `probeInFlight`, but that flag used to be cleared
 * only on the happy path. The first probe of the session ran while no directory was
 * chosen yet, returned early, and left the flag set, so every later poll and every
 * refresh after picking a folder was skipped. The status stayed pinned at "No
 * AgentCraft directory selected." and the console never received probe output.
 *
 * Both probes below take an early return before any PowerShell is spawned: the first
 * because there is no directory, the second because the directory has no
 * tools/launch.ps1. That keeps the test deterministic and process-free while still
 * exercising the real flag.
 */
function makeService(dir: () => string, statuses: unknown[] = []) {
  const service = new StatusService(
    {
      agentcraftDir: dir,
      launchOptions: () => DEFAULT_LAUNCH_OPTIONS,
      apiKey: () => null,
      isBusy: () => false,
    },
    (_channel, payload) => statuses.push(payload),
  );
  return { service, statuses };
}

describe('StatusService probe latch', () => {
  it('keeps probing after the first probe returns early', async () => {
    let dir = '';
    const { service } = makeService(() => dir);

    await service.probe();
    expect(service.snapshot().reason).toBe('No AgentCraft directory selected.');

    // A folder that exists but is not an AgentCraft checkout: early return, no spawn.
    const notACheckout = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-not-a-checkout-'));
    dir = notACheckout;

    await service.probe();
    const after = service.snapshot();

    // Before the fix this still read "No AgentCraft directory selected.", because the
    // second probe was swallowed by the stuck flag.
    expect(after.reason).not.toBe('No AgentCraft directory selected.');
    expect(after.reason).toMatch(/launch\.ps1/i);
    expect(after.agentcraftDir).toBe(notACheckout);

    fs.rmSync(notACheckout, { recursive: true, force: true });
  });

  it('reports a valid checkout once one is chosen', async () => {
    const checkout = process.env.AGENTCRAFT_DIR;
    if (!checkout || !fs.existsSync(path.join(checkout, 'tools', 'launch.ps1'))) {
      // Nothing to assert without a real checkout on this machine.
      return;
    }

    let dir = '';
    const { service } = makeService(() => dir);
    await service.probe();
    dir = checkout;
    await service.probe();

    expect(service.snapshot().valid).toBe(true);
    expect(service.snapshot().agentcraftDir).toBe(checkout);
  });

  it('emits a status event for every probe, including the early returns', async () => {
    const { service, statuses } = makeService(() => '');
    await service.probe();

    const statusEvents = statuses.filter(
      (event) => (event as { checking?: boolean })?.checking === false,
    );
    // One "checking" event on entry plus one settled event from the finally block.
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
  });
});