'use strict';

/**
 * Feeds escape text twice more often than one would think: WordPress writes
 * `<title>It&amp;#8217;s</title>` or `<![CDATA[It&#8217;s]]>`, the XML parser
 * undoes one level, and the title is left with a literal `&#8217;`. The UI shows
 * text, not HTML, so such a title has to be decoded once, here.
 */

// The names feeds actually use; anything else is left as it was written.
const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  sbquo: '‚',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢'
});

const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,9}));/g;

function fromCodePoint(codePoint) {
  // Control characters and surrogates never belong in a title.
  const printable =
    codePoint >= 0x20 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
  return printable ? String.fromCodePoint(codePoint) : null;
}

/**
 * Decode `&#8217;`, `&#x2019;` and the common named entities, once.
 * An unknown or malformed entity stays as it was.
 *
 * @param {unknown} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  if (typeof text !== 'string') return '';
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (match, decimal, hex, name) => {
    if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10)) ?? match;
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16)) ?? match;
    return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match;
  });
}

/**
 * Decode the title of every news item that still carries an entity, in place
 * (items saved before titles were decoded). Returns how many changed.
 *
 * @param {Array<{ title?: unknown }>} news
 * @returns {number}
 */
function repairTitles(news) {
  let repaired = 0;
  for (const item of Array.isArray(news) ? news : []) {
    if (typeof item?.title !== 'string') continue;
    const decoded = decodeHtmlEntities(item.title);
    if (decoded === item.title) continue;
    item.title = decoded;
    repaired += 1;
  }
  return repaired;
}

module.exports = { decodeHtmlEntities, repairTitles };
