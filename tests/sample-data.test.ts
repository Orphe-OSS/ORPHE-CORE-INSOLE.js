/**
 * サンプルデータ（scripts/sample-data.mjs、sample-data/）のテスト。
 *
 * - 時刻合わせ: 動画のジャンプ着地の推定、右足の補正、動画の再生位置
 * - ストライド平均: 接地の検出、定常ストライドの選択、0〜100% への正規化
 * - trials.json の ZIP 情報の書き換えが書式を崩さないこと
 * - trials.json とページ（サンプルデータ・ランディング）の ZIP リンク・サイズ・試技名が一致すること
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTrialData,
  detectContacts,
  estimateVideoOffset,
  meanAndSd,
  normalizeStride,
  parseJumpSyncOffsets,
  parseNumericCsv,
  readManifest,
  selectStrides,
  updateArchiveInfo,
} from '../scripts/sample-data.mjs';
import type { Contact } from '../scripts/sample-data.mjs';
import { buildLandingPages } from '../scripts/build-landing.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAME_S = 1 / 30;
const STANDING_Y = -0.45;
const SENSOR_HEADER = 'timestamp,accX,accY,accZ,gyroX,gyroY,gyroZ,quatW,quatX,quatY,quatZ,press1,press2,press3,press4,press5,press6,serialNumber,keyPoint';
const METRIC_KEYS = ['strideTime', 'stance', 'swingTime', 'strideLength', 'speed', 'strikeAngle', 'toeOffAngle', 'footHeight', 'swingWidth', 'footAngle', 'icAccZ', 'toeOffGyroX', 'swingVelY'];

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/** 30 fps の root 高さ: 立位 → しゃがみ → 放物線の跳躍（頂点は着地の 0.15 s 前）→ 着地で沈み込み → 立位 */
function jumpFrames(landingS: number): { t: number; y: number }[] {
  const frames: { t: number; y: number }[] = [];
  for (let i = 0; i * FRAME_S < landingS + 1.5; i += 1) {
    const t = i * FRAME_S;
    const dt = t - landingS;
    let y = STANDING_Y;
    if (dt > -0.6 && dt <= -0.3) y = STANDING_Y - 0.1 * Math.sin((Math.PI * (dt + 0.6)) / 0.3);
    else if (dt > -0.3 && dt <= 0) y = -0.3 - (0.15 / 0.0225) * (dt + 0.15) ** 2;
    else if (dt > 0 && dt <= 0.3) y = STANDING_Y - 0.1 * Math.sin((Math.PI * dt) / 0.3);
    frames.push({ t, y });
  }
  return frames;
}

function grid(start: number, end: number, rateHz: number): number[] {
  return Array.from({ length: Math.round((end - start) * rateHz) + 1 }, (_, i) => start + i / rateHz);
}

test('動画のジャンプ着地を root の高さから推定し、センサーの着地との差を返す', () => {
  // Arrange: 動画はセンサーより 0.3 s 遅れている
  const videoLandingS = 4;
  const sensorLandingS = videoLandingS - 0.3;
  const frames = jumpFrames(videoLandingS);

  // Act
  const offset = estimateVideoOffset(frames, sensorLandingS);

  // Assert: 30 fps なので 1 フレーム以内
  assert.ok(offset !== null);
  assert.ok(Math.abs(offset - 0.3) <= FRAME_S + 1e-9, `offset ${offset}`);
});

test('頂点〜着地で骨格の追跡が途切れた場合と、ジャンプが無い場合は推定しない', () => {
  // Arrange
  const videoLandingS = 4;
  const withGap = jumpFrames(videoLandingS).filter((f) => f.t < videoLandingS - 0.1 || f.t > videoLandingS + 0.05);
  const standing = jumpFrames(videoLandingS).map((f) => ({ t: f.t, y: STANDING_Y }));

  // Act
  const gapOffset = estimateVideoOffset(withGap, videoLandingS - 0.3);
  const standingOffset = estimateVideoOffset(standing, videoLandingS - 0.3);

  // Assert
  assert.equal(gapOffset, null);
  assert.equal(standingOffset, null);
});

test('接地区間は短い途切れをつなぎ、短い接地を捨てる', () => {
  // Arrange: 0.5〜1.0 s に接地（0.70〜0.73 s に 30 ms の途切れ）、2.00〜2.02 s に 20 ms のノイズ
  const t = grid(0, 3, 200);
  const total = t.map((s) => ((s >= 0.5 && s <= 1.0 && !(s > 0.7 && s < 0.73)) || (s >= 2.0 && s <= 2.02) ? 20 : 0));

  // Act
  const contacts = detectContacts(t, total);

  // Assert
  assert.equal(contacts.length, 1);
  assert.ok(Math.abs(contacts[0]!.ic - 0.5) < 0.006);
  assert.ok(Math.abs(contacts[0]!.to - 1.0) < 0.006);
});

