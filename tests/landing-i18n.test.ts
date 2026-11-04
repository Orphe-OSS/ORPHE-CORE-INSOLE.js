/**
 * 紹介ページの言語別静的生成（scripts/build-landing.mjs）の回帰テスト。
 *
 * 対象は PAGES の各ページ（index.html = ランディング、sample-data/index.html = サンプルデータ）。
 *
 * - 日本語（ソース兼 / 既定 / x-default）と en/ 配下（英語）がソースから再生成した
 *   結果と一致すること（生成物のコミット漏れを検出）
 * - 各ページの lang / title / description / canonical / hreflang / og:locale / 既定言語が
 *   言語ごとに正しいこと。hreflang に ?lang= クエリを使わないこと
 * - 生成先の相対リンク・画像・フォントがすべて実在するファイルへ解決し、ページへのリンクは同じ言語を指すこと
 * - JSON-LD の softwareVersion が package.json と同期していること（ランディングのみ）
 * - 日本語ページへの再適用が冪等であること
 * - 辞書に無いキーが無いこと（両言語）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLandingPages, languageButtonHref, LANGUAGES, outputFile, PAGES, pageUrl, rewriteRelativeUrl, SITE_URL, SOURCE_FILE } from '../scripts/build-landing.mjs';
import type { LandingLanguage } from '../scripts/build-landing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
const LANGUAGE_KEYS = Object.keys(LANGUAGES) as LandingLanguage[];
const TOP_PAGE = PAGES[0]!;
/** CI でだけ生成する（api_doc/）、または Release から生成する（sample-data/files/）ため実在を確認しないパス */
const GENERATED_PATHS = ['api_doc/', 'sample-data/files/'];

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function attr(html: string, re: RegExp, label: string): string {
  const m = html.match(re);
  assert.ok(m, `${label} not found`);
  return m[1] ?? '';
}

/** サイトのルートからの相対パス（ディレクトリは末尾 /、ルートは /）が言語別ページなら、その言語 */
function pageLanguageOf(relativeToRoot: string): LandingLanguage | null {
  const normalized = relativeToRoot === '/' ? '' : relativeToRoot;
  for (const language of LANGUAGE_KEYS) {
    if (PAGES.some((page) => normalized === LANGUAGES[language].dir + page.path)) return language;
  }
  return null;
}

function localUrls(html: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) urls.push(m[1] ?? '');
  for (const m of html.matchAll(/url\("([^"]*)"\)/g)) urls.push(m[1] ?? '');
  return urls.filter((u) => u !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(u));
}

