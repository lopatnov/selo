'use strict';

/**
 * Adding to the live state the records that Zetaris holds and this server never
 * loaded (see `persistence.js`: Zetaris was unreachable at start-up, and by the
 * time it answered someone, or an earlier run, had saved more there).
 *
 * Records are matched by id; a feed is also matched by URL and an article by
 * link, because the same feed or article fetched on both sides has two ids.
 * Nothing already in memory is touched, so what this server holds wins. The
 * ordering of the lists is kept: news newest first, comments oldest first.
 */

const text = value => String(value ?? '');
const byNewestFetch = (a, b) => text(b.fetchedAt).localeCompare(text(a.fetchedAt));
const byOldestTimestamp = (a, b) => text(a.timestamp).localeCompare(text(b.timestamp));

function adoptRecords(storage, found, remoteState = {}) {
  const urls = new Set(storage.rssSources.map(source => text(source.url).toLowerCase()));
  for (const source of found.rssSources ?? []) {
    const url = text(source.url).toLowerCase();
    if (urls.has(url)) continue;
    urls.add(url);
    storage.rssSources.push(source);
  }

  storage.users.push(...(found.users ?? []));

  const links = new Set(storage.news.map(item => item.link));
  const newNews = (found.news ?? []).filter(item => !item.link || !links.has(item.link));
  storage.news = [...storage.news, ...newNews].sort(byNewestFetch);

  storage.comments = [...storage.comments, ...(found.comments ?? [])].sort(byOldestTimestamp);

  if (!storage.participantId && remoteState.participantId) {
    storage.participantId = remoteState.participantId;
  }
}

module.exports = { adoptRecords };
