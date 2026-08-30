import { describe, expect, it } from 'vitest';
import {
  createHarness,
  extensionManifest,
  flushAsyncWork,
  installedContentScripts,
  liveRequest,
  pragmaticLiveRequest,
  pragmaticOperationalRequest,
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

  it('rejects a pragmatic wager when shared-panel preparation does not activate', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
      pragmaticPrepareResult: {
        status: 'activation-control-missing',
        frameUrl: 'https://client.pragmaticplaylive.net/desktop/multibaccarat/',
        roundId: '16385991210',
      },
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticOperationalRequest()) });
    for (let tick = 0; tick < 4; tick += 1) await flushAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('executePragmaticBetOneShot')
        && Array.isArray(injection.target?.frameIds),
    )).toBe(false);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({
          commitStarted: false,
          reason: expect.stringContaining('Pragmatic target table preparation failed: activation-control-missing'),
        }),
      }),
    }));
  });

  it('routes one request to the unique matching Pragmatic frame', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    const execution = harness.executeScript.mock.calls.find(
      ([injection]) => String(injection.func).includes('executePragmaticBetOneShot')
        && Array.isArray(injection.target?.frameIds),
    );
    expect(execution?.[0].target).toEqual({ tabId: 42, frameIds: [11] });
    expect(execution?.[0].world).toBe('MAIN');
    const inputEvents = harness.chrome.debugger.sendCommand.mock.calls
      .filter(([, method]) => method === 'Input.dispatchMouseEvent')
      .map(([, , params]) => params?.type);
    expect(inputEvents).toEqual([
      'mouseMoved', 'mousePressed', 'mouseReleased',
    ]);
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(harness.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ kind: 'resolveBetFrameRect' }),
      { frameId: 11 },
    );
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'pragmatic-request-1',
      receipt: harness.pragmaticReceipt,
    }));
  });

  it('uses the same trusted-input path for a manual Pragmatic wager', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticOperationalRequest()) });
    for (let tick = 0; tick < 4; tick += 1) await flushAsyncWork();

    expect(harness.chrome.debugger.sendCommand.mock.calls.filter(
      ([, method]) => method === 'Input.dispatchMouseEvent',
    )).toHaveLength(3);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'pragmatic-operational-request-1',
      receipt: expect.objectContaining({
        wagerId: 'pragmatic-wager-1',
        status: 'ACCEPTED',
        raw: expect.objectContaining({ trustedInput: true }),
      }),
    }));
  });

  it('does not click the market when the page window has already closed', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
      pragmaticPhaseResult: command => command['phase'] === 'target' && command['action'] === 'market'
        ? {
          receiptId: 'pragmatic-window-closed',
          intentId: 'pragmatic-intent-1',
          reservationId: 'pragmatic-reservation-1',
          status: 'REJECTED',
          amount: 10,
          market: 'bankerPair',
          mode: 'live',
          raw: {
            runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
            reason: 'betting-window-closed',
            commitPoint: 'preflight',
            commitStarted: false,
          },
        }
        : undefined,
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    for (let tick = 0; tick < 4; tick += 1) await flushAsyncWork();

    const inputEvents = harness.chrome.debugger.sendCommand.mock.calls
      .filter(([, method]) => method === 'Input.dispatchMouseEvent')
      .map(([, , params]) => params?.type);
    expect(inputEvents).toEqual([]);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        raw: expect.objectContaining({ reason: 'betting-window-closed', commitStarted: false }),
      }),
    }));
  });

  it('returns UNKNOWN when a trusted market press succeeds but release fails', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
    });
    let presses = 0;
    harness.chrome.debugger.sendCommand.mockImplementation(async (_source, method, params) => {
      if (method !== 'Input.dispatchMouseEvent') return undefined;
      if (params?.type === 'mousePressed') presses += 1;
      if (params?.type === 'mouseReleased' && presses === 1) throw new Error('release failed');
      return undefined;
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    for (let tick = 0; tick < 4; tick += 1) await flushAsyncWork();

    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'UNKNOWN',
        raw: expect.objectContaining({
          commitPoint: 'market-click',
          commitStarted: true,
          marketPressDispatched: true,
          trustedInput: true,
        }),
      }),
    }));
  });

  it('routes Pragmatic execution even when the protocol round cache is stale', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
      pragmaticProtocolRoundId: '1726000000',
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    const execution = harness.executeScript.mock.calls.find(
      ([injection]) => String(injection.func).includes('executePragmaticBetOneShot')
        && Array.isArray(injection.target?.frameIds),
    );
    expect(execution?.[0].target).toEqual({ tabId: 42, frameIds: [11] });
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'pragmatic-request-1',
      receipt: harness.pragmaticReceipt,
    }));
  });

  it('routes Pragmatic execution even when the prepared round differs from the request hand', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
      pragmaticProtocolRoundId: '1726000000',
    });
    const request = pragmaticLiveRequest();
    request.request.intent.handId = '1726999999';

    harness.socket.emit('message', { data: JSON.stringify(request) });
    await flushAsyncWork();
    await flushAsyncWork();

    const execution = harness.executeScript.mock.calls.find(
      ([injection]) => String(injection.func).includes('executePragmaticBetOneShot')
        && Array.isArray(injection.target?.frameIds),
    );
    expect(execution?.[0].target).toEqual({ tabId: 42, frameIds: [11] });
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'pragmatic-request-1',
      receipt: harness.pragmaticReceipt,
    }));
  });

  it('rejects a Pragmatic request when two frames claim the same table', async () => {
    const ready = {
      status: 'ready',
      runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
      host: 'client.pragmaticplaylive.net',
      tableId: 'bc281koreanch281',
    };
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
      probeResults: [
        { frameId: 11, result: ready },
        { frameId: 12, result: ready },
      ],
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('executePragmaticBetOneShot')
        && Array.isArray(injection.target?.frameIds),
    )).toBe(false);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'REJECTED',
        receiptId: expect.stringMatching(/^pragmatic-bridge-/),
        raw: expect.objectContaining({ commitStarted: false }),
      }),
    }));
  });

  it('prefers the freshly prepared multitable frame over a duplicate dedicated frame', async () => {
    const common = {
      status: 'ready',
      runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
      host: 'client.pragmaticplaylive.net',
      tableId: 'bc281koreanch281',
    };
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
      probeResults: [
        {
          frameId: 11,
          result: {
            ...common,
            framePath: '/desktop/multibaccarat/',
            routingAuthority: 'prepared-multitable',
          },
        },
        {
          frameId: 12,
          result: {
            ...common,
            framePath: '/desktop/baccarat/',
            routingAuthority: 'dedicated-referrer',
          },
        },
      ],
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    const execution = harness.executeScript.mock.calls.find(
      ([injection]) => String(injection.func).includes('executePragmaticBetOneShot')
        && Array.isArray(injection.target?.frameIds),
    );
    expect(execution?.[0].target).toEqual({ tabId: 42, frameIds: [11] });
  });

  it('routes a Pragmatic request to the frame even when the readiness probe reports closed', async () => {
    const harness = await createHarness({
      tabs: [{
        id: 42,
        url: 'https://www.dafabet.net/sc/live-dealer/popup-launch/jeju-speed-baccarat',
      }],
      probeResults: [{
        frameId: 11,
        result: {
          status: 'closed',
          runtimeRevision: 'pragmatic-bet-runtime/2026-08-30.21',
          host: 'client.pragmaticplaylive.net',
          tableId: 'bc281koreanch281',
        },
      }],
    });

    harness.socket.emit('message', { data: JSON.stringify(pragmaticLiveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    const execution = harness.executeScript.mock.calls.find(
      ([injection]) => String(injection.func).includes('executePragmaticBetOneShot')
        && Array.isArray(injection.target?.frameIds),
    );
    expect(execution?.[0].target).toEqual({ tabId: 42, frameIds: [11] });
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      requestId: 'pragmatic-request-1',
      receipt: harness.pragmaticReceipt,
    }));
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

  it('restores the live gate from storage after the worker reloads', async () => {
    const harness = await createHarness({
      liveBetEnabled: true,
      armCurrentSession: false,
    });

    harness.socket.emit('message', { data: JSON.stringify(liveRequest()) });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(harness.executeScript.mock.calls.some(
      ([injection]) => String(injection.func).includes('executeMstromBetOneShot'),
    )).toBe(true);
    expect(sentMessages(harness.socket)).toContainEqual(expect.objectContaining({
      kind: 'betResult',
      receipt: expect.objectContaining({
        status: 'ACCEPTED',
      }),
    }));
  });

  it('does not inspect or execute frames when the persisted live gate is disabled', async () => {
    const harness = await createHarness({
      liveBetEnabled: false,
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
    expect(serializedManifest).toContain('"alarms"');

    // Then: the current mstrom game host remains explicitly covered.
    expect(serializedManifest).toContain('https://*.mstrom-uno.com/*');
    expect(serializedManifest).toContain('https://*.pragmaticplaylive.net/*');
    expect(installedContentScripts()).toContain('pragmatic-dom-hook.js');
  });
});
