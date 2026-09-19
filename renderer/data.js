// Static option lists for the filter panel and settings.
window.DATA = {
  DEFAULT_FILTERS: {
    includeTags: [],
    excludeTags: [],
    priceMode: 'any',
    priceMin: '',
    priceMax: '',
    onSale: false,
    minDiscount: 0,
    minPositive: 0,
    minReviews: '',
    maxReviews: '',
    yearFrom: '',
    yearTo: '',
    hideUnreleased: true,
    players: [],
    features: [],
    os: [],
    deck: 'any',
    vr: 'any',
    language: '',
    hideEarlyAccess: false,
    hideAdult: true,
    topSellers: false,
    excludeOwned: false,
    noRepeat: true,
    playtime: 'any',
    playtimeHours: 2,
  },

  // Names and hints come from renderer/i18n.js: preset.<id>, preset.<id>.hint, player.<id>, feature.<id>, lang.<id>, region.<id>.
  PRESETS: [
    { id: 'gems', filters: { minPositive: 90, minReviews: 50, maxReviews: 3000 } },
    { id: 'classic', filters: { minPositive: 85, minReviews: 10000, yearTo: 2016 } },
    { id: 'free', filters: { priceMode: 'free', minPositive: 80, minReviews: 1000 } },
    { id: 'coop', filters: { players: [38], minPositive: 80, minReviews: 300 } },
    { id: 'fresh', filters: { yearFrom: new Date().getFullYear(), minPositive: 75, minReviews: 30 } },
    { id: 'sale', filters: { onSale: true, minDiscount: 50, minPositive: 80, minReviews: 200 } },
    { id: 'deck', filters: { deck: 'verified', minPositive: 80, minReviews: 200 } },
  ],

  PLAYERS: [2, 1, 9, 38, 39, 48, 49, 36, 37, 20, 27],

  FEATURES: [22, 29, 28, 30, 23, 44, 62, 17],

  // '' = any language (lang.any)
  LANGUAGES: ['', 'russian', 'english', 'ukrainian', 'german', 'french', 'spanish', 'italian', 'polish', 'brazilian', 'turkish',
    'japanese', 'koreana', 'schinese'],

  // currency is what Steam actually charges in the region; Belarus and Turkey are priced in USD by Steam.
  REGIONS: [
    { id: 'ru', currency: '₽' },
    { id: 'kz', currency: '₸' },
    { id: 'ua', currency: '₴' },
    { id: 'by', currency: '$', usdOnly: true },
    { id: 'us', currency: '$' },
    { id: 'de', currency: '€' },
    { id: 'pl', currency: 'zł' },
    { id: 'gb', currency: '£' },
    { id: 'tr', currency: '$', usdOnly: true },
    { id: 'br', currency: 'R$' },
    { id: 'jp', currency: '¥' },
  ],

  // Interface languages, each named in itself; the ids match the keys in renderer/i18n.js.
  UI_LANGUAGES: [
    { id: 'russian', name: 'Русский' },
    { id: 'english', name: 'English' },
    { id: 'ukrainian', name: 'Українська' },
  ],

  // Info popover next to the filters heading, keyed by UI_LANGUAGES id. `webOnly` paragraphs are hidden in the desktop app.
  FILTER_HELP: {
    russian: {
      label: 'Почему узкие фильтры могут ничего не найти',
      title: 'Чем уже фильтры, тем выше шанс упереться в лимит',
      lead: 'За один бросок приложение проверяет ограниченное число игр. Если под фильтры подходит лишь редкая игра из многих тысяч, в проверенную выборку она может просто не попасть — тогда появится ошибка «Упёрлись в лимит проверки» или «Ничего не нашлось».',
      adviceTitle: 'Что делать',
      advice: [
        'Достаточно сделать фильтры чуть менее строгими — обычно хватает одного шага.',
        'Снизьте «Положительных от» на 5–10%: 90% вместо 95% пропускает в разы больше игр.',
        'Расширьте диапазон лет, цены или числа отзывов, уберите верхнюю границу отзывов.',
        'Steam Deck «Играбельно+» → «Любая», скидку «от 75%» → «от 50%».',
        'Метки, платформы, язык и число игроков, наоборот, помогают: Steam отбирает по ним сам и сужает выборку до нужных игр.',
      ],
      detailsSummary: 'Почему так работает (как устроен поиск)',
      details: [
        { text: 'Поиск Steam понимает только часть фильтров: метки, платформы, язык, число игроков, особенности, «бесплатно / платные», «со скидкой», «Проверено для Deck», «Только VR» и лидеров продаж. Их Steam применяет сам и возвращает список подходящих игр — это пул.' },
        { text: 'Процент положительных обзоров, число отзывов, год выхода, диапазон цены, размер скидки, «Играбельно» на Deck, «Без VR» и 18+ поиск Steam фильтровать не умеет. Поэтому приложение загружает случайные страницы пула по 100 игр, запрашивает по ним подробности и проверяет эти условия само.' },
        { text: 'За один бросок проверяется не больше 16 страниц, то есть 1600 игр, по две страницы за раз. Если запрашивать больше или чаще, Steam отвечает ошибкой 429 и на время блокирует запросы.' },
        { text: 'На сайте есть и свои ограничения: не больше 8 поисков в минуту с одного IP и 4 одновременных поиска на весь сервер — чтобы не исчерпать дневной лимит ключа Steam API.', webOnly: true },
        { text: 'Пример: в пуле 50 000 игр, а под все фильтры подходят 10. Это одна игра на 5000, и среди 1600 проверенных её, скорее всего, не будет. Ослабьте фильтр до 200 подходящих — и игра найдётся почти всегда.' },
      ],
    },
    english: {
      label: 'Why narrow filters may find nothing',
      title: 'The narrower the filters, the more likely you hit the limit',
      lead: 'Each roll checks a limited number of games. If only a rare game out of many thousands matches your filters, it may simply not be in the checked sample — then you get “Hit the check limit” or “Nothing found”.',
      adviceTitle: 'What to do',
      advice: [
        'Just make the filters a little less strict — one step is usually enough.',
        'Lower “Positive from” by 5–10%: 90% instead of 95% lets through several times more games.',
        'Widen the year, price or review-count range, or drop the maximum number of reviews.',
        'Steam Deck “Playable+” → “Any”, discount “from 75%” → “from 50%”.',
        'Tags, platforms, language and player count actually help: Steam filters by them itself and narrows the pool to the right games.',
      ],
      detailsSummary: 'Why it works this way (how the search works)',
      details: [
        { text: 'Steam search understands only some filters: tags, platforms, language, player count, features, free / paid, on sale, Deck Verified, VR only and top sellers. Steam applies them itself and returns the list of matching games — the pool.' },
        { text: 'Positive review percentage, review count, release year, price range, discount size, Deck Playable, “No VR” and 18+ can’t be filtered by Steam search. So the app loads random pages of the pool, 100 games each, requests their details and checks these conditions itself.' },
        { text: 'A single roll checks at most 16 pages — 1,600 games — two pages at a time. Asking for more or faster makes Steam answer with error 429 and block requests for a while.' },
        { text: 'The website has its own limits too: at most 8 searches per minute per IP and 4 simultaneous searches server-wide, so the daily Steam API key quota isn’t exhausted.', webOnly: true },
        { text: 'Example: the pool has 50,000 games and 10 of them match all filters. That’s one game in 5,000, so the 1,600 checked games most likely won’t include it. Relax the filters to 200 matches and a game is found almost every time.' },
      ],
    },
    ukrainian: {
      label: 'Чому вузькі фільтри можуть нічого не знайти',
      title: 'Що вужчі фільтри, то вищий шанс упертися в ліміт',
      lead: 'За один кидок застосунок перевіряє обмежену кількість ігор. Якщо під фільтри підходить лише рідкісна гра з багатьох тисяч, до перевіреної вибірки вона може просто не потрапити — тоді з’явиться помилка «Упёрлись в лимит проверки» («Уперлися в ліміт перевірки») або «Ничего не нашлось» («Нічого не знайшлося»).',
      adviceTitle: 'Що робити',
      advice: [
        'Досить зробити фільтри трохи менш суворими — зазвичай вистачає одного кроку.',
        'Знизьте «Позитивних від» на 5–10%: 90% замість 95% пропускає в рази більше ігор.',
        'Розширте діапазон років, ціни або кількості відгуків, приберіть верхню межу відгуків.',
        'Steam Deck «Придатно+» → «Будь-яка», знижку «від 75%» → «від 50%».',
        'Мітки, платформи, мова й кількість гравців, навпаки, допомагають: Steam відбирає за ними сам і звужує вибірку до потрібних ігор.',
      ],
      detailsSummary: 'Чому так працює (як влаштовано пошук)',
      details: [
        { text: 'Пошук Steam розуміє лише частину фільтрів: мітки, платформи, мову, кількість гравців, особливості, «безкоштовно / платні», «зі знижкою», «Перевірено для Deck», «Тільки VR» і лідерів продажів. Їх Steam застосовує сам і повертає список відповідних ігор — це пул.' },
        { text: 'Відсоток позитивних оглядів, кількість відгуків, рік виходу, діапазон ціни, розмір знижки, «Придатно» на Deck, «Без VR» і 18+ пошук Steam фільтрувати не вміє. Тому застосунок завантажує випадкові сторінки пулу по 100 ігор, запитує по них подробиці й перевіряє ці умови сам.' },
        { text: 'За один кидок перевіряється не більше 16 сторінок, тобто 1600 ігор, по дві сторінки за раз. Якщо запитувати більше або частіше, Steam відповідає помилкою 429 і на час блокує запити.' },
        { text: 'На сайті є й власні обмеження: не більше 8 пошуків на хвилину з однієї IP-адреси та 4 одночасні пошуки на весь сервер — щоб не вичерпати денний ліміт ключа Steam API.', webOnly: true },
        { text: 'Приклад: у пулі 50 000 ігор, а під усі фільтри підходять 10. Це одна гра на 5000, і серед 1600 перевірених її, найімовірніше, не буде. Послабте фільтри до 200 відповідних — і гра знайдеться майже завжди.' },
      ],
    },
  },
};