test('ストライドはジャンプ直後の立位と、時間が中央値から外れたものを除く', () => {
  // Arrange: t = 0.2 はジャンプ着地後の立位、4.0〜6.5 は止まり際の長いストライド
  const contacts: Contact[] = [0.2, 1, 2, 3, 4, 6.5].map((ic) => ({ ic, to: ic + 0.6 }));

  // Act
  const strides = selectStrides(contacts);

  // Assert
  assert.deepEqual(strides.map((s) => s.start), [1, 2, 3]);
  assert.deepEqual(strides.map((s) => s.end), [2, 3, 4]);
  assert.ok(strides.every((s) => Math.abs(s.toeOff - s.start - 0.6) < 1e-9));
});

test('ストライドを 0〜100% の 101 点に正規化し、平均と標本標準偏差を求める', () => {
  // Arrange
  const t = grid(0, 2, 100);
  const values = t.map((s) => s * 10);
  const series = [new Array(101).fill(1), new Array(101).fill(3)];

  // Act
  const normalized = normalizeStride(t, values, { start: 0.5, toeOff: 1.1, end: 1.5 });
  const { mean, sd } = meanAndSd(series);

  // Assert
  assert.equal(normalized.length, 101);
  assert.ok(Math.abs(normalized[0]! - 5) < 1e-9);
  assert.ok(Math.abs(normalized[50]! - 10) < 1e-9);
  assert.ok(Math.abs(normalized[100]! - 15) < 1e-9);
  assert.equal(mean[0], 2);
  assert.ok(Math.abs(sd[0]! - Math.SQRT2) < 1e-12);
});

test('波形 JSON は左足のジャンプ着地を 0 とし、右足と動画をずれで補正する', () => {
  // Arrange: 左足は 1000.0 s から、右足は 0.1 s 早い時計（rightOffsetMs = −100）
  const rows = (start: number) => grid(start, start + 0.02, 200)
    .map((ts) => [ts, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 12, 1, 0].join(','));
  const sensorCsv = {
    left: [SENSOR_HEADER, ...rows(1000)].join('\n'),
    right: [SENSOR_HEADER, ...rows(1000)].join('\n'),
  };
  const meta = { id: 'x', sync: { tZeroUnix: 1001, rightOffsetMs: -100, videoStartUnix: 999.5, videoOffsetS: 0.3, videoOffsetMethod: 'jump' as const } };

  // Act
  const data = buildTrialData({ id: 'x', strideAverage: false }, meta, sensorCsv);

  // Assert
  assert.equal(data.videoTimeAtZeroS, 1.8);
  assert.equal(data.feet.left.t[0], -1);
  assert.equal(data.feet.right.t[0], -0.9);
  assert.deepEqual(data.feet.left.press[5]!.slice(0, 2), [12, 12]);
  assert.equal(data.strideAverage, null);
  assert.deepEqual(data.sync, { rightOffsetMs: -100, videoOffsetS: 0.3, videoOffsetMethod: 'jump' });
});

test('CSV と jump_sync_offsets.csv を数値として読む', () => {
  // Arrange
  const csv = 'a,b\n1,nan\n2,3\n';
  const offsets = 'condition,t_zero_unix,right_offset_ms,xcorr_r\n5m歩行,1792556607.7642,-18.6,0.915\n';

  // Act
  const columns = parseNumericCsv(csv);
  const parsed = parseJumpSyncOffsets(offsets);

  // Assert
  assert.deepEqual(columns.a, [1, 2]);
  assert.ok(Number.isNaN(columns.b![0]));
  assert.equal(columns.b![1], 3);
  assert.deepEqual(parsed['5m歩行'], { tZeroUnix: 1792556607.7642, rightOffsetMs: -18.6, lrXcorrR: 0.915 });
});

test('ZIP のサイズと SHA-256 だけを書き換え、trials.json の書式を保つ', () => {
  // Arrange
  const text = [
    '{',
    '  "release": { "allArchiveBytes": 1,',
    '    "allArchiveSha256": "" },',
    '  "trials": [',
    '    { "id": "01_a", "metrics": { "speed": [1.30, 1.31] },',
    '      "archiveBytes": 0,',
    '      "archiveSha256": "" },',
    '    { "id": "02_b",',
    '      "archiveBytes": 0,',
    '      "archiveSha256": "" }',
    '  ]',
    '}',
  ].join('\n');
  const sha = (c: string) => c.repeat(64);

  // Act
  const updated = updateArchiveInfo(text, { '01_a': { bytes: 10, sha256: sha('a') }, '02_b': { bytes: 20, sha256: sha('b') } }, { bytes: 30, sha256: sha('c') });

  // Assert
  assert.ok(updated.includes('"speed": [1.30, 1.31]'), 'number formatting is preserved');
  const parsed = JSON.parse(updated) as { release: { allArchiveBytes: number; allArchiveSha256: string }; trials: { archiveBytes: number; archiveSha256: string }[] };
  assert.deepEqual(parsed.release, { allArchiveBytes: 30, allArchiveSha256: sha('c') });
  assert.deepEqual(parsed.trials.map((t) => [t.archiveBytes, t.archiveSha256]), [[10, sha('a')], [20, sha('b')]]);
  assert.throws(() => updateArchiveInfo(text, { '03_missing': { bytes: 1, sha256: sha('d') } }, { bytes: 1, sha256: sha('e') }));
});