test('紹介ページの各言語版がソースから生成され、コミット済みである', () => {
  const built = buildLandingPages();
  const { outputs, pageTranslations } = built;

  for (const [file, html] of Object.entries(outputs)) {
    assert.equal(read(file), html, `${file} is out of date — run \`npm run build:site\` and commit`);
  }
  assert.deepEqual(Object.keys(outputs).sort(), ['en/index.html', 'en/sample-data/index.html', 'index.html', 'sample-data/index.html']);

  for (const page of PAGES) {
    const translations = pageTranslations[page.source]!;
    for (const language of LANGUAGE_KEYS) {
      const config = LANGUAGES[language];
      const file = outputFile(page, language);
      const html = outputs[file] ?? '';
      const strings = translations[language];

      assert.equal(attr(html, /<html lang="([^"]*)">/, 'html lang'), language, `${file}: lang`);
      assert.equal(attr(html, /<meta name="robots"\s+content="([^"]*)"/, 'robots'), 'noindex', `${file}: robots noindex`);
      assert.equal(attr(html, /<title>([^<]*)<\/title>/, 'title'), strings.metaTitle, `${file}: title`);
      assert.equal(attr(html, /<meta name="description"\s+content="([^"]*)"/, 'description'), strings.metaDescription);
      assert.equal(attr(html, /<meta property="og:locale" content="([^"]*)"/, 'og:locale'), config.locale);
      assert.equal(attr(html, /<meta property="og:url" content="([^"]*)"/, 'og:url'), pageUrl(page, language));
      assert.equal(attr(html, /<link rel="canonical"\s+href="([^"]*)"/, 'canonical'), pageUrl(page, language));
      assert.equal(attr(html, /<link rel="alternate" hreflang="ja"\s+href="([^"]*)"/, 'hreflang ja'), SITE_URL + page.path);
      assert.equal(attr(html, /<link rel="alternate" hreflang="en"\s+href="([^"]*)"/, 'hreflang en'), SITE_URL + 'en/' + page.path);
      assert.equal(attr(html, /<link rel="alternate" hreflang="x-default"\s+href="([^"]*)"/, 'hreflang x-default'), SITE_URL + page.path);
      assert.ok(!/<link[^>]*hreflang[^>]*\?lang=/.test(html), `${file}: hreflang must not use ?lang=`);
      assert.equal(attr(html, /\n {4}let lang = "([^"]*)";\n/, 'let lang'), language, `${file}: default language`);
      if (page === TOP_PAGE) {
        assert.equal(attr(html, /"softwareVersion": "([^"]*)"/, 'softwareVersion'), pkg.version, `${file}: JSON-LD version`);
        assert.equal(attr(html, /"inLanguage": "([^"]*)"/, 'inLanguage'), language);
      }

      for (const buttonLanguage of LANGUAGE_KEYS) {
        const re = new RegExp(`<button type="button" data-lang-button="${buttonLanguage}" data-lang-href="([^"]*)" aria-pressed="(true|false)"( class="active")?>`);
        const m = html.match(re);
        assert.ok(m, `${file}: lang button ${buttonLanguage}`);
        assert.equal(m[1], languageButtonHref(page, language, buttonLanguage));
        assert.equal(m[2], String(buttonLanguage === language));
        assert.equal(Boolean(m[3]), buttonLanguage === language);
        // 言語ボタンの移動先は、もう一方の言語の同じページ
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1] ?? ''));
        assert.equal(target.replace(/\/?$/, '/').replace(/^\.\/$/, ''), LANGUAGES[buttonLanguage].dir + page.path, `${file}: lang button ${buttonLanguage} target`);
      }

      assert.ok(html.includes(`data-i18n="heroEyebrow">${strings.heroEyebrow}<`), `${file}: heroEyebrow rendered`);

      // 相対 URL がすべて実在ファイルへ解決する。言語別ページへのリンクは同じ言語のページを指す
      const fileDir = path.join(ROOT, path.dirname(file));
      for (const url of localUrls(html)) {
        const clean = url.replace(/[?#].*$/, '');
        const relativeToRoot = path.relative(ROOT, path.resolve(fileDir, clean)).split(path.sep).join('/') + (clean.endsWith('/') ? '/' : '');
        if (GENERATED_PATHS.some((prefix) => relativeToRoot.startsWith(prefix))) continue;
        const target = path.resolve(fileDir, clean);
        const exists = fs.existsSync(target) && (!clean.endsWith('/') || fs.statSync(target).isDirectory());
        assert.ok(exists, `${file}: missing target for ${url}`);
        const linkedLanguage = pageLanguageOf(relativeToRoot);
        if (linkedLanguage) assert.equal(linkedLanguage, language, `${file}: ${url} points to the ${linkedLanguage} page`);
      }
    }

    const ja = outputs[page.source] ?? '';
    const en = outputs[outputFile(page, 'en')] ?? '';
    assert.match(en, /^<!doctype html>\n<!-- Generated by scripts\/build-landing\.mjs/i, `${outputFile(page, 'en')} carries generated notice after doctype`);
    assert.ok(!ja.includes('Generated by scripts/build-landing.mjs'), `${page.source} has no generated notice (it is the source)`);

    const again = buildLandingPages({ sources: { [page.source]: ja } });
    assert.equal(again.outputs[page.source], ja, `${page.source}: ja rendering is idempotent`);
    assert.equal(again.outputs[outputFile(page, 'en')], en, `${page.source}: en rendering from normalized source is stable`);

    // 両言語の辞書キーが一致する
    assert.deepEqual(Object.keys(translations.ja).sort(), Object.keys(translations.en).sort(), `${page.source}: translation keys differ between ja and en`);
  }
  assert.ok(!/(?:href|src)="\.\.\//.test(outputs[SOURCE_FILE] ?? ''), 'index.html must not contain ../ prefixed urls');

  for (const language of LANGUAGE_KEYS) {
    const keys = built.missing[language];
    assert.deepEqual(keys, [], `translations.${language} lacks keys: ${keys.join(', ')}`);
  }
});

test('相対 URL は、ページへのリンクなら同じ言語のページ、それ以外は共有ファイルを指す', () => {
  const sample = PAGES.find((page) => page.path === 'sample-data/')!;
  const cases: [typeof sample, string, string][] = [
    [TOP_PAGE, 'assets/site.css', '../assets/site.css'],
    [TOP_PAGE, 'api_doc/', '../api_doc/'],
    [TOP_PAGE, 'sample-data/', 'sample-data/'],
    [TOP_PAGE, 'sample-data/#trial-03_freezing', 'sample-data/#trial-03_freezing'],
    [TOP_PAGE, 'sample-data/files/03_freezing/poster.jpg', '../sample-data/files/03_freezing/poster.jpg'],
    [TOP_PAGE, '#about', '#about'],
    [TOP_PAGE, 'https://example.com/x.png', 'https://example.com/x.png'],
    [sample, '../', '../'],
    [sample, './', './'],
    [sample, '../#about', '../#about'],
    [sample, '../assets/site.css', '../../assets/site.css'],
    [sample, '../api_doc/', '../../api_doc/'],
    [sample, 'viewer.js', '../../sample-data/viewer.js'],
    [sample, 'files/01_normal_walking/poster.jpg', '../../sample-data/files/01_normal_walking/poster.jpg'],
  ];
  for (const [page, url, expectedEn] of cases) {
    assert.equal(rewriteRelativeUrl(url, page, 'ja'), url, `ja: ${page.source} ${url}`);
    assert.equal(rewriteRelativeUrl(url, page, 'en'), expectedEn, `en: ${page.source} ${url}`);
  }
});

