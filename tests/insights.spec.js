const { test, expect } = require('@playwright/test');

function ranked(overrides = {}) {
  return {
    id: 'comments-by-source',
    title: 'Discussion by RSS source',
    description: 'The 15 sources with the most comments.',
    kind: 'table',
    bar: 2,
    sql: 'SELECT n.source_name AS source FROM selo.news n LIMIT 15',
    columns: ['source', 'news', 'comments'],
    rows: [
      ['The Verge', '52', '100'],
      ['TechCrunch', '46', '50'],
      ['Zetaris Blog', '10', null]
    ],
    error: null,
    ms: 321,
    ...overrides
  };
}

function makeInsights(overrides = {}) {
  return {
    available: true,
    database: 'selo',
    generatedAt: new Date().toISOString(),
    items: [
      {
        id: 'totals',
        title: 'In Zetaris right now',
        description: 'Rows in the app tables.',
        kind: 'stats',
        bar: null,
        sql: 'SELECT (SELECT count(*) FROM selo.rss_sources) AS rss_sources',
        columns: ['rss_sources', 'news'],
        rows: [['4', '138']],
        error: null,
        ms: 120
      },
      ranked(),
      ranked({
        id: 'errors',
        title: 'Why requests failed',
        description: 'Failed requests by reason.',
        columns: ['reason', 'requests'],
        bar: 1,
        rows: [],
        sql: 'SELECT reason FROM selo.meterless_log LIMIT 10'
      })
    ],
    ...overrides
  };
}

