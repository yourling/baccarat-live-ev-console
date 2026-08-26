// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultProfile } from '@baccarat/contracts';
import { emptyProjection } from '@baccarat/ledger-state';
import { describe, expect, it } from 'vitest';
import type { TableActorSnapshot } from '../src/api-types.js';
import { OperationalWagerControls } from '../src/ui/operational-wager-controls.js';

describe('operational wager confirmation', () => {
  it('opens a visible application dialog without invoking native confirm', async () => {
    // Given: a shadow-mode table whose manual wager controls are ready.
    const tableId = 'D055';
    const actor = {
      tableId,
      profile: defaultProfile(tableId),
      projection: emptyProjection(tableId),
      executionMode: 'shadow',
      defaultBetAmount: 20,
      pendingEvents: 0,
    } satisfies TableActorSnapshot;
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
      // When: the operator clicks the banker test-wager button.
      await act(async () => {
        root.render(<OperationalWagerControls actor={actor} onSnapshot={() => undefined} />);
      });
      const bankerButton = Array.from(container.querySelectorAll('button'))
        .find(button => button.textContent === '庄');
      if (bankerButton === undefined) throw new Error('banker wager button missing');
      bankerButton.focus();
      await act(async () => {
        bankerButton.click();
      });

      // Then: confirmation is rendered in the application DOM and native confirm is unused.
      expect(nativeConfirmCalls).toBe(0);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(container.hasAttribute('inert')).toBe(true);
      expect(document.body.style.overflow).toBe('hidden');

      // When: keyboard events originate inside the Portal while the card stops bubbling key events.
      const dialogButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'));
      const cancelButton = dialogButtons.find(button => button.textContent === '取消');
      const confirmButton = dialogButtons.find(button => button.textContent === '确认记录');
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

      // Then: focus remains trapped and Escape closes the application dialog.
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
});
