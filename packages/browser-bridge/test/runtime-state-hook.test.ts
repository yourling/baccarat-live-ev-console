import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const hookSource = readFileSync(
  new URL('../../../apps/browser-extension/runtime-state-hook.js', import.meta.url),
  'utf8',
);

const contentRelaySource = readFileSync(
  new URL('../../../apps/browser-extension/content.js', import.meta.url),
  'utf8',
);

interface PostedMessage {
  readonly source?: unknown;
  readonly data?: unknown;
}

function runHook(
  gmstatus: number,
  playerCards: readonly number[] = [0x38, 0x12, 0x03],
  hostname = 'gci.agad.mstrom-uno.com',
): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const postMessage = vi.fn((message: PostedMessage) => {
    messages.push(message);
  });
  const context = vm.createContext({
    location: { hostname, href: `https://${hostname}/ogplus/` },
    window: { postMessage },
    setInterval: vi.fn(),
    Map,
    Array,
    Number,
    JSON,
    Date,
    GameBac: {
      GameStore: {
        list: [{
          vid: 'D065',
          gameSnapshot: {
            gmtype: 'BAC',
            gmcode: 'GD065268221A8',
            gmstatus,
            pval: 3,
            bval: 4,
            pcard: playerCards,
            bcard: [0x39, 0x05],
          },
        }],
      },
      PokerStore: { instance: null },
    },
  });
  vm.runInContext(hookSource, context);
  return messages;
}

function runLobbyRoadStoreHook(): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const context = vm.createContext({
    location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
    window: { postMessage: (message: PostedMessage) => { messages.push(message); } },
    setInterval: vi.fn(),
    Map,
    Array,
    Number,
    JSON,
    Date,
    VideoGameCore: {
      RoadStoreFactory: {
        instance: {
          pokerStoreMap: {
            keys: ['D065'],
            get: (tableId: string) => tableId === 'D065'
              ? {
                  gameStore: {
                    vid: 'D065',
                    gameSnapshot: {
                      gmtype: 'BAC',
                      gmcode: 'GD065268221A8',
                      gmstatus: 0,
                      pval: 3,
                      bval: 4,
                      pcard: [0x38, 0x12, 0x03],
                      bcard: [0x39, 0x05],
                    },
                  },
                }
              : undefined,
          },
        },
      },
    },
  });
  vm.runInContext(hookSource, context);
  return messages;
}

function runLinkStoreHook(): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const context = vm.createContext({
    location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
    window: { postMessage: (message: PostedMessage) => { messages.push(message); } },
    setInterval: vi.fn(),
    Map,
    Array,
    Number,
    JSON,
    Date,
    VideoGameCore: {
      LinkStoreFactory: {
        instance: {
          pokerStoreMap: { keys: ['D055'], get: () => ({
            vid: 'D055',
            snapshot: {
              gmtype: 'BAC',
              gmcode: 'GD055268221A8',
              gmstatus: 0,
              pval: 6,
              bval: 8,
              pcard: [0x16, 0x26],
              bcard: [0x12, 0x16],
            },
          }) },
          singleSocketGameStoreMap: { keys: [], get: () => undefined },
        },
      },
    },
  });
  vm.runInContext(hookSource, context);
  return messages;
}

function runLiveStoreHook(): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const pokerStore = {
    vid: 'D065',
    snapshot: {
      gmtype: 'BAC',
      gmcode: 'GD065268221A8',
      gmstatus: 0,
      pval: 3,
      bval: 4,
      pcard: [0x38, 0x12, 0x03],
      bcard: [0x39, 0x05],
    },
  };
  const context = vm.createContext({
    location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
    window: { postMessage: (message: PostedMessage) => { messages.push(message); } },
    setInterval: vi.fn(),
    Map,
    Array,
    Number,
    JSON,
    Date,
    VideoGameCore: {
      Live: {
        StoreFactory: { instance: { pokerStoreMap: { keys: ['D065'], get: () => pokerStore } } },
        LiveStore: { instance: { vids: ['D065'] } },
      },
    },
  });
  vm.runInContext(hookSource, context);
  return messages;
}