test('trials.json の試技・ZIP・指標がそろっている', () => {
  // Arrange
  const manifest = readManifest(ROOT);

  // Act
  const ids = manifest.trials.map((t) => t.id);

  // Assert
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.deepEqual(ids.map((id) => id.slice(0, 2)), ids.map((_, i) => String(i + 1).padStart(2, '0')), 'ids are numbered in order');
  assert.match(manifest.release.allArchiveSha256, /^[0-9a-f]{64}$/);
  assert.ok(manifest.release.allArchiveBytes > 0);
  for (const trial of manifest.trials) {
    assert.equal(trial.archive, `orphe-insole-sample-${trial.id}.zip`, `${trial.id}: archive name`);
    assert.ok(trial.archiveBytes > 0, `${trial.id}: archiveBytes`);
    assert.match(trial.archiveSha256, /^[0-9a-f]{64}$/, `${trial.id}: archiveSha256`);
    assert.deepEqual(Object.keys(trial.metrics).sort(), [...METRIC_KEYS].sort(), `${trial.id}: metrics`);
    for (const [key, pair] of Object.entries(trial.metrics)) {
      assert.ok(pair.length === 2 && pair.every(Number.isFinite), `${trial.id}: ${key}`);
    }
    assert.equal(trial.affectedSide, trial.group === 'unilateral' ? 'left' : null, `${trial.id}: affectedSide`);
    assert.ok(trial.source.video.startsWith('mosaic/'), `${trial.id}: only mosaicked videos are published`);
    assert.ok(trial.source.poster.startsWith('mosaic/'), `${trial.id}: only mosaicked posters are published`);
  }
});

test('ページの ZIP リンク・サイズ・試技名が trials.json と一致する', () => {
  // Arrange
  const manifest = readManifest(ROOT);
  const base = `https://github.com/${manifest.release.repository}/releases/download/${manifest.release.tag}/`;
  const megabytes = (bytes: number) => (bytes / 1e6).toFixed(1);
  const { outputs, pageTranslations } = buildLandingPages();
  const sampleTranslations = pageTranslations['sample-data/index.html']!;

  // Act
  const pages = ['sample-data/index.html', 'en/sample-data/index.html'].map((file) => outputs[file] ?? '');
  const landings = ['index.html', 'en/index.html'].map((file) => outputs[file] ?? '');

  // Assert
  const allLink = `href="${base}${manifest.release.allArchive}"`;
  const allSize = `ZIP · ${megabytes(manifest.release.allArchiveBytes)} MB</span>`;
  for (const html of [...pages, ...landings]) {
    assert.ok(html.includes(allLink), 'link to the full archive');
    assert.ok(html.includes(allSize), `full archive size ${allSize}`);
  }
  for (const html of pages) {
    for (const trial of manifest.trials) {
      const card = new RegExp(`href="${(base + trial.archive).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}">ZIP<span class="meta">([\\d.]+) MB</span>`);
      assert.equal(html.match(card)?.[1], megabytes(trial.archiveBytes), `${trial.id}: card ZIP size`);
      assert.ok(html.includes(`id="trial-${trial.id}"`), `${trial.id}: notes`);
      assert.ok(html.includes(`· ${trial.durationS.toFixed(1)} s</span>`), `${trial.id}: duration`);
    }
  }
  for (const trial of manifest.trials) {
    const key = `t${trial.id.slice(0, 2)}Name`;
    assert.equal(sampleTranslations.ja[key], trial.name.ja, `${trial.id}: ja name`);
    assert.equal(sampleTranslations.en[key], trial.name.en, `${trial.id}: en name`);
  }
});

test('README.dataset.md に左右と動画の時刻合わせの式がある', () => {
  // Arrange
  const readme = read('sample-data/README.dataset.md');

  // Act
  const formulas = ['timestamp − tZeroUnix', 'timestamp − rightOffsetMs / 1000 − tZeroUnix', 't + (tZeroUnix − videoStartUnix) + videoOffsetS'];

  // Assert
  for (const formula of formulas) assert.ok(readme.includes(formula), formula);
});
