#!/usr/bin/env node

/**
 * ORPHE INSOLE サンプルデータの梱包と、紹介ページ（sample-data/）用ファイルの生成
 *
 *   node scripts/sample-data.mjs pack <元データのディレクトリ>  # Release に載せる ZIP を .sample-data/release/ に作る
 *   node scripts/sample-data.mjs site [<データセットのディレクトリ>]  # sample-data/files/ を生成する
 *   node scripts/sample-data.mjs fetch                            # Release から ZIP を取得して site を実行する（CI 用）
 *
 * ## 置き場所
 *
 * 動画を含むデータは重いので git には入れず、GitHub Releases（`sample-data/trials.json` の
 * `release.tag`）に置く。リポジトリにあるのは試技の一覧（trials.json）とページだけで、
 * ページが使う動画・ポスター・波形 JSON（sample-data/files/）は Pages のビルド時に
 * Release から取得して生成する（.github/workflows/pages.yml）。Release の URL を
 * `<video>` や fetch() から直接使うと、CORS とリダイレクト先の有効期限で不安定になるため。
 *
 * ## 時刻の合わせ方
 *
 * 左右のインソールと動画は別々の時計で記録されている。各試技の冒頭に両脚ジャンプがあり、
 *
 * - 左右: 着地衝撃の相互相関で求めた `right_offset_ms`（元データの jump_sync_offsets.csv）で右足を補正する。
 *   左足 t = timestamp − t_zero、右足 t = timestamp − offset − t_zero（t = 0 は左足のジャンプ着地）
 * - 動画: ARKit 骨格の root（腰）の上下動からジャンプ着地のフレームを探し、センサーの着地との差を
 *   `videoOffsetS` とする（{@link estimateVideoOffset}）。動画の時刻 = t + (t_zero − 動画の開始時刻) + videoOffsetS
 *
 * 公開する動画は顔にモザイクを掛けた `mosaic/` のものだけ。元動画は梱包しない。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_FILE = 'sample-data/trials.json';
export const DATASET_README_FILE = 'sample-data/README.dataset.md';
export const SITE_FILES_DIR = 'sample-data/files';
const WORK_DIR = '.sample-data';
/** Release からの ZIP 取得の上限 [ms]。約 50 MB なので通常は数秒で終わる */
const RELEASE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const SENSOR_FILES = ['sensor-left.csv', 'sensor-right.csv'];
const GAIT_FILES = ['gait_analysis_left_detailed.csv', 'gait_analysis_right_detailed.csv'];
const LANDMARKS_FILE = 'landmarks.json';
const VIDEO_FILE = 'video.mp4';
const POSTER_FILE = 'poster.jpg';
const TRIAL_META_FILE = 'trial.json';
const DATA_FILE = 'data.json';

/** センサーのジャンプ着地から見て、動画側の着地を探す範囲 [s]。動画はセンサーより 0.3 s 前後遅れる */
const VIDEO_SEARCH_BEFORE_S = 0.2;
const VIDEO_SEARCH_AFTER_S = 0.8;
/** ジャンプ頂点のあと、着地で沈み込みきるまでを探す範囲 [s] */
const VIDEO_LANDING_WINDOW_S = 0.5;
/** ARKit の追跡が途切れたとみなすフレーム間隔 [s]（30 fps の 2 フレーム分強） */
const MAX_FRAME_GAP_S = 0.07;
/** 頂点から沈み込みまでの落差がこれ未満なら、ジャンプを捉えられていない（立位の揺れ）とみなす [m] */
const MIN_JUMP_DROP_M = 0.08;

/** 圧力は約 9 N 未満が 0 になるので、合計が 0 を超えたら接地とみなす */
const CONTACT_THRESHOLD_N = 0;
const MIN_CONTACT_S = 0.04;
const MIN_SWING_S = 0.06;
/** ジャンプ着地（t = 0）直後の立位をストライドに含めない */
const STRIDE_MIN_START_S = 0.5;
/** ストライド時間の中央値から外れたストライド（歩き始め・止まり際など）を除く */
const STRIDE_DURATION_TOLERANCE = 0.25;
const MAX_STANCE_FRACTION = 0.95;
const STRIDE_POINTS = 101;

