'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Parser = require('rss-parser');

const { decodeHtmlEntities, repairTitles } = require('./html-entities');

test('numeric entities, decimal and hex, become the character', () => {
  assert.equal(decodeHtmlEntities('It&#8217;s here'), 'It’s here');
  assert.equal(decodeHtmlEntities('It&#x2019;s here'), 'It’s here');
  assert.equal(decodeHtmlEntities('&#8220;Quoted&#8221;'), '“Quoted”');
  assert.equal(decodeHtmlEntities('Cheese &#129472;'), 'Cheese 🧀');
});

test('the common named entities are decoded', () => {
  assert.equal(decodeHtmlEntities('AT&amp;T &mdash; a &quot;deal&quot;&hellip;'), 'AT&T — a "deal"…');
  assert.equal(decodeHtmlEntities('a&nbsp;b &lt;3 &gt;'), 'a b <3 >');
  assert.equal(decodeHtmlEntities('Tom&apos;s caf&#233; &copy; 2026'), 'Tom\'s café © 2026');
});

test('decoding happens once, so an escaped entity is not decoded twice', () => {
  assert.equal(decodeHtmlEntities('&amp;#8217;'), '&#8217;');
  assert.equal(decodeHtmlEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;');
});

test('what is not a known entity stays as it was written', () => {
  assert.equal(decodeHtmlEntities('Q&A; R&D; AT&T'), 'Q&A; R&D; AT&T');
  assert.equal(decodeHtmlEntities('&unknownthing; &#; &#xZZ; &#99999999;'), '&unknownthing; &#; &#xZZ; &#99999999;');
  assert.equal(decodeHtmlEntities('&constructor; &__proto__;'), '&constructor; &__proto__;');
});

test('control characters and surrogates are not decoded', () => {
  assert.equal(decodeHtmlEntities('a&#0;b&#27;c&#xD800;d'), 'a&#0;b&#27;c&#xD800;d');
});

test('anything that is not text becomes an empty string', () => {
  assert.equal(decodeHtmlEntities(undefined), '');
  assert.equal(decodeHtmlEntities(null), '');
  assert.equal(decodeHtmlEntities(42), '');
  assert.equal(decodeHtmlEntities(''), '');
  assert.equal(decodeHtmlEntities('plain title'), 'plain title');
});

test('a title from a real feed, escaped twice, comes out clean', async () => {
  const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>Nvidia&amp;#8217;s new chip &amp;#8211; and why</title><link>http://x/1</link></item>
  <item><title><![CDATA[Zetaris&#8217; lakehouse &#8220;tour&#8221;]]></title><link>http://x/2</link></item>
</channel></rss>`;
  const feed = await new Parser().parseString(xml);

  assert.equal(feed.items[0].title, 'Nvidia&#8217;s new chip &#8211; and why');
  assert.equal(decodeHtmlEntities(feed.items[0].title), 'Nvidia’s new chip – and why');
  assert.equal(decodeHtmlEntities(feed.items[1].title), 'Zetaris’ lakehouse “tour”');
});

test('repairTitles fixes saved titles in place and counts them', () => {
  const news = [
    { id: 'a', title: 'It&#8217;s done', content: 'Tom &amp; Jerry' },
    { id: 'b', title: 'Already clean' },
    { id: 'c', title: 'Fish &amp; chips' },
    { id: 'd' },
    null
  ];

  assert.equal(repairTitles(news), 2);
  assert.equal(news[0].title, 'It’s done');
  assert.equal(news[2].title, 'Fish & chips');
  assert.equal(news[1].title, 'Already clean');
  // Only titles are repaired.
  assert.equal(news[0].content, 'Tom &amp; Jerry');

  assert.equal(repairTitles(news), 0);
  assert.equal(repairTitles(undefined), 0);
});
