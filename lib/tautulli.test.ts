import { afterEach, describe, expect, it, vi } from 'vitest';
import { aggregatedWatchHistory, type HistoryRow } from './tautulli';

function fakeRes(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function historyPage(rows: HistoryRow[], recordsFiltered?: number): Response {
  return fakeRes({
    response: {
      result: 'success',
      data: { data: rows, ...(recordsFiltered != null ? { recordsFiltered } : {}) },
    },
  });
}

function row(over: Partial<HistoryRow>): HistoryRow {
  return {
    user_id: 1,
    rating_key: '10',
    grandparent_rating_key: '',
    media_type: 'movie',
    date: 100,
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('aggregatedWatchHistory (paged get_history)', () => {
  it('a short first page means exactly one fetch', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(historyPage([row({})]));
    const out = await aggregatedWatchHistory('http://taut:8181', 'k', 2);
    expect(out).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain('start=0');
    expect(url).toContain('length=2');
    expect(url).toContain('grouping=1');
  });

  it('pages until the short page, merging the same user+key across pages', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        historyPage([row({ date: 200, group_count: 2 }), row({ rating_key: '11' })])
      )
      .mockResolvedValueOnce(historyPage([row({ date: 300, group_count: 3 })]));
    const out = await aggregatedWatchHistory('http://taut:8181', 'k', 2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1][0])).toContain('start=2');
    const merged = out.find((r) => r.ratingKey === '10');
    expect(merged).toMatchObject({ plays: 5, lastWatched: 300 }); // 2+3, max(date)
    expect(out).toHaveLength(2);
  });

  it('stops when recordsFiltered is reached on a full page (no extra fetch)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(historyPage([row({}), row({ rating_key: '11' })], 2));
    await aggregatedWatchHistory('http://taut:8181', 'k', 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('caps at maxPages when the server keeps returning full pages', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(historyPage([row({}), row({ rating_key: '11' })]));
    await aggregatedWatchHistory('http://taut:8181', 'k', 2, 3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('an error envelope mid-loop rejects (no silent partial data)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(historyPage([row({}), row({ rating_key: '11' })]))
      .mockResolvedValueOnce(
        fakeRes({ response: { result: 'error', message: 'bad key' } })
      );
    await expect(
      aggregatedWatchHistory('http://taut:8181', 'k', 2)
    ).rejects.toThrow(/bad key/);
  });

  it('episodes roll up to the series (grandparent) key; blank keys dropped', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      historyPage([
        row({ media_type: 'episode', grandparent_rating_key: '77', rating_key: '901' }),
        row({ media_type: 'episode', grandparent_rating_key: '77', rating_key: '902', date: 500 }),
        row({ media_type: 'episode', grandparent_rating_key: '', rating_key: '903' }),
      ])
    );
    const out = await aggregatedWatchHistory('http://taut:8181', 'k');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ratingKey: '77', plays: 2, lastWatched: 500 });
  });
});