const DIGITS = { t: 4, acc: 3, gyro: 1, press: 1 };

// ---------------------------------------------------------------------------
// 純粋関数（tests/sample-data.test.ts が利用）
// ---------------------------------------------------------------------------

/** 数値だけの CSV を列名 → 数値配列にする（`nan` は NaN）。 */
export function parseNumericCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const header = (lines[0] ?? '').split(',');
  const columns = Object.fromEntries(header.map((name) => [name, []]));
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    header.forEach((name, i) => columns[name].push(Number(cells[i])));
  }
  return columns;
}

/** `jump_sync_offsets.csv`（condition,t_zero_unix,right_offset_ms,xcorr_r）を condition → 値にする。 */
export function parseJumpSyncOffsets(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const result = {};
  for (const line of lines.slice(1)) {
    const [condition, tZero, rightOffset, xcorr] = line.split(',');
    result[condition] = { tZeroUnix: Number(tZero), rightOffsetMs: Number(rightOffset), lrXcorrR: Number(xcorr) };
  }
  return result;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 動画のジャンプ着地を、ARKit 骨格の root（腰）の高さから推定し、センサーの着地との差 [s] を返す。
 *
 * 頂点（root の y が最大）から沈み込みきる（最小）までの間で、上下方向の加速度（y の 2 階差分）が
 * 最大になるフレームを着地とする。頂点〜沈み込みの間でフレームが欠けている（追跡が途切れた）場合や、
 * 頂点からの落差が小さい（ジャンプを捉えていない）場合は null。
 *
 * @param {{ t: number, y: number }[]} frames  t は動画の開始からの秒、y は root の高さ [m]
 * @param {number} sensorLandingS  センサーのジャンプ着地（動画の開始からの秒）
 * @returns {number | null}  正なら動画がセンサーより遅れている
 */
export function estimateVideoOffset(frames, sensorLandingS) {
  const window = frames.filter((f) => f.t >= sensorLandingS - VIDEO_SEARCH_BEFORE_S && f.t <= sensorLandingS + VIDEO_SEARCH_AFTER_S);
  if (window.length < 5) return null;
  let apex = 0;
  for (let i = 1; i < window.length; i += 1) if (window[i].y > window[apex].y) apex = i;
  let bottom = apex;
  for (let i = apex + 1; i < window.length && window[i].t - window[apex].t <= VIDEO_LANDING_WINDOW_S; i += 1) {
    if (window[i].y < window[bottom].y) bottom = i;
  }
  if (window[apex].y - window[bottom].y < MIN_JUMP_DROP_M) return null;
  for (let i = Math.max(apex, 1); i <= Math.min(bottom + 1, window.length - 1); i += 1) {
    if (window[i].t - window[i - 1].t > MAX_FRAME_GAP_S) return null;
  }
  let landing = -1;
  let maxAcceleration = -Infinity;
  for (let i = apex + 1; i < bottom; i += 1) {
    const [a, b, c] = [window[i - 1], window[i], window[i + 1]];
    const acceleration = ((c.y - b.y) / (c.t - b.t) - (b.y - a.y) / (b.t - a.t)) / ((c.t - a.t) / 2);
    if (acceleration > maxAcceleration) {
      maxAcceleration = acceleration;
      landing = i;
    }
  }
  return landing < 0 ? null : window[landing].t - sensorLandingS;
}

/**
 * 圧力合計から接地区間を検出する。短い途切れ（MIN_SWING_S 未満）はつなぎ、短い接地（MIN_CONTACT_S 未満）は捨てる。
 * @returns {{ ic: number, to: number }[]}  ic = 接地、to = 離地（いずれも t [s]）
 */
export function detectContacts(t, total) {
  const segments = [];
  let start = -1;
  for (let i = 0; i <= total.length; i += 1) {
    const on = i < total.length && total[i] > CONTACT_THRESHOLD_N;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      segments.push({ ic: t[start], to: t[i - 1] });
      start = -1;
    }
  }
  const merged = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && segment.ic - last.to < MIN_SWING_S) last.to = segment.to;
    else merged.push({ ...segment });
  }
  return merged.filter((segment) => segment.to - segment.ic >= MIN_CONTACT_S);
}

