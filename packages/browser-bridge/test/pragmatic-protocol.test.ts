import { describe, expect, it } from 'vitest';
import {
  PragmaticProtocolState,
  inspectPragmaticGameresult,
  inspectPragmaticWsFrame,
  pragmaticProtocolTableId,
} from '../src/pragmatic-protocol.js';

function message(kind: string, value: Record<string, unknown>): string {
  return JSON.stringify({ [kind]: value });
}

describe('PragmaticProtocolState', () => {
  it('projects round, timer, window and cards without relying on rendered DOM', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'bc281koreanch281';
    const round = '17264753224';
    protocol.ingest(message('game', { table, id: round, value: '06:47:41', seq: 1 }));
    const timed = protocol.ingest(message('timer', { table, id: round, value: '12', seq: 2 }));
    expect(timed?.tables[0]?.bettingOpen).not.toBe(true);
    expect(timed?.tables[0]?.countdown).toBe(12);
    const opened = protocol.ingest(message('betsopen', { table, game: round, seq: 3 }));
    expect(opened?.tables[0]).toEqual(expect.objectContaining({
      tableId: table,
      roundId: round,
      countdown: 12,
      bettingOpen: true,
      playerCards: [],
      bankerCards: [],
    }));
    expect(opened?.tables[0]).not.toHaveProperty('gameCount');

    protocol.ingest(message('card', {
      table, game: round, sc: '5D3', place: 'player', seq: 4,
    }));
    const dealt = protocol.ingest(message('card', {
      table, game: round, sc: '10H2', place: 'banker', seq: 5,
    }));
    expect(dealt?.tables[0]).toEqual(expect.objectContaining({
      playerCards: ['5D3'],
      bankerCards: ['10H2'],
    }));

    protocol.ingest(message('cardinc', {
      table, game: round, sc: '9C1', place: 'player', seq: 6,
    }));
    const withThird = protocol.ingest(message('cardinc', {
      table, game: round, sc: '4H0', place: 'banker', seq: 7,
    }));
    expect(withThird?.tables[0]).toEqual(expect.objectContaining({
      playerCards: ['5D3', '9C1'],
      bankerCards: ['10H2', '4H0'],
    }));

    const closed = protocol.ingest(message('betsclosed', { table, game: round, seq: 8 }));
    expect(closed?.tables[0]?.bettingOpen).toBe(false);
    const settled = protocol.ingest(message('gameresult', { table, game: round, seq: 9 }));
    expect(settled?.tables[0]).toEqual(expect.objectContaining({
      bettingOpen: false,
      gameSettled: true,
      playerCards: ['5D3', '9C1'],
      bankerCards: ['10H2', '4H0'],
    }));
  });

  it('isolates forty tables and rejects stale per-table sequence numbers', () => {
    const protocol = new PragmaticProtocolState();
    const snapshots = Array.from({ length: 40 }, (_, index) => {
      const table = `pragmatictable${String(index).padStart(2, '0')}`;
      protocol.ingest(message('game', { table, id: `round-${index}`, seq: index * 10 + 1 }));
      return protocol.ingest(message('betsopen', { table, game: `round-${index}`, seq: index * 10 + 2 }));
    });
    expect(new Set(snapshots.map(snapshot => snapshot?.tables[0]?.tableId)).size).toBe(40);

    const stale = protocol.ingest(message('betsclosed', {
      table: 'pragmatictable00', game: 'round-0', seq: 1,
    }));
    expect(stale).toBeUndefined();
    const otherTable = protocol.ingest(message('card', {
      table: 'pragmatictable01', game: 'round-1', sc: 'AS1', place: 'player', seq: 13,
    }));
    expect(otherTable?.tables[0]?.playerCards).toEqual(['AS1']);
  });

  it('still records a delayed cardinc after a later timer sequence number', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'h22z8qhp17sa0vkh';
    const round = '16387761010';
    protocol.ingest(message('betsopen', { table, game: round, seq: 10 }));
    protocol.ingest(message('card', { table, game: round, sc: 'QS3', place: 'player', seq: 11 }));
    protocol.ingest(message('card', { table, game: round, sc: '9H2', place: 'player', seq: 12 }));
    protocol.ingest(message('card', { table, game: round, sc: '3S1', place: 'banker', seq: 13 }));
    protocol.ingest(message('timer', { table, id: round, value: '0', seq: 20 }));
    const delayed = protocol.ingest(message('cardinc', {
      table, game: round, sc: '7D0', place: 'banker', seq: 14,
    }));
    expect(delayed?.tables[0]).toEqual(expect.objectContaining({
      playerCards: ['QS3', '9H2'],
      bankerCards: ['3S1', '7D0'],
      source: 'protocol',
    }));
  });

  it('keeps a delayed card on the previous round after the next window opens', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'h22z8qhp17sa0vkh';
    protocol.ingest(message('betsopen', { table, game: '16387761010', seq: 1 }));
    protocol.ingest(message('card', { table, game: '16387761010', sc: 'QS3', place: 'player', seq: 2 }));
    protocol.ingest(message('card', { table, game: '16387761010', sc: '9H2', place: 'player', seq: 3 }));
    protocol.ingest(message('betsopen', { table, game: '16387766710', seq: 10 }));
    const delayed = protocol.ingest(message('card', {
      table, game: '16387761010', sc: '3S1', place: 'banker', seq: 4,
    }));
    expect(delayed?.tables[0]).toEqual(expect.objectContaining({
      roundId: '16387761010',
      playerCards: ['QS3', '9H2'],
      bankerCards: ['3S1'],
    }));

    const current = protocol.ingest(message('card', {
      table, game: '16387766710', sc: 'AS1', place: 'player', seq: 11,
    }));
    expect(current?.tables[0]).toEqual(expect.objectContaining({
      roundId: '16387766710',
      playerCards: ['AS1'],
      bankerCards: [],
    }));
  });

  it('records two cards that share a sequence number and a late cardinc', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'oq808ojps709qqaf';
    const round = '16389075410';
    protocol.ingest(message('betsopen', { table, game: round, seq: 1 }));
    protocol.ingest(message('card', { table, game: round, sc: '7C0', place: 'player', seq: 10 }));
    protocol.ingest(message('card', { table, game: round, sc: '4D0', place: 'banker', seq: 10 }));
    const late = protocol.ingest(message('cardinc', {
      table, game: round, sc: '6C1', place: 'player', seq: 2,
    }));
    expect(late?.tables[0]).toEqual(expect.objectContaining({
      playerCards: ['7C0', '6C1'],
      bankerCards: ['4D0'],
    }));
  });

  it('applies a card packed with a later timer on the same frame', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'h22z8qhp17sa0vkh';
    const round = '16387761010';
    protocol.ingest(message('betsopen', { table, game: round, seq: 1 }));
    protocol.ingest(message('card', { table, game: round, sc: 'QS3', place: 'player', seq: 2 }));
    const packed = protocol.ingest(JSON.stringify({
      timer: { table, id: round, value: '0', seq: 20 },
      card: { table, game: round, sc: '3S1', place: 'banker', seq: 3 },
    }));
    expect(packed?.tables[0]).toEqual(expect.objectContaining({
      bettingOpen: false,
      playerCards: ['QS3'],
      bankerCards: ['3S1'],
    }));
  });

  it('ignores a replayed card with a new sequence number', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'h22z8qhp17sa0vkh';
    const round = '16387761010';
    protocol.ingest(message('card', { table, game: round, sc: 'QS3', place: 'player', seq: 2 }));
    protocol.ingest(message('card', { table, game: round, sc: '9H2', place: 'player', seq: 3 }));
    const replayed = protocol.ingest(message('card', {
      table, game: round, sc: 'QS3', place: 'player', seq: 30,
    }));
    expect(replayed).toBeUndefined();
    expect(protocol.snapshot(table)?.tables[0]?.playerCards).toEqual(['QS3', '9H2']);
  });

  it('still accepts two same-rank cards that have different sc instance digits', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'h22z8qhp17sa0vkh';
    const round = '16387761010';
    protocol.ingest(message('card', { table, game: round, sc: '8C1', place: 'player', seq: 2 }));
    const second = protocol.ingest(message('card', { table, game: round, sc: '8C4', place: 'player', seq: 3 }));
    expect(second?.tables[0]?.playerCards).toEqual(['8C1', '8C4']);
  });

  it('does not treat a cardinc without a face as a card', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'h22z8qhp17sa0vkh';
    const round = '16387761010';
    protocol.ingest(message('card', { table, game: round, sc: 'QS3', place: 'player', seq: 2 }));
    expect(protocol.ingest(message('cardinc', {
      table, game: round, place: 'player', value: '1', seq: 3,
    }))).toBeUndefined();
    expect(protocol.snapshot(table)?.tables[0]?.playerCards).toEqual(['QS3']);
  });

  it('fills missing cards from gameresult', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'h22z8qhp17sa0vkh';
    const round = '16387761010';
    protocol.ingest(message('card', { table, game: round, sc: 'QS3', place: 'player', seq: 1 }));
    const settled = protocol.ingest(message('gameresult', {
      table,
      game: round,
      seq: 9,
      player: ['QS', '9H'],
      banker: ['3S', '7D'],
    }));
    expect(settled?.tables[0]).toEqual(expect.objectContaining({
      gameSettled: true,
      playerCards: ['QS', '9H'],
      bankerCards: ['3S', '7D'],
    }));
  });

  it('does not treat a timer tick as betsopen', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'speedbca14gesbc1';
    const round = '16391965010';
    protocol.ingest(message('game', { table, game: round, seq: 1 }));
    protocol.ingest(message('timer', { table, game: round, value: '12', seq: 2 }));
    expect(protocol.snapshot(table)?.tables[0]?.bettingOpen).not.toBe(true);
    const opened = protocol.ingest(message('betsopen', { table, game: round, seq: 3 }));
    expect(opened?.tables[0]?.bettingOpen).toBe(true);
    const stillOpen = protocol.ingest(message('timer', { table, game: round, value: '9', seq: 4 }));
    expect(stillOpen).toBeUndefined();
    expect(protocol.snapshot(table)?.tables[0]).toEqual(expect.objectContaining({
      bettingOpen: true,
      countdown: 9,
    }));
  });

  it('does not emit snapshots for intermediate timer ticks', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'speedbca14gesbc1';
    const round = '16391965010';
    protocol.ingest(message('betsopen', { table, game: round, seq: 1 }));
    expect(protocol.ingest(message('timer', { table, game: round, value: '12', seq: 2 }))?.tables[0])
      .toEqual(expect.objectContaining({ countdown: 12, bettingOpen: true }));
    expect(protocol.ingest(message('timer', { table, game: round, value: '11', seq: 3 }))).toBeUndefined();
    expect(protocol.ingest(message('timer', { table, game: round, value: '1', seq: 4 }))).toBeUndefined();
    expect(protocol.ingest(message('timer', { table, game: round, value: '0', seq: 5 }))?.tables[0])
      .toEqual(expect.objectContaining({ countdown: 0, bettingOpen: false }));
  });

  it('opens a dedicated-socket betsopen after a higher shared-socket seq on the same round', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'bc281koreanch281';
    const round = '16392002810';
    protocol.ingest(message('game', { table, game: round, seq: 12500, value: '15:19:28' }));
    const opened = protocol.ingest(message('betsopen', { table, game: round, seq: 105 }));
    expect(opened?.tables[0]).toEqual(expect.objectContaining({
      roundId: round,
      bettingOpen: true,
    }));
    const timed = protocol.ingest(message('timer', { table, game: round, value: '12', seq: 106 }));
    expect(timed?.tables[0]).toEqual(expect.objectContaining({
      bettingOpen: true,
      countdown: 12,
    }));
  });

  it('opens the next round when its betting seq is lower than the previous shared-socket seq', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'speedbca14gesbc1';
    protocol.ingest(message('game', { table, game: '16391960910', seq: 12589, value: '15:16:17' }));
    protocol.ingest(message('betsopen', { table, game: '16391960910', seq: 12591 }));
    protocol.ingest(message('betsclosed', { table, game: '16391960910', seq: 12600 }));
    const next = protocol.ingest(message('betsopen', { table, game: '16391965010', seq: 40 }));
    expect(next?.tables[0]).toEqual(expect.objectContaining({
      roundId: '16391965010',
      bettingOpen: true,
    }));
  });

  it('does not reopen from a lower-seq timer after the round has closed', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'speedbca14gesbc1';
    const round = '16391960910';
    protocol.ingest(message('betsopen', { table, game: round, seq: 2 }));
    protocol.ingest(message('betsclosed', { table, game: round, seq: 3 }));
    const stale = protocol.ingest(message('timer', { table, game: round, value: '12', seq: 1 }));
    expect(stale).toBeUndefined();
    expect(protocol.snapshot(table)?.tables[0]?.bettingOpen).toBe(false);
  });

  it('inspects live gameresult keys without exposing secrets', () => {
    expect(inspectPragmaticGameresult(message('gameresult', {
      table: 'h22z8qhp17sa0vkh',
      game: '16387761010',
      seq: 9,
      player: ['QS', '9H'],
      banker: ['3S', '7D'],
      token: 'must-not-leak',
    }))).toEqual({
      format: 'json',
      rootKeys: ['gameresult'],
      resultKey: 'gameresult',
      record: expect.objectContaining({
        keys: expect.arrayContaining(['table', 'game', 'player', 'banker', 'token']),
        table: 'h22z8qhp17sa0vkh',
        player: ['QS', '9H'],
        banker: ['3S', '7D'],
        token: '<redacted>',
      }),
    });
  });

  it('starts a physical shoe once for startshuffling, currentShoe and endshuffling', () => {
    const protocol = new PragmaticProtocolState();
    const table = 'h22z8qhp17sa0vkh';
    const started = protocol.ingest(message('startshuffling', { table, seq: 10 }));
    const token = started?.tables[0]?.shoeReset;
    expect(token).toEqual(expect.stringMatching(/^protocol:h22z8qhp17sa0vkh:10$/));

    const during = protocol.ingest(JSON.stringify({
      currentShoe: { cc: '0', code: 'blue', changeShoe: 'true', seq: 18 },
    }));
    expect(during?.tables[0]).toEqual(expect.objectContaining({
      tableId: table,
      shoeReset: token,
    }));

    const ended = protocol.ingest(message('endshuffling', { table, game: '', seq: 40 }));
    expect(ended?.tables[0]?.shoeReset).toBe(token);

    const after = protocol.ingest(JSON.stringify({
      currentShoe: { cc: '0', code: 'blue', changeShoe: 'true', seq: 55 },
    }));
    expect(after?.tables[0]?.shoeReset).toBe(token);
  });

  it('does not guess a currentShoe table while two tables are shuffling', () => {
    const protocol = new PragmaticProtocolState();
    protocol.ingest(message('startshuffling', { table: 'h22z8qhp17sa0vkh', seq: 1 }));
    protocol.ingest(message('startshuffling', { table: 'bc281koreanch281', seq: 2 }));
    expect(protocol.ingest(JSON.stringify({
      currentShoe: { changeShoe: 'true', seq: 3 },
    }))).toBeUndefined();
  });

  it('opens a physical shoe from endshuffling when startshuffling was missed', () => {
    const protocol = new PragmaticProtocolState();
    const ended = protocol.ingest(message('endshuffling', { table: 'tobc51koreanto51', seq: 12610 }));
    expect(ended?.tables[0]).toEqual(expect.objectContaining({
      tableId: 'tobc51koreanto51',
      shoeReset: 'protocol:tobc51koreanto51:12610',
    }));
  });

  it('can read a table id from a duplicate protocol frame', () => {
    expect(pragmaticProtocolTableId(message('timer', {
      table: 'h22z8qhp17sa0vkh', id: '16387766710', value: '8', seq: 1,
    }))).toBe('h22z8qhp17sa0vkh');
  });
});

