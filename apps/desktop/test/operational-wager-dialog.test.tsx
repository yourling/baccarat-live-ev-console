// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultProfile } from '@baccarat/contracts';
import { emptyProjection } from '@baccarat/ledger-state';
import { describe, expect, it } from 'vitest';
import type { TableActorSnapshot } from '../src/api-types.js';
import {
  OperationalWagerControls,
  bettingPhaseLabel,
  currentWagerHandId,
  operationalWagerGateReason,
} from '../src/ui/operational-wager-controls.js';

function actorSnapshot(
  status: 'TRACKING' | 'BETTING_WINDOW',
  handId: string | null,
  closesAt?: string,
): TableActorSnapshot {
  return {
    tableId: 'D055',
    profile: defaultProfile('D055'),
    projection: {
      ...emptyProjection('D055'),
      status,
      connectionStatus: 'CONNECTED',
      shoeBaseline: 'physical-shoe',
      currentHandId: handId,
      bettingWindowClosesAt: closesAt ?? null,
    },
    executionMode: 'live',
    defaultBetAmount: 20,
    pendingEvents: 0,
  };
}

describe('operational wager confirmation', () => {
  it('uses the live projection hand instead of a stale metadata round', () => {
    const actor = actorSnapshot(
      'BETTING_WINDOW',
      '16385402410',
      new Date(Date.now() + 8_000).toISOString(),
    );
    expect(currentWagerHandId(actor, {
      tableId: 'D055',
      roomId: 'dafabet-pragmatic',
      roundId: '16385397310',
    })).toBe('16385402410');
    expect(operationalWagerGateReason(actor)).toBeNull();
  });

  it('disables manual wager buttons when the betting window is about to close', () => {
    const actor = actorSnapshot(
      'BETTING_WINDOW',
      '16385402410',
      new Date(Date.now() + 1_200).toISOString(),
    );
    expect(operationalWagerGateReason(actor)).toBe('下注窗口即将关闭');
  });

  it('treats an elapsed betting window as closed without waiting for the next snapshot', () => {
    const actor = actorSnapshot(
      'BETTING_WINDOW',
      '16385402410',
      new Date(Date.now() - 200).toISOString(),
    );
    expect(operationalWagerGateReason(actor)).toBe('当前不在下注窗口');
  });

  it('labels an open betting window even after the local countdown has elapsed', () => {
    const actor = actorSnapshot(
      'BETTING_WINDOW',
      '16393876410',
      new Date(Date.now() - 500).toISOString(),
    );
    expect(bettingPhaseLabel(actor).open).toBe(true);
    expect(bettingPhaseLabel(actor).text).toBe('可下注');
  });

  it('labels dealing and waiting tables instead of a blanket closed window', () => {
    const dealing = actorSnapshot('TRACKING', '16393876410');
    expect(bettingPhaseLabel({
      ...dealing,
      projection: { ...dealing.projection, currentHandHasCards: true },
    })).toEqual({ text: '发牌中', open: false });
    expect(bettingPhaseLabel(actorSnapshot('TRACKING', null)).text).toBe('停注');
  });

  it('disables manual wager buttons outside the betting window', async () => {
    const actor = actorSnapshot('TRACKING', null);
    const originalActEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    container.id = 'root';
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <OperationalWagerControls
            actor={actor}
            metadata={{
              tableId: 'D055',
              roomId: 'pragmatic',
              displayName: 'Speed Baccarat',
              roundId: 'visible-page-hand',
            }}
            onSnapshot={() => undefined}
          />,
        );
      });

      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.map(button => button.textContent)).toEqual(['庄', '闲', '庄对', '闲对']);
      expect(buttons.every(button => button.disabled)).toBe(true);
      expect(container.querySelector('[role="status"]')?.textContent).toBe('当前不在下注窗口');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      if (originalActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      } else {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
      }
    }
  });

  it('renders a compact control without repeating the default chip amount', async () => {
    const actor = actorSnapshot('TRACKING', null);
    const originalActEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <OperationalWagerControls
            actor={actor}
            compact
            onSnapshot={() => undefined}
          />,
        );
      });

      expect(container.querySelector('.operational-wager-controls--compact')).not.toBeNull();
      expect(Array.from(container.querySelectorAll('button')).map(button => button.textContent)).toEqual(['庄', '闲', '庄对', '闲对']);
      expect(container.querySelector('[role="status"]')?.textContent).toBe('等待开盘');
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      if (originalActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      } else {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
      }
    }
  });

  it('opens a visible application dialog without invoking native confirm', async () => {
    const actor = actorSnapshot(
      'BETTING_WINDOW',
      'GD055-test',
      new Date(Date.now() + 12_000).toISOString(),
    );
    const originalConfirm = window.confirm;
    const originalDesktop = window.desktop;
    const originalActEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    let nativeConfirmCalls = 0;
    Reflect.set(window, 'confirm', () => {
      nativeConfirmCalls += 1;
      return false;
    });
    Reflect.set(window, 'desktop', {
      executeOperationalWager: async () => {
        throw new Error('the confirmation test must not execute a wager');
      },
    });
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    container.id = 'root';
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<OperationalWagerControls actor={actor} onSnapshot={() => undefined} />);
      });
      const bankerButton = Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === '庄');
      if (bankerButton === undefined) throw new Error('banker wager button missing');
      expect(bankerButton.disabled).toBe(false);
      bankerButton.focus();
      await act(async () => {
        bankerButton.click();
      });

      expect(nativeConfirmCalls).toBe(0);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.hasAttribute('inert')).toBe(true);
      expect(document.body.style.overflow).toBe('hidden');

      const dialogButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'));
      const cancelButton = dialogButtons.find(button => button.textContent === '取消');
      const confirmButton = dialogButtons.find(button => button.textContent === '确认真实下注');
      if (cancelButton === undefined || confirmButton === undefined) {
        throw new Error('confirmation actions missing');
      }
      confirmButton.focus();
      await act(async () => {
        confirmButton.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }));
      });

      expect(document.activeElement).toBe(cancelButton);
      await act(async () => {
        cancelButton.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }));
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(container.hasAttribute('inert')).toBe(false);
      expect(document.body.style.overflow).toBe('');
      expect(document.activeElement).toBe(bankerButton);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      Reflect.set(window, 'confirm', originalConfirm);
      if (originalDesktop === undefined) {
        Reflect.deleteProperty(window, 'desktop');
      } else {
        Reflect.set(window, 'desktop', originalDesktop);
      }
      if (originalActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      } else {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
      }
    }
  });

  it('locks the stake to the page default chip and does not offer an amount field', async () => {
    const actor = actorSnapshot(
      'BETTING_WINDOW',
      'GD055-test',
      new Date(Date.now() + 12_000).toISOString(),
    );
    const originalDesktop = window.desktop;
    const originalActEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    const executed: Array<{ amount: number }> = [];
    Reflect.set(window, 'desktop', {
      executeOperationalWager: async (command: { amount: number }) => {
        executed.push(command);
        return {
          status: 'ACCEPTED',
          tableId: actor.tableId,
          reason: 'wallet-total-bet-increased',
          snapshot: { tables: [] },
        };
      },
    });
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<OperationalWagerControls actor={actor} onSnapshot={() => undefined} />);
      });
      expect(container.querySelector('input')).toBeNull();
      expect(container.textContent).toContain('默认筹码');
      expect(container.textContent).toContain('20.00');

      const bankerButton = Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === '庄');
      if (bankerButton === undefined) throw new Error('banker wager button missing');
      await act(async () => {
        bankerButton.click();
      });
      const confirmButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
        .find(button => button.textContent === '确认真实下注');
      if (confirmButton === undefined) throw new Error('confirmation action missing');
      await act(async () => {
        confirmButton.click();
      });

      expect(executed).toEqual([expect.objectContaining({ amount: 20 })]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      if (originalDesktop === undefined) {
        Reflect.deleteProperty(window, 'desktop');
      } else {
        Reflect.set(window, 'desktop', originalDesktop);
      }
      if (originalActEnvironment === undefined) {
        Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
      } else {
        Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
      }
    }
  });
});