/** 接地〜次の接地を 1 ストライドとし、歩き始め・止まり際など定常でないものを除く。 */
export function selectStrides(contacts) {
  const strides = [];
  for (let k = 0; k + 1 < contacts.length; k += 1) {
    const { ic, to } = contacts[k];
    const end = contacts[k + 1].ic;
    if (ic >= STRIDE_MIN_START_S) strides.push({ start: ic, toeOff: to, end });
  }
  const typical = median(strides.map((s) => s.end - s.start));
  return strides.filter((s) => {
    const duration = s.end - s.start;
    return Math.abs(duration - typical) <= STRIDE_DURATION_TOLERANCE * typical
      && (s.toeOff - s.start) / duration < MAX_STANCE_FRACTION;
  });
}

/** 単調増加の t 上で value を線形補間する。 */
function interpolate(t, values, at, hint) {
  let i = hint;
  while (i + 1 < t.length && t[i + 1] < at) i += 1;
  if (i + 1 >= t.length) return { value: values[t.length - 1], index: i };
  const span = t[i + 1] - t[i];
  const ratio = span > 0 ? (at - t[i]) / span : 0;
  return { value: values[i] + (values[i + 1] - values[i]) * Math.min(Math.max(ratio, 0), 1), index: i };
}

function lowerBound(t, at) {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(lo - 1, 0);
}

/** 1 ストライドを 0〜100%（STRIDE_POINTS 点）に正規化する。 */
export function normalizeStride(t, values, stride) {
  const out = new Array(STRIDE_POINTS);
  let hint = lowerBound(t, stride.start);
  for (let p = 0; p < STRIDE_POINTS; p += 1) {
    const at = stride.start + ((stride.end - stride.start) * p) / (STRIDE_POINTS - 1);
    const { value, index } = interpolate(t, values, at, hint);
    out[p] = value;
    hint = index;
  }
  return out;
}

/** 系列ごとの平均と標本標準偏差（n = 1 のときは 0）。 */
export function meanAndSd(series) {
  const n = series.length;
  const mean = new Array(STRIDE_POINTS).fill(0);
  const sd = new Array(STRIDE_POINTS).fill(0);
  for (let p = 0; p < STRIDE_POINTS; p += 1) {
    for (const s of series) mean[p] += s[p] / n;
    if (n > 1) {
      let sum = 0;
      for (const s of series) sum += (s[p] - mean[p]) ** 2;
      sd[p] = Math.sqrt(sum / (n - 1));
    }
  }
  return { mean, sd };
}

function round(values, digits) {
  const scale = 10 ** digits;
  return values.map((v) => (Number.isFinite(v) ? Math.round(v * scale) / scale : null));
}

/** センサー CSV の列を、ジャンプ着地を 0 とした時刻と各チャンネルにする。 */
export function toFootSeries(columns, tZeroUnix) {
  const t = columns.timestamp.map((ts) => ts - tZeroUnix);
  const acc = ['accX', 'accY', 'accZ'].map((name) => columns[name]);
  const gyro = ['gyroX', 'gyroY', 'gyroZ'].map((name) => columns[name]);
  const press = [1, 2, 3, 4, 5, 6].map((ch) => columns[`press${ch}`]);
  const total = t.map((_, i) => press.reduce((sum, ch) => sum + ch[i], 0));
  return { t, acc, gyro, press, total };
}

function strideAverageOf(foot, strides) {
  if (strides.length === 0) return null;
  const channel = (values) => meanAndSd(strides.map((s) => normalizeStride(foot.t, values, s)));
  const group = (list) => list.map(channel);
  const acc = group(foot.acc);
  const gyro = group(foot.gyro);
  const press = group(foot.press);
  const total = channel(foot.total);
  const pick = (stats, key) => stats.map((s) => round(s[key], 2));
  return {
    n: strides.length,
    toeOffPct: Math.round(median(strides.map((s) => (100 * (s.toeOff - s.start)) / (s.end - s.start))) * 10) / 10,
    mean: { acc: pick(acc, 'mean'), gyro: pick(gyro, 'mean'), press: pick(press, 'mean'), total: round(total.mean, 2) },
    sd: { acc: pick(acc, 'sd'), gyro: pick(gyro, 'sd'), press: pick(press, 'sd'), total: round(total.sd, 2) },
  };
}