describe('inspectPragmaticWsFrame', () => {
  it('classifies known json keys and keeps unknown keys with card signals', () => {
    expect(inspectPragmaticWsFrame(JSON.stringify({
      timer: { table: 'h22z8qhp17sa0vkh', id: '16387766710', value: '8', seq: 1 },
      statistic: { table: 'h22z8qhp17sa0vkh', luckyCards: 'QH,5S', token: 'must-not-leak' },
    }))).toEqual({
      format: 'json',
      rootKeys: ['timer', 'statistic'],
      knownKeys: ['timer'],
      unknownKeys: ['statistic'],
      known: {
        timer: expect.objectContaining({ table: 'h22z8qhp17sa0vkh', seq: 1, value: '8' }),
      },
      unknownRecords: {
        statistic: expect.objectContaining({
          keys: expect.arrayContaining(['table', 'luckyCards', 'token']),
          luckyCards: 'QH,5S',
          token: '<redacted>',
        }),
      },
      cardSignals: expect.arrayContaining([
        expect.objectContaining({ key: 'luckyCards', value: 'QH,5S' }),
      ]),
    });
  });

  it('lists xml tags that the whitelist parser would drop', () => {
    expect(inspectPragmaticWsFrame(
      '<command channel="table-h22"><history table="h22z8qhp17sa0vkh" sc="AS1"/><timer table="h22z8qhp17sa0vkh" value="8"/></command>',
    )).toEqual(expect.objectContaining({
      format: 'xml',
      tags: expect.arrayContaining(['command', 'history', 'timer']),
      knownTags: ['timer'],
      unknownTags: expect.arrayContaining(['command', 'history']),
      unknownRecords: expect.arrayContaining([
        expect.objectContaining({ tag: 'history', table: 'h22z8qhp17sa0vkh', sc: 'AS1' }),
      ]),
      cardSignals: expect.arrayContaining([
        expect.objectContaining({ key: 'sc', value: 'AS1' }),
      ]),
    }));
  });
});
