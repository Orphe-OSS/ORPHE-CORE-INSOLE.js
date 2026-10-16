/**
 * ランディングページの言語別静的生成（scripts/build-landing.mjs）の回帰テスト。
 *
 * - index.html（日本語 / 既定 / x-default）と en/index.html（英語）がソースから再生成した
 *   結果と一致すること（生成物のコミット漏れを検出）
 * - 各ページの lang / title / description / canonical / hreflang / og:locale / 既定言語が
 *   言語ごとに正しいこと。hreflang に ?lang= クエリを使わないこと
 * - /en/ 配下の相対リンク・画像・フォントがすべて実在するファイルへ解決すること
 * - JSON-LD の softwareVersion が package.json と同期していること
 * - 日本語ページへの再適用が冪等であること
 * - 辞書に無いキーが無いこと（両言語）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLandingPages, LANGUAGES, SITE_URL } from '../scripts/build-landing.mjs';
import type { LandingLanguage } from '../scripts/build-landing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
const LANGUAGE_KEYS = Object.keys(LANGUAGES) as LandingLanguage[];

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function attr(html: string, re: RegExp, label: string): string {
  const m = html.match(re);
  assert.ok(m, `${label} not found`);
  return m[1] ?? '';
}

test('landing pages are generated from index.html and committed', () => {
  const built = buildLandingPages();
  const { outputs, translations } = built;

  for (const [file, html] of Object.entries(outputs)) {
    assert.equal(read(file), html, `${file} is out of date — run \`npm run build:site\` and commit`);
  }
  assert.deepEqual(Object.keys(outputs).sort(), ['en/index.html', 'index.html']);

  for (const language of LANGUAGE_KEYS) {
    const config = LANGUAGES[language];
    const html = outputs[config.file] ?? '';
    const strings = translations[language];
    const pageUrl = SITE_URL + config.dir;

    assert.equal(attr(html, /<html lang="([^"]*)">/, 'html lang'), language, `${config.file}: lang`);
    assert.equal(attr(html, /<title>([^<]*)<\/title>/, 'title'), strings.metaTitle, `${config.file}: title`);
    assert.equal(attr(html, /<meta name="description"\s+content="([^"]*)"/, 'description'), strings.metaDescription);
    assert.equal(attr(html, /<meta property="og:locale" content="([^"]*)"/, 'og:locale'), config.locale);
    assert.equal(attr(html, /<meta property="og:url" content="([^"]*)"/, 'og:url'), pageUrl);
    assert.equal(attr(html, /<link rel="canonical"\s+href="([^"]*)"/, 'canonical'), pageUrl);
    assert.equal(attr(html, /<link rel="alternate" hreflang="ja"\s+href="([^"]*)"/, 'hreflang ja'), SITE_URL);
    assert.equal(attr(html, /<link rel="alternate" hreflang="en"\s+href="([^"]*)"/, 'hreflang en'), SITE_URL + 'en/');
    assert.equal(attr(html, /<link rel="alternate" hreflang="x-default"\s+href="([^"]*)"/, 'hreflang x-default'), SITE_URL);
    assert.ok(!/<link[^>]*hreflang[^>]*\?lang=/.test(html), `${config.file}: hreflang must not use ?lang=`);
    assert.equal(attr(html, /\n {4}let lang = "([^"]*)";\n/, 'let lang'), language, `${config.file}: default language`);
    assert.equal(attr(html, /"softwareVersion": "([^"]*)"/, 'softwareVersion'), pkg.version, `${config.file}: JSON-LD version`);
    assert.equal(attr(html, /"inLanguage": "([^"]*)"/, 'inLanguage'), language);

    for (const buttonLanguage of LANGUAGE_KEYS) {
      const re = new RegExp(`<button type="button" data-lang-button="${buttonLanguage}" data-lang-href="([^"]*)" aria-pressed="(true|false)"( class="active")?>`);
      const m = html.match(re);
      assert.ok(m, `${config.file}: lang button ${buttonLanguage}`);
      assert.equal(m[1], config.buttonHref[buttonLanguage]);
      assert.equal(m[2], String(buttonLanguage === language));
      assert.equal(Boolean(m[3]), buttonLanguage === language);
    }

    assert.ok(html.includes(`data-i18n="heroEyebrow">${strings.heroEyebrow}<`), `${config.file}: heroEyebrow rendered`);
    assert.ok(html.includes(`data-i18n="navExamples">${strings.navExamples}<`), `${config.file}: navExamples rendered`);
  }

  // /en/ の相対 URL がすべて実在ファイルへ解決する（api_doc/ は CI でだけ生成されるので除外）
  const en = outputs['en/index.html'] ?? '';
  const enDir = path.join(ROOT, 'en');
  const urls: string[] = [];
  for (const m of en.matchAll(/\s(?:href|src)="([^"]*)"/g)) urls.push(m[1] ?? '');
  for (const m of en.matchAll(/url\("([^"]*)"\)/g)) urls.push(m[1] ?? '');
  const local = urls.filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(u));
  assert.ok(local.length > 10, 'expected many local references in en/index.html');
  for (const url of local) {
    assert.ok(url.startsWith('../'), `en/index.html: local url must be prefixed with ../: ${url}`);
    const clean = url.replace(/[?#].*$/, '');
    if (clean.startsWith('../api_doc/')) continue;
    const target = path.resolve(enDir, clean);
    const exists = fs.existsSync(target) && (!clean.endsWith('/') || fs.statSync(target).isDirectory());
    assert.ok(exists, `en/index.html: missing target for ${url}`);
  }
  assert.match(en, /^<!doctype html>\n<!-- Generated by scripts\/build-landing\.mjs/i, 'en/index.html carries generated notice after doctype');

  const ja = outputs['index.html'] ?? '';
  assert.ok(!ja.includes('Generated by scripts/build-landing.mjs'), 'index.html has no generated notice (it is the source)');
  assert.ok(!/(?:href|src)="\.\.\//.test(ja), 'index.html must not contain ../ prefixed urls');

  const again = buildLandingPages({ source: ja });
  assert.equal(again.outputs['index.html'], ja, 'ja rendering is idempotent');
  assert.equal(again.outputs['en/index.html'], en, 'en rendering from normalized source is stable');

  for (const language of LANGUAGE_KEYS) {
    const keys = built.missing[language];
    assert.deepEqual(keys, [], `translations.${language} lacks keys: ${keys.join(', ')}`);
  }

  // 両言語の辞書キーが一致する
  assert.deepEqual(Object.keys(translations.ja).sort(), Object.keys(translations.en).sort(), 'translation keys differ between ja and en');
});