function runVisibleLinkStoreHook(): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const visibleTableIds = ['D055', 'D056', 'D057', 'D065'];
  const allTableIds = [...visibleTableIds, 'D069'];
  const gameStores = new Map(allTableIds.map((tableId, index) => [
    tableId,
    {
      vid: tableId,
      gameSnapshot: {
        gmtype: 'BAC',
        gmcode: `G${tableId}`,
        gmstatus: 0,
        pval: index,
        bval: index + 1,
        pcard: [index + 1],
        bcard: [0x11 + index],
      },
    },
  ]));
  const context = vm.createContext({
    location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
    window: { postMessage: (message: PostedMessage) => { messages.push(message); } },
    setInterval: vi.fn(),
    setTimeout: vi.fn(),
    Map,
    Array,
    Number,
    JSON,
    Date,
    VideoGameCore: {
      GameLinkStore: { instance: { visibleVids: visibleTableIds } },
      LinkStoreFactory: {
        instance: {
          pokerStoreMap: {
            keys: allTableIds,
            get: (tableId: string) => {
              const gameStore = gameStores.get(tableId);
              return gameStore === undefined ? undefined : { vid: tableId, gameStore };
            },
          },
          singleSocketGameStoreMap: { keys: [], get: () => undefined },
        },
      },
    },
  });
  vm.runInContext(hookSource, context);
  return messages;
}

function runEmptyVisibleLinkStoreHook(): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const roadStore = {
    vid: 'D065',
    gameSnapshot: {
      gmtype: 'BAC',
      gmcode: 'GD065268221F0',
      gmstatus: 0,
      pval: 3,
      bval: 4,
      pcard: [0x13, 0x23],
      bcard: [0x14, 0x24],
    },
  };
  const liveStore = {
    vid: 'D056',
    snapshot: {
      gmtype: 'BAC',
      gmcode: 'GD056268221F0',
      gmstatus: 0,
      pval: 5,
      bval: 6,
      pcard: [0x15, 0x25],
      bcard: [0x16, 0x26],
    },
  };
  const linkStore = {
    vid: 'D057',
    snapshot: {
      gmtype: 'BAC',
      gmcode: 'GD057268221F0',
      gmstatus: 0,
      pval: 7,
      bval: 8,
      pcard: [0x17, 0x27],
      bcard: [0x18, 0x28],
    },
  };
  const gameBacStore = {
    vid: 'D055',
    gameSnapshot: {
      gmtype: 'BAC',
      gmcode: 'GD055268221F0',
      gmstatus: 0,
      pval: 9,
      bval: 0,
      pcard: [0x19, 0x29],
      bcard: [0x1a, 0x2a],
    },
  };
  const context = vm.createContext({
    location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
    window: { postMessage: (message: PostedMessage) => { messages.push(message); } },
    setInterval: vi.fn(),
    setTimeout: vi.fn(),
    Map,
    Array,
    Number,
    JSON,
    Date,
    VideoGameCore: {
      GameLinkStore: { instance: { visibleVids: [] } },
      LinkStoreFactory: {
        instance: {
          pokerStoreMap: { keys: ['D057'], get: () => linkStore },
          singleSocketGameStoreMap: { keys: [], get: () => undefined },
        },
      },
      RoadStoreFactory: {
        instance: {
          pokerStoreMap: { keys: ['D065'], get: () => ({ gameStore: roadStore }) },
        },
      },
      Live: {
        StoreFactory: { instance: { pokerStoreMap: { keys: ['D056'], get: () => liveStore } } },
      },
    },
    GameBac: {
      GameStore: { list: [gameBacStore] },
      PokerStore: { instance: null },
    },
  });
  vm.runInContext(hookSource, context);
  return messages;
}

function runAuthoritativeVisibleSelectionHook(): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const visibleTableIds = ['D055', 'D056'];
  const context = vm.createContext({
    location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
    window: { postMessage: (message: PostedMessage) => { messages.push(message); } },
    setInterval: vi.fn(),
    setTimeout: vi.fn(),
    Map,
    Array,
    Number,
    JSON,
    Date,
    VideoGameCore: {
      GameLinkStore: { instance: { visibleVids: visibleTableIds } },
      LinkStoreFactory: {
        instance: {
          pokerStoreMap: {
            keys: ['D055'],
            get: () => ({
              vid: 'D055',
              snapshot: {
                gmtype: 'BAC',
                gmcode: 'GD055268221A',
                gmstatus: 0,
                pval: 6,
                bval: 8,
                pcard: [0x16, 0x26],
                bcard: [0x12, 0x16],
              },
            }),
          },
          singleSocketGameStoreMap: { keys: [], get: () => undefined },
        },
      },
    },
    GameBac: {
      GameStore: { list: [{
        vid: 'P001',
        gameSnapshot: {
          gmtype: 'BAC',
          gmcode: 'GP001268221F0',
          gmstatus: 0,
          pval: 9,
          bval: 0,
          pcard: [0x0b, 0x19],
          bcard: [0x1d, 0x0a],
        },
      }] },
      PokerStore: { instance: null },
    },
  });
  vm.runInContext(hookSource, context);
  return messages;
}