// ブラウザ側の翻訳処理が静的生成の漏れを隠さないよう、スクリプトを実行せず解析する。
test('全翻訳対象の静的本文・HTML・ARIAが辞書と一致する', async () => {
  const { Window } = await import('happy-dom');
  const { outputs, pageTranslations } = buildLandingPages();
  for (const page of PAGES) {
    for (const language of LANGUAGE_KEYS) {
      const window = new Window();
      try {
        const document = window.document;
        document.documentElement.innerHTML = outputs[outputFile(page, language)]!;
        const strings = pageTranslations[page.source]![language];
        const where = `${outputFile(page, language)}`;
        for (const element of document.querySelectorAll('[data-i18n]')) {
          const key = element.getAttribute('data-i18n')!;
          assert.equal(element.textContent, strings[key], `${where}: ${key}`);
        }
        for (const element of document.querySelectorAll('[data-i18n-html]')) {
          const key = element.getAttribute('data-i18n-html')!;
          assert.ok(Object.hasOwn(strings, key), `${where}: ${key} が未定義`);
          const expected = document.createElement('div');
          expected.innerHTML = strings[key]!;
          // 生成先での相対URL補正を含めて比較する。
          for (const link of expected.querySelectorAll('[href], [src]')) {
            for (const name of ['href', 'src']) {
              const value = link.getAttribute(name);
              if (value) link.setAttribute(name, rewriteRelativeUrl(value, page, language));
            }
          }
          assert.equal(element.innerHTML, expected.innerHTML, `${where}: ${key}`);
        }
        for (const element of document.querySelectorAll('[data-i18n-aria-label]')) {
          const key = element.getAttribute('data-i18n-aria-label')!;
          assert.equal(element.getAttribute('aria-label'), strings[key], `${where}: ${key}`);
        }
      } finally {
        await window.happyDOM.close();
      }
    }
  }
});

test('翻訳属性が先頭・途中でも適用し、存在しないキーも検出する', async () => {
  const { Window } = await import('happy-dom');
  const fixture = `
    <p data-i18n="heroEyebrow" id="text-first">未翻訳</p>
    <p id="text-later" data-i18n="heroEyebrow">未翻訳</p>
    <p data-i18n-html="feature1Body" id="html-first">未翻訳</p>
    <p id="html-later" data-i18n-html="feature1Body">未翻訳</p>
    <div data-i18n-aria-label="navLabel" id="aria-first"></div>
    <div id="aria-later" data-i18n-aria-label="navLabel" aria-label="未翻訳"></div>
    <p data-i18n="missingText">保持</p>
    <p data-i18n-html="missingHtml">保持</p>
    <div data-i18n-aria-label="missingAria" aria-label="保持"></div>
  `;
  const built = buildLandingPages({ source: read('index.html').replace('</body>', fixture + '</body>') });
  for (const language of LANGUAGE_KEYS) {
    assert.deepEqual(built.missing[language].sort(), ['missingAria', 'missingHtml', 'missingText']);
    const window = new Window();
    try {
      const document = window.document;
      document.documentElement.innerHTML = built.outputs[outputFile(TOP_PAGE, language)]!;
      const strings = built.translations[language];
      for (const order of ['first', 'later']) {
        assert.equal(document.getElementById(`text-${order}`)!.textContent, strings.heroEyebrow);
        const expected = document.createElement('div');
        expected.innerHTML = strings.feature1Body!;
        assert.equal(document.getElementById(`html-${order}`)!.innerHTML, expected.innerHTML);
        assert.equal(document.getElementById(`aria-${order}`)!.getAttribute('aria-label'), strings.navLabel);
      }
      assert.equal(document.querySelector('[data-i18n="missingText"]')!.textContent, '保持');
      assert.equal(document.querySelector('[data-i18n-html="missingHtml"]')!.textContent, '保持');
      assert.equal(document.querySelector('[data-i18n-aria-label="missingAria"]')!.getAttribute('aria-label'), '保持');
    } finally {
      await window.happyDOM.close();
    }
  }
});