/**
 * ビューア用の波形 JSON を作る。
 * @param {object} trial  trials.json の試技
 * @param {object} meta  データセット内の trial.json
 * @param {{ left: string, right: string }} sensorCsv
 */
export function buildTrialData(trial, meta, sensorCsv) {
  const { tZeroUnix, rightOffsetMs, videoStartUnix, videoOffsetS } = meta.sync;
  const feet = {
    left: toFootSeries(parseNumericCsv(sensorCsv.left), tZeroUnix),
    right: toFootSeries(parseNumericCsv(sensorCsv.right), tZeroUnix + rightOffsetMs / 1000),
  };
  const contacts = {};
  const strideAverage = {};
  const out = {};
  for (const [side, foot] of Object.entries(feet)) {
    contacts[side] = detectContacts(foot.t, foot.total);
    strideAverage[side] = trial.strideAverage ? strideAverageOf(foot, selectStrides(contacts[side])) : null;
    out[side] = {
      t: round(foot.t, DIGITS.t),
      acc: foot.acc.map((v) => round(v, DIGITS.acc)),
      gyro: foot.gyro.map((v) => round(v, DIGITS.gyro)),
      press: foot.press.map((v) => round(v, DIGITS.press)),
    };
    contacts[side] = contacts[side].map(({ ic, to }) => [Math.round(ic * 1000) / 1000, Math.round(to * 1000) / 1000]);
  }
  return {
    id: trial.id,
    videoTimeAtZeroS: Math.round((tZeroUnix - videoStartUnix + videoOffsetS) * 1000) / 1000,
    sync: { rightOffsetMs, videoOffsetS, videoOffsetMethod: meta.sync.videoOffsetMethod },
    feet: out,
    contacts,
    strideAverage: trial.strideAverage ? strideAverage : null,
  };
}

// ---------------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------------

export function readManifest(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8'));
}

function releaseDir() {
  return path.join(ROOT, WORK_DIR, 'release');
}

function defaultDatasetRoot(manifest) {
  return path.join(ROOT, WORK_DIR, 'dataset', manifest.release.datasetDir);
}