function runSelectionChangeHook(): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const visibleTableIds = ['D055'];
  const scanCallbacks: Array<() => void> = [];
  const gameStores = new Map([
    ['D055', {
      vid: 'D055',
      gameSnapshot: {
        gmtype: 'BAC',
        gmcode: 'GD055268221A',
        gmstatus: 0,
        pval: 6,
        bval: 8,
        pcard: [0x16, 0x26],
        bcard: [0x12, 0x16],
      },
    }],
    ['D056', {
      vid: 'D056',
      gameSnapshot: {
        gmtype: 'BAC',
        gmcode: 'GD056268221A',
        gmstatus: 0,
        pval: 5,
        bval: 7,
        pcard: [0x15, 0x25],
        bcard: [0x13, 0x17],
      },
    }],
  ]);
  const context = vm.createContext({
    location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
    window: { postMessage: (message: PostedMessage) => { messages.push(message); } },
    setInterval: (callback: () => void) => {
      scanCallbacks.push(callback);
      return 0;
    },
    setTimeout: vi.fn(),
    Map,
    Array,
    Number,
    JSON,
    Date,
    VideoGameCore: {
      GameLinkStore: { instance: { visibleVids: visibleTableIds } },
      LinkStoreFactory: {
        instance: {
          pokerStoreMap: {
            keys: ['D055', 'D056'],
            get: (tableId: string) => {
              const gameStore = gameStores.get(tableId);
              return gameStore === undefined ? undefined : { vid: tableId, gameStore };
            },
          },
          singleSocketGameStoreMap: { keys: [], get: () => undefined },
        },
      },
    },
  });
  vm.runInContext(hookSource, context);
  const scan = scanCallbacks[0];
  if (scan === undefined) throw new Error('runtime scan callback was not registered');
  visibleTableIds.push('D056');
  scan();
  return messages;
}

function runLinkDiagnosticHook(): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const context = vm.createContext({
    location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
    window: { postMessage: (message: PostedMessage) => { messages.push(message); } },
    setInterval: vi.fn(),
    setTimeout: (callback: () => void) => { callback(); return 0; },
    Map,
    Array,
    Number,
    JSON,
    Date,
    VideoGameCore: {
      LinkStoreFactory: {
        instance: {
          pokerStoreMap: { keys: ['D055'], get: () => undefined },
          singleSocketGameStoreMap: { keys: ['D055'], get: () => undefined },
        },
      },
    },
  });
  vm.runInContext(hookSource, context);
  return messages;
}


