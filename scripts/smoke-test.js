// Live smoke test of the store randomizer (no API key needed): `npm run check`
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { EnvFile } = require('../lib/env');
const steam = require('../lib/steam');
const randomizer = require('../lib/randomizer');

const settings = { cc: 'ru', lang: 'russian' };
const base = {
  includeTags: [], excludeTags: [], priceMode: 'any', os: [], players: [], features: [],
  deck: 'any', vr: 'any', hideUnreleased: true, hideAdult: true,
};

async function main() {
  // .env round trip keeps foreign lines and removes emptied keys
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sr-')), '.env');
  fs.writeFileSync(file, '# comment\nOTHER=1\nSTEAM_ID=old\n');
  const env = new EnvFile(file);
  env.update({ STEAM_API_KEY: 'ABC', STEAM_ID: '' });
  assert.deepStrictEqual(env.read(), { OTHER: '1', STEAM_API_KEY: 'ABC' });
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('# comment'));
  console.log('env: ok');

  await assert.rejects(steam.validateKey('nope'), /32/);
  await assert.rejects(steam.validateKey('0'.repeat(32)), (e) => e.code === 'BAD_KEY');
  console.log('key validation: ok');

  const tags = await steam.getTags('russian');
  const names = new Map(tags.map((t) => [t.id, t.name]));
  console.log(`tags: ${tags.length}`);

  const cases = [
    ['без фильтров', {}],
    ['рогалик, 90%+, 2018-2024, до 1000₽', { includeTags: [1716], minPositive: 90, minReviews: 100, yearFrom: 2018, yearTo: 2024, priceMax: 1000, priceMode: 'paid' }],
    ['бесплатный кооп без шутеров', { priceMode: 'free', players: [38], excludeTags: [1663], minPositive: 70 }],
    ['Deck verified, скидка 50%+', { deck: 'verified', onSale: true, minDiscount: 50 }],
    ['скрытые жемчужины', { minPositive: 90, minReviews: 50, maxReviews: 3000, hideEarlyAccess: true }],
  ];
  for (const [label, extra] of cases) {
    const f = { ...base, ...extra };
    const started = Date.now();
    const result = await randomizer.rollStore(f, settings, { exclude: new Set() });
    assert.ok(randomizer.matches(result.item, f, { exclude: new Set(), library: false }));
    const card = await randomizer.describe(result, settings, names);
    const price = card.price ? (card.price.free ? 'free' : card.price.formatted) : '?';
    console.log(
      `${label}: ${card.name} [${card.releaseDate}; ${card.reviews?.percent}% / ${card.reviews?.count}; ${price}; ` +
        `pool ${result.total}, checked ${result.checked}, ${Date.now() - started}ms] tags: ${card.tags.slice(0, 4).join(', ')}`,
    );
  }

  // Library mode with a fake owned list (GetItems itself needs no key)
  const owned = [
    { appid: 1145360, name: 'Hades', playtime: 0 },
    { appid: 730, name: 'Counter-Strike 2', playtime: 6000 },
    { appid: 413150, name: 'Stardew Valley', playtime: 30 },
    { appid: 1086940, name: "Baldur's Gate 3", playtime: 0 },
  ];
  const lib = (extra) => randomizer.rollLibrary({ ...base, ...extra }, settings, { owned, exclude: new Set() });
  assert.strictEqual((await lib({ playtime: 'over', playtimeHours: 50 })).item.appid, 730);
  assert.strictEqual((await lib({ playtime: 'never', includeTags: [42804 /* Action Roguelike */] })).item.appid, 1145360);
  assert.strictEqual((await lib({ excludeTags: [1663], players: [1], yearTo: 2016, playtime: 'under', playtimeHours: 5 })).item.appid, 413150);
  await assert.rejects(lib({ playtime: 'never', players: [36] }), (e) => e.code === 'NO_MATCH');
  console.log('library filters: ok');

  await assert.rejects(
    randomizer.rollStore({ ...base, includeTags: [1716, 1663, 4182], maxReviews: 0, minReviews: 1 }, settings, { exclude: new Set() }),
    (e) => e.code === 'NO_MATCH',
  );
  console.log('impossible filters -> NO_MATCH: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