function copy(from, to) {
  if (!fs.existsSync(from)) throw new Error(`missing source file: ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function landmarkRootFrames(landmarks) {
  const start = landmarks.metadata.recordingDate;
  return landmarks.frames
    .filter((frame) => frame.joints && frame.joints.root)
    .map((frame) => ({ t: frame.timestamp - start, y: frame.joints.root.y }));
}

function trialsCsv(manifest, metas) {
  const header = 'id,name_ja,name_en,group,affected_side,duration_s,t_zero_unix,right_offset_ms,lr_xcorr_r,video_start_unix,video_offset_s,video_offset_method';
  const rows = manifest.trials.map((trial) => {
    const { sync } = metas[trial.id];
    return [trial.id, trial.name.ja, trial.name.en, trial.group, trial.affectedSide ?? '', trial.durationS,
      sync.tZeroUnix, sync.rightOffsetMs, sync.lrXcorrR, sync.videoStartUnix, sync.videoOffsetS, sync.videoOffsetMethod]
      .map((cell) => (/[",]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell)))
      .join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

/**
 * trials.json の書式を崩さずに ZIP のサイズと SHA-256 だけ書き換える。
 * @param {Record<string, { bytes: number, sha256: string }>} archives  試技 id → ZIP の情報
 * @param {{ bytes: number, sha256: string }} all  一括 ZIP の情報
 */
export function updateArchiveInfo(manifestText, archives, all) {
  let text = manifestText
    .replace(/("allArchiveBytes": )\d+/, `$1${all.bytes}`)
    .replace(/("allArchiveSha256": )"[0-9a-f]*"/, `$1"${all.sha256}"`);
  for (const [id, { bytes, sha256 }] of Object.entries(archives)) {
    const re = new RegExp(`("id": "${id}"[\\s\\S]*?"archiveBytes": )\\d+(,\\s*"archiveSha256": )"[0-9a-f]*"`);
    if (!re.test(text)) throw new Error(`archiveBytes / archiveSha256 not found for ${id}`);
    text = text.replace(re, `$1${bytes}$2"${sha256}"`);
  }
  return text;
}

export function sha256Of(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function archiveInfo(file) {
  return { bytes: fs.statSync(file).size, sha256: sha256Of(file) };
}

function zip(cwd, archive, entry) {
  fs.rmSync(archive, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', archive, entry, '-x', '*.DS_Store'], { cwd, stdio: 'inherit' });
}

function pack(sourceDir) {
  const manifest = readManifest();
  const datasetRoot = defaultDatasetRoot(manifest);
  const outDir = releaseDir();
  fs.rmSync(path.dirname(datasetRoot), { recursive: true, force: true });
  fs.mkdirSync(datasetRoot, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const offsets = parseJumpSyncOffsets(fs.readFileSync(path.join(sourceDir, 'jump_sync_offsets.csv'), 'utf8'));
  const readme = fs.readFileSync(path.join(ROOT, DATASET_README_FILE), 'utf8');
  const metas = {};
  for (const trial of manifest.trials) {
    const from = path.join(sourceDir, trial.source.dir);
    const to = path.join(datasetRoot, trial.id);
    for (const file of [...SENSOR_FILES, ...GAIT_FILES, LANDMARKS_FILE]) copy(path.join(from, file), path.join(to, file));
    copy(path.join(sourceDir, trial.source.video), path.join(to, VIDEO_FILE));
    copy(path.join(sourceDir, trial.source.poster), path.join(to, POSTER_FILE));
    fs.writeFileSync(path.join(to, 'README.md'), readme);

    const sync = offsets[trial.source.syncCondition];
    if (!sync) throw new Error(`${trial.id}: ${trial.source.syncCondition} is not in jump_sync_offsets.csv`);
    const landmarks = JSON.parse(fs.readFileSync(path.join(from, LANDMARKS_FILE), 'utf8'));
    const videoStartUnix = landmarks.metadata.recordingDate;
    const videoOffsetS = estimateVideoOffset(landmarkRootFrames(landmarks), sync.tZeroUnix - videoStartUnix);
    metas[trial.id] = {
      id: trial.id,
      name: trial.name,
      group: trial.group,
      affectedSide: trial.affectedSide,
      recordedOn: manifest.recordedOn,
      samplingHz: manifest.samplingHz,
      durationS: trial.durationS,
      sync: { ...sync, videoStartUnix, videoOffsetS, videoOffsetMethod: videoOffsetS === null ? null : 'jump' },
    };
  }

  // ジャンプ中に ARKit の追跡が途切れた試技は、ほかの試技の中央値で補う
  const estimated = Object.values(metas).map((m) => m.sync.videoOffsetS).filter((v) => v !== null);
  const fallback = Math.round(median(estimated) * 1000) / 1000;
  for (const meta of Object.values(metas)) {
    if (meta.sync.videoOffsetS === null) {
      meta.sync.videoOffsetS = fallback;
      meta.sync.videoOffsetMethod = 'median';
    } else {
      meta.sync.videoOffsetS = Math.round(meta.sync.videoOffsetS * 1000) / 1000;
    }
    fs.writeFileSync(path.join(datasetRoot, meta.id, TRIAL_META_FILE), JSON.stringify(meta, null, 2) + '\n');
    console.log(`[sample-data] ${meta.id}: video offset ${meta.sync.videoOffsetS.toFixed(3)} s (${meta.sync.videoOffsetMethod})`);
  }
  fs.writeFileSync(path.join(datasetRoot, 'README.md'), readme);
  fs.writeFileSync(path.join(datasetRoot, 'trials.csv'), trialsCsv(manifest, metas));

  const archives = {};
  for (const trial of manifest.trials) {
    const archive = path.join(outDir, trial.archive);
    zip(datasetRoot, archive, trial.id);
    archives[trial.id] = archiveInfo(archive);
  }
  const allArchive = path.join(outDir, manifest.release.allArchive);
  zip(path.dirname(datasetRoot), allArchive, manifest.release.datasetDir);
  const all = archiveInfo(allArchive);
  const sums = [[manifest.release.allArchive, all.sha256], ...manifest.trials.map((t) => [t.archive, archives[t.id].sha256])];
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), sums.map(([file, sha256]) => `${sha256}  ${file}`).join('\n') + '\n');
  const manifestPath = path.join(ROOT, MANIFEST_FILE);
  fs.writeFileSync(manifestPath, updateArchiveInfo(fs.readFileSync(manifestPath, 'utf8'), archives, all));
  console.log(`[sample-data] wrote ${manifest.trials.length + 1} archives and SHA256SUMS.txt to ${path.relative(ROOT, outDir)}/ and updated ${MANIFEST_FILE}`);
}

function site(datasetRoot) {
  const manifest = readManifest();
  const root = datasetRoot ? path.resolve(datasetRoot) : defaultDatasetRoot(manifest);
  const outRoot = path.join(ROOT, SITE_FILES_DIR);
  fs.rmSync(outRoot, { recursive: true, force: true });
  for (const trial of manifest.trials) {
    const from = path.join(root, trial.id);
    const to = path.join(outRoot, trial.id);
    const meta = JSON.parse(fs.readFileSync(path.join(from, TRIAL_META_FILE), 'utf8'));
    const data = buildTrialData(trial, meta, {
      left: fs.readFileSync(path.join(from, SENSOR_FILES[0]), 'utf8'),
      right: fs.readFileSync(path.join(from, SENSOR_FILES[1]), 'utf8'),
    });
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, DATA_FILE), JSON.stringify(data));
    copy(path.join(from, VIDEO_FILE), path.join(to, VIDEO_FILE));
    copy(path.join(from, POSTER_FILE), path.join(to, POSTER_FILE));
    const kb = Math.round(fs.statSync(path.join(to, DATA_FILE)).size / 1024);
    const strides = data.strideAverage ? `strides L${data.strideAverage.left?.n ?? 0} / R${data.strideAverage.right?.n ?? 0}` : 'no stride average';
    console.log(`[sample-data] ${trial.id}: ${DATA_FILE} ${kb} KB, ${strides}`);
  }
  console.log(`[sample-data] wrote ${path.relative(ROOT, outRoot)}/`);
}

function fetchRelease() {
  const manifest = readManifest();
  const { repository, tag, allArchive, allArchiveSha256 } = manifest.release;
  const outDir = releaseDir();
  const datasetParent = path.dirname(defaultDatasetRoot(manifest));
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync('gh', ['release', 'download', tag, '--repo', repository, '--pattern', allArchive, '--dir', outDir, '--clobber'], { stdio: 'inherit', timeout: RELEASE_DOWNLOAD_TIMEOUT_MS });
  // Release の ZIP はコミットなしで差し替えられるので、trials.json に記録した値と照合してから使う
  const actual = sha256Of(path.join(outDir, allArchive));
  if (actual !== allArchiveSha256) {
    throw new Error(`${allArchive}: SHA-256 mismatch (expected ${allArchiveSha256}, got ${actual}). Re-run pack and update ${MANIFEST_FILE}, or check the release assets.`);
  }
  fs.rmSync(datasetParent, { recursive: true, force: true });
  fs.mkdirSync(datasetParent, { recursive: true });
  execFileSync('unzip', ['-q', '-o', path.join(outDir, allArchive), '-d', datasetParent], { stdio: 'inherit' });
  site();
}

function main([command, arg]) {
  if (command === 'pack' && arg) return pack(path.resolve(arg));
  if (command === 'site') return site(arg);
  if (command === 'fetch') return fetchRelease();
  console.error('usage: node scripts/sample-data.mjs pack <source-dir> | site [<dataset-dir>] | fetch');
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