describe('mstrom runtime-state hook', () => {
  it('keeps the content relay script syntactically valid', () => {
    expect(() => new vm.Script(contentRelaySource, { filename: 'content.js' })).not.toThrow();
  });

  it('exposes read-only runtime diagnostics to a replay probe', () => {
    const context = vm.createContext({
      location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/index.jsp?' },
      window: { postMessage: vi.fn() },
      setInterval: vi.fn(),
      setTimeout: vi.fn(),
      Map,
      Array,
      Number,
      JSON,
      Date,
      VideoGameCore: {
        RoadStoreFactory: {
          instance: {
            pokerStoreMap: {
              keys: ['D065'],
              get: () => undefined,
            },
          },
        },
      },
    });
    vm.runInContext(hookSource, context);

    const windowValue = Reflect.get(context, 'window');
    if (typeof windowValue !== 'object' || windowValue === null) {
      throw new Error('runtime hook did not receive a window object');
    }
    const diagnostic = Reflect.get(windowValue, '__baccaratRuntimeStateHookDiagnostics');
    if (typeof diagnostic !== 'function') {
      throw new Error('runtime hook did not expose diagnostics');
    }

    expect(diagnostic()).toEqual(expect.objectContaining({
      roadStoreFactory: true,
      roadStoreKeys: ['D065'],
      gameStoreList: null,
    }));
  });

  it('reads decoded card bytes from GameStore snapshots without visual capture', () => {
    const messages = runHook(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.source).toBe('baccarat-bridge-runtime-state');
    const raw = messages[0]?.data;
    expect(typeof raw).toBe('string');
    if (typeof raw !== 'string') return;
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toEqual(expect.objectContaining({
      tableId: 'D065',
      roundId: 'GD065268221A8',
      playerScore: 3,
      bankerScore: 4,
      playerCards: [0x38, 0x12, 0x03],
      bankerCards: [0x39, 0x05],
    }));
  });

  it('runs on the current 673ing game-host alias', () => {
    const messages = runHook(0, [0x38, 0x12, 0x03], 'live2.673ing.com');

    expect(messages.some(message => message.source === 'baccarat-bridge-runtime-state')).toBe(true);
  });

  it('allows the content relay on the current 673ing game-host alias', () => {
    const gamePageExpression = contentRelaySource.match(/const GAME_PAGE = (.+);/)?.[1];
    if (gamePageExpression === undefined) {
      throw new Error('content relay GAME_PAGE expression was not found');
    }

    const allowed = vm.runInNewContext(`Boolean(${gamePageExpression})`, {
      location: { hostname: 'live2.673ing.com' },
    });
    expect(allowed).toBe(true);
  });

  it('reads decoded cards from the LinkStoreFactory multi-table map', () => {
    const messages = runLinkStoreHook();
    expect(messages).toHaveLength(1);
    const raw = messages[0]?.data;
    expect(typeof raw).toBe('string');
    if (typeof raw !== 'string') return;
    expect(JSON.parse(raw)).toEqual(expect.objectContaining({
      tableId: 'D055',
      roundId: 'GD055268221A8',
      playerCards: [0x16, 0x26],
      bankerCards: [0x12, 0x16],
    }));
  });

  it('reports empty visible VIDs as an explicit exit from the multi-table view', () => {
    const messages = runEmptyVisibleLinkStoreHook();
    const snapshots = messages
      .filter(message => message.source === 'baccarat-bridge-runtime-state' && typeof message.data === 'string')
      .map(message => {
        if (typeof message.data !== 'string') throw new Error('runtime snapshot was not serialized');
        return JSON.parse(message.data);
      });
    expect(snapshots).toHaveLength(0);

    const selection = messages.find(message => message.source === 'baccarat-bridge-runtime-selection');
    if (selection === undefined || typeof selection.data !== 'string') {
      throw new Error('runtime selection was not emitted');
    }
    expect(JSON.parse(selection.data)).toEqual(expect.objectContaining({
      tableIds: [],
    }));
  });

  it('uses non-empty GameLinkStore visible VIDs as the authoritative selection', () => {
    const messages = runAuthoritativeVisibleSelectionHook();
    const snapshots = messages
      .filter(message => message.source === 'baccarat-bridge-runtime-state' && typeof message.data === 'string')
      .map(message => {
        if (typeof message.data !== 'string') throw new Error('runtime snapshot was not serialized');
        return JSON.parse(message.data);
      });
    expect(snapshots.map(snapshot => snapshot.tableId)).toEqual(['D055']);

    const selection = messages.find(message => message.source === 'baccarat-bridge-runtime-selection');
    if (selection === undefined || typeof selection.data !== 'string') {
      throw new Error('runtime selection was not emitted');
    }
    expect(JSON.parse(selection.data)).toEqual(expect.objectContaining({ tableIds: ['D055', 'D056'] }));
  });

  it('replays current snapshots after the runtime selection changes', () => {
    const messages = runSelectionChangeHook();
    const snapshots = messages
      .filter(message => message.source === 'baccarat-bridge-runtime-state' && typeof message.data === 'string')
      .map(message => {
        if (typeof message.data !== 'string') throw new Error('runtime snapshot was not serialized');
        return JSON.parse(message.data);
      });
    expect(snapshots.map(snapshot => snapshot.tableId)).toEqual(['D055', 'D055', 'D056']);
  });

  it('limits GameLink multi-table state to the visible VIDs', () => {
    const messages = runVisibleLinkStoreHook();
    const snapshotPayloads: string[] = [];
    for (const message of messages) {
      if (message.source === 'baccarat-bridge-runtime-state' && typeof message.data === 'string') {
        snapshotPayloads.push(message.data);
      }
    }
    const snapshots = snapshotPayloads.map(payload => JSON.parse(payload));
    expect(snapshots).toHaveLength(4);
    expect(snapshots.map(snapshot => snapshot.tableId)).toEqual(['D055', 'D056', 'D057', 'D065']);

    const selection = messages.find(message => message.source === 'baccarat-bridge-runtime-selection');
    if (selection === undefined || typeof selection.data !== 'string') {
      throw new Error('runtime selection was not emitted');
    }
    expect(JSON.parse(selection.data)).toEqual(expect.objectContaining({ tableIds: ['D055', 'D056', 'D057', 'D065'] }));
  });

  it('reports LinkStoreFactory map keys in the diagnostic payload', () => {
    const diagnostic = runLinkDiagnosticHook().find(message => message.source === 'baccarat-bridge-runtime-diagnostic');
    if (diagnostic === undefined || typeof diagnostic.data !== 'string') {
      throw new Error('runtime diagnostic was not emitted');
    }
    expect(JSON.parse(diagnostic.data)).toEqual(expect.objectContaining({
      linkStoreFactory: true,
      linkPokerStoreKeys: ['D055'],
      linkGameStoreKeys: ['D055'],
    }));
  });

  it('reads decoded cards from the Live StoreFactory multi-table map', () => {
    const messages = runLiveStoreHook();
    expect(messages).toHaveLength(1);
    const raw = messages[0]?.data;
    expect(typeof raw).toBe('string');
    if (typeof raw !== 'string') return;
    expect(JSON.parse(raw)).toEqual(expect.objectContaining({
      tableId: 'D065',
      roundId: 'GD065268221A8',
      playerCards: [0x38, 0x12, 0x03],
      bankerCards: [0x39, 0x05],
    }));
  });

  it('reads all decoded lobby tables from RoadStoreFactory', () => {
    const messages = runLobbyRoadStoreHook();
    expect(messages).toHaveLength(1);
    const raw = messages[0]?.data;
    expect(typeof raw).toBe('string');
    if (typeof raw !== 'string') return;
    expect(JSON.parse(raw)).toEqual(expect.objectContaining({
      tableId: 'D065',
      roundId: 'GD065268221A8',
      playerCards: [0x38, 0x12, 0x03],
      bankerCards: [0x39, 0x05],
    }));
  });

  it('forwards explicit shuffle status 11 while keeping every hidden card out of the payload', () => {
    const messages = runHook(11);
    expect(messages).toHaveLength(1);
    const raw = messages[0]?.data;
    expect(typeof raw).toBe('string');
    if (typeof raw !== 'string') return;
    expect(JSON.parse(raw)).toEqual(expect.objectContaining({
      tableId: 'D065',
      roundId: 'GD065268221A8',
      gmstatus: 11,
      playerCards: [],
      bankerCards: [],
    }));
    expect(runHook(-1)).toHaveLength(0);
  });

  it('rejects an entire snapshot instead of shifting invalid card slots', () => {
    expect(runHook(0, [0x38, 0x00, 0x03])).toHaveLength(0);
  });
});


