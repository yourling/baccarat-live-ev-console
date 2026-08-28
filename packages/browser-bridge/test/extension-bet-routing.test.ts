import { describe, expect, it } from 'vitest';
import {
  createHarness,
  extensionManifest,
  flushAsyncWork,
  installedContentScripts,
  liveRequest,
  sentMessages,
} from './extension-bet-harness.js';

describe('extension background live bet routing', () => {
  it('routes one request to the unique matching mstrom frame and returns one receipt', async () => {
    const harness = await createHarness();

    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    const execution = harness.executeScript.mock.calls.find(
      ([injection]) => String(injection.func).includes('executeMstromBetOneShot'),
    );
    expect(execution?.[0].target).toEqual({ tabId: 42, frameIds: [7] });
    expect(execution?.[0].world).toBe('MAIN');
    expect(harness.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'executeBet' }),
    );
    const betResults = sentMessages(harness.socket)
      .filter(message => message['kind'] === 'betResult');
    expect(betResults).toHaveLength(1);
    expect(betResults[0]).toEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'request-1',
      receipt: harness.receipt,
      bridgeSessionId: expect.stringMatching(/^bridge-/),
      bridgeSeq: expect.any(Number),
    }));
    expect(Number.isSafeInteger(betResults[0]?.['bridgeSeq'])).toBe(true);
  });

  it('returns a precommit rejection when more than one exact Dafabet popup tab exists', async () => {
    const harness = await createHarness({
      tabs: [
        { id: 42, url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-pa' },
        { id: 43, url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/live-baccarat-pa' },
      ],
    });

    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(harness.executeScript).not.toHaveBeenCalledWith(expect.objectContaining({
      files: ['mstrom-bet-runtime.js'],
    }));
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'request-1',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({
          commitStarted: false,
          reason: expect.stringContaining('exactly one Dafabet'),
        }),
      }),
    }));
  });

  it('does not route bets through a different Dafabet page', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/another-game',
      }],
    });

    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(harness.executeScript).not.toHaveBeenCalledWith(expect.objectContaining({
      files: ['mstrom-bet-runtime.js'],
    }));
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({
          commitStarted: false,
          reason: expect.stringContaining('found 0'),
        }),
      }),
    }));
  });

  it('returns a matching operational rejection when the table frame is absent before execution', async () => {
    const harness = await createHarness({ probeResults: [] });
    const request = {
      kind: 'betRequest',
      requestId: 'operational-precommit-rejection',
      request: {
        mode: 'live',
        wager: {
          wagerId: 'opw-precommit-rejection',
          tableId: 'D067',
          shoeId: 'shoe-1',
          handId: 'GD06726824AB',
          market: 'player',
          amount: 20,
          source: 'keepalive',
          createdAt: '2026-08-24T12:00:00.000Z',
        },
      },
    };

    harness.socket.emit('message', { data: JSON.stringify(request) });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('executeMstromBetOneShot'),
    )).toBe(false);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: request.requestId,
      receipt: expect.objectContaining({
        wagerId: request.request.wager.wagerId,
        tableId: request.request.wager.tableId,
        handId: request.request.wager.handId,
        status: 'REJECTED',
        raw: expect.objectContaining({
          commitPoint: 'preflight',
          commitStarted: false,
        }),
      }),
    }));
  });

  it('fails closed when two frames expose the requested table store', async () => {
    const harness = await createHarness({
      probeResults: [
        { frameId: 7, result: { status: 'ready', runtimeRevision: 'mstrom-bet-runtime/2026-08-28.1', host: 'gci.agad.mstrom-uno.com', tableId: 'D067' } },
        { frameId: 9, result: { status: 'ready', runtimeRevision: 'mstrom-bet-runtime/2026-08-28.1', host: 'live2.673ing.com', tableId: 'D067' } },
      ],
    });

    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('executeMstromBetOneShot'),
    )).toBe(false);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({
          commitStarted: false,
          reason: expect.stringContaining('exactly one matching frame'),
        }),
      }),
    }));
  });

  it('fails closed before confirmBet when the injected runtime revision is obsolete', async () => {
    const harness = await createHarness({
      probeResults: [{
        frameId: 7,
        result: {
          status: 'ready',
          host: 'gci.agad.mstrom-uno.com',
          tableId: 'D067',
        },
      }],
    });

    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('executeMstromBetOneShot'),
    )).toBe(false);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'request-1',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({
          commitStarted: false,
          reason: expect.stringContaining('matching frame'),
        }),
      }),
    }));
  });

  it('does not inspect or execute frames without liveOn in the current worker session', async () => {
    const harness = await createHarness({
      liveBetEnabled: true,
      armCurrentSession: false,
    });

    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(harness.executeScript).not.toHaveBeenCalledWith(expect.objectContaining({
      files: ['mstrom-bet-runtime.js'],
    }));
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({
          commitStarted: false,
          reason: expect.stringContaining('disabled'),
        }),
      }),
    }));
  });

  it('deduplicates repeated requestIds and emits exactly one betResult', async () => {
    const harness = await createHarness();
    const message = { data: JSON.stringify(liveRequest('duplicate-request')) };

    harness.socket.emit('message', message);
    harness.socket.emit('message', message);
    await flushAsyncWork();
    await flushAsyncWork();

    expect(harness.executeScript.mock.calls.filter(
      ([injection]) => String(injection.func).includes('executeMstromBetOneShot'),
    )).toHaveLength(1);
    expect(sentMessages(harness.socket).filter(
      sent => sent['kind'] === 'betResult' && sent['requestId'] === 'duplicate-request',
    )).toHaveLength(1);
  });

  it('keeps a requestId single-shot after the request cache exceeds its previous limit', async () => {
    const harness = await createHarness();
    for (let index = 0; index <= 500; index += 1) {
      harness.socket.emit('message', { data: JSON.stringify(liveRequest(`request-${index}`)) });
    }
    for (let tick = 0; tick < 6; tick += 1) await flushAsyncWork();

    const executeCount = harness.executeScript.mock.calls.filter(
      ([injection]) => String(injection.func).includes('executeMstromBetOneShot'),
    ).length;
    const requestZeroResults = sentMessages(harness.socket).filter(
      sent => sent['kind'] === 'betResult' && sent['requestId'] === 'request-0',
    );

    harness.socket.emit('message', { data: JSON.stringify(liveRequest('request-0')) });
    for (let tick = 0; tick < 3; tick += 1) await flushAsyncWork();

    expect(harness.executeScript.mock.calls.filter(
      ([injection]) => String(injection.func).includes('executeMstromBetOneShot'),
    )).toHaveLength(executeCount);
    expect(sentMessages(harness.socket).filter(
      sent => sent['kind'] === 'betResult' && sent['requestId'] === 'request-0',
    )).toHaveLength(requestZeroResults.length);
    expect(requestZeroResults).toHaveLength(1);
  });

  it('does not install the obsolete isolated-world bet adapter as a content script', () => {
    const installedScripts = installedContentScripts();

    expect(installedScripts).not.toContain('site-adapter.js');
    expect(installedScripts).not.toContain('bet-executor.js');
  });

  it('limits extension injection to known game hosts', () => {
    // Given: the packaged extension manifest.
    const serializedManifest = JSON.stringify(extensionManifest);

    // When: its host permissions and content-script matches are inspected.
    expect(serializedManifest).not.toContain('<all_urls>');

    // Then: the current mstrom game host remains explicitly covered.
    expect(serializedManifest).toContain('https://*.mstrom-uno.com/*');
  });
});