async function mockInsights(page, body, status = 200) {
  const seen = { calls: 0 };
  await page.route('**/api/insights', route => {
    seen.calls += 1;
    const payload = typeof body === 'function' ? body(seen.calls) : body;
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  return seen;
}

test.describe('Insights page', () => {
  test('shows what Zetaris answered: totals, ranked bars and the SQL behind each card', async ({ page }) => {
    await mockInsights(page, makeInsights());
    await page.goto('/insights');

    await expect(page.getByRole('heading', { name: /Insights/ })).toBeVisible();
    await expect(page.getByText('(database selo', { exact: false })).toBeVisible();

    const totals = page.getByTestId('insight-totals');
    await expect(totals.getByText('138')).toBeVisible();
    await expect(totals.getByText('rss sources')).toBeVisible();

    const bySource = page.getByTestId('insight-comments-by-source');
    await expect(bySource.getByRole('row')).toHaveCount(4);
    await expect(bySource.getByRole('cell', { name: 'The Verge' })).toBeVisible();
    // A missing value is a dash, not "null".
    await expect(bySource.getByRole('row', { name: /Zetaris Blog/ })).toContainText('–');

    // The widest value fills the cell, the others are in proportion.
    const bars = bySource.locator('.insights-bar');
    await expect(bars).toHaveCount(3);
    await expect(bars.nth(0)).toHaveAttribute('style', 'width: 100%;');
    await expect(bars.nth(1)).toHaveAttribute('style', 'width: 50%;');
    await expect(bars.nth(2)).toHaveAttribute('style', 'width: 0%;');

    await bySource.getByText('SQL run by Zetaris').click();
    await expect(bySource.getByText('SELECT n.source_name AS source FROM selo.news n LIMIT 15')).toBeVisible();
    await expect(bySource.getByText('321 ms')).toBeVisible();
  });

  test('a query with no rows says so', async ({ page }) => {
    await mockInsights(page, makeInsights());
    await page.goto('/insights');

    await expect(page.getByTestId('insight-errors').getByText('Nothing to show yet.')).toBeVisible();
  });

  test('a failing query shows its error and does not hide the other cards', async ({ page }) => {
    const body = makeInsights();
    body.items[1] = ranked({ error: 'Table or view not found: selo.news', rows: [], columns: [] });
    await mockInsights(page, body);
    await page.goto('/insights');

    await expect(page.getByTestId('insight-comments-by-source')).toContainText('Table or view not found: selo.news');
    await expect(page.getByTestId('insight-totals').getByText('138')).toBeVisible();
    await expect(page.getByTestId('insights-failed')).toHaveCount(0);
  });

  test('when every query fails it says that Zetaris did not answer', async ({ page }) => {
    const body = makeInsights();
    body.items = body.items.map(item => ({ ...item, error: 'Zetaris is not reachable', rows: [], columns: [] }));
    await mockInsights(page, body);
    await page.goto('/insights');

    await expect(page.getByTestId('insights-failed')).toContainText('Zetaris did not answer: Zetaris is not reachable');
    await expect(page.getByTestId('insights-failed').getByRole('link', { name: 'Zetaris status' })).toHaveAttribute(
      'href',
      '/providers'
    );
  });

  test('says so when the app data is not stored in Zetaris', async ({ page }) => {
    await mockInsights(page, {
      available: false,
      reason: 'Insights are worked out by Zetaris, and the app data is not stored there.',
      items: []
    });
    await page.goto('/insights');

    await expect(page.getByTestId('insights-unavailable')).toContainText('the app data is not stored there');
    await expect(page.getByTestId('insights-failed')).toHaveCount(0);
  });

  test('Refresh asks Zetaris again', async ({ page }) => {
    // (The dev build runs effects twice, so the test does not count requests.)
    let total = '10';
    await mockInsights(page, () => {
      const body = makeInsights();
      body.items[0].rows = [[total, '138']];
      return body;
    });
    await page.goto('/insights');
    await expect(page.getByTestId('insight-totals').getByText('10', { exact: true })).toBeVisible();

    total = '20';
    await page.getByRole('button', { name: /Refresh/ }).click();

    await expect(page.getByTestId('insight-totals').getByText('20', { exact: true })).toBeVisible();
    await expect(page.getByTestId('insight-totals').getByText('10', { exact: true })).toHaveCount(0);
  });

  test('warns when Zetaris has not received the latest changes, and not otherwise', async ({ page }) => {
    await mockInsights(
      page,
      makeInsights({ stale: true, notice: 'The latest changes are still being saved to Zetaris.' })
    );
    await page.goto('/insights');

    await expect(page.getByTestId('insights-stale')).toHaveText('The latest changes are still being saved to Zetaris.');
    await expect(page.getByTestId('insight-totals').getByText('138')).toBeVisible();
  });

  test('a current answer shows no warning', async ({ page }) => {
    await mockInsights(page, makeInsights({ stale: false, notice: null }));
    await page.goto('/insights');

    await expect(page.getByTestId('insight-totals').getByText('138')).toBeVisible();
    await expect(page.getByTestId('insights-stale')).toHaveCount(0);
  });

  test('a slow older answer never replaces the newest one', async ({ page }) => {
    // The first request is slow and old; any later one is quick and new. The dev
    // build asks twice on mount, so both are in flight together.
    let calls = 0;
    await page.route('**/api/insights', async route => {
      calls += 1;
      const first = calls === 1;
      if (first) await new Promise(resolve => setTimeout(resolve, 1500));
      const body = makeInsights();
      body.items[0].rows = [[first ? 'OLD' : 'NEW', '138']];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/insights');

    await expect(page.getByTestId('insight-totals').getByText('NEW', { exact: true })).toBeVisible();
    // Long enough for the slow answer to arrive; it must be ignored.
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('insight-totals').getByText('NEW', { exact: true })).toBeVisible();
    await expect(page.getByTestId('insight-totals').getByText('OLD', { exact: true })).toHaveCount(0);
  });

  test('a server error is shown and the navigation has an Insights link', async ({ page }) => {
    await mockInsights(page, { error: 'boom' }, 500);
    await page.goto('/insights');

    await expect(page.getByText('boom')).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Insights' })).toHaveAttribute(
      'href',
      '/insights'
    );
  });
});