function replayCurrentRuntimeState(): readonly PostedMessage[] {
  const messages: PostedMessage[] = [];
  const windowObject: {
    postMessage: (message: PostedMessage) => void;
    __baccaratRuntimeStateHookReplay?: () => void;
  } = {
    postMessage: (message: PostedMessage) => { messages.push(message); },
  };
  const context = vm.createContext({
    location: { hostname: 'gci.agad.mstrom-uno.com', href: 'https://gci.agad.mstrom-uno.com/pc/pcv1/' },
    window: windowObject,
    setInterval: vi.fn(),
    setTimeout: vi.fn(),
    Map,
    Array,
    Number,
    JSON,
    Date,
    GameBac: {
      GameStore: {
        list: [{
          vid: 'D065',
          gameSnapshot: {
            gmtype: 'BAC',
            gmcode: 'GD065268221A8',
            gmstatus: 0,
            pval: 3,
            bval: 4,
            pcard: [0x38, 0x12],
            bcard: [0x39, 0x05],
          },
        }],
      },
      PokerStore: { instance: null },
    },
  });
  vm.runInContext(hookSource, context);
  messages.length = 0;
  windowObject.__baccaratRuntimeStateHookReplay?.();
  return messages;
}

describe('runtime state replay after local bridge reconnect', () => {
  it('re-emits the current explicit selection and decoded snapshot on a replay request', () => {
    const messages = replayCurrentRuntimeState();
    const sources = messages.map(message => message.source);

    expect(sources).toContain('baccarat-bridge-runtime-selection');
    expect(sources).toContain('baccarat-bridge-runtime-state');
  });
});
