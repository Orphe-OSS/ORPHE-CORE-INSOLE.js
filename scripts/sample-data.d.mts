/** scripts/sample-data.mjs の型定義（tests/sample-data.test.ts から参照する） */

export type TrialGroup = 'normal' | 'bilateral' | 'unilateral' | 'running';
export type FootSide = 'left' | 'right';
export type MetricPair = [number, number];

export interface SampleTrial {
  id: string;
  name: { ja: string; en: string };
  group: TrialGroup;
  affectedSide: FootSide | null;
  strideAverage: boolean;
  highlights: { key: string; start: number; end: number }[];
  source: { dir: string; syncCondition: string; video: string; poster: string };
  durationS: number;
  archive: string;
  archiveBytes: number;
  archiveSha256: string;
  metricsNote?: string;
  metrics: Record<string, MetricPair>;
}

export interface SampleManifest {
  release: {
    repository: string;
    tag: string;
    datasetDir: string;
    allArchive: string;
    allArchiveBytes: number;
    allArchiveSha256: string;
  };
  recordedOn: string;
  samplingHz: number;
  trials: SampleTrial[];
}

export interface TrialSync {
  tZeroUnix: number;
  rightOffsetMs: number;
  lrXcorrR?: number;
  videoStartUnix: number;
  videoOffsetS: number;
  videoOffsetMethod: 'jump' | 'median' | null;
}

export interface TrialMeta {
  id: string;
  sync: TrialSync;
}

export interface Contact {
  ic: number;
  to: number;
}

export interface Stride {
  start: number;
  toeOff: number;
  end: number;
}

export interface StrideStats {
  n: number;
  toeOffPct: number;
  mean: { acc: number[][]; gyro: number[][]; press: number[][]; total: number[] };
  sd: { acc: number[][]; gyro: number[][]; press: number[][]; total: number[] };
}

export interface FootData {
  t: (number | null)[];
  acc: (number | null)[][];
  gyro: (number | null)[][];
  press: (number | null)[][];
}

export interface TrialData {
  id: string;
  videoTimeAtZeroS: number;
  sync: { rightOffsetMs: number; videoOffsetS: number; videoOffsetMethod: TrialSync['videoOffsetMethod'] };
  feet: Record<FootSide, FootData>;
  contacts: Record<FootSide, [number, number][]>;
  strideAverage: Record<FootSide, StrideStats | null> | null;
}

export const MANIFEST_FILE: string;
export const DATASET_README_FILE: string;
export const SITE_FILES_DIR: string;
export function parseNumericCsv(text: string): Record<string, number[]>;
export function parseJumpSyncOffsets(text: string): Record<string, { tZeroUnix: number; rightOffsetMs: number; lrXcorrR: number }>;
export function median(values: number[]): number;
export function estimateVideoOffset(frames: { t: number; y: number }[], sensorLandingS: number): number | null;
export function detectContacts(t: number[], total: number[]): Contact[];
export function selectStrides(contacts: Contact[]): Stride[];
export function normalizeStride(t: number[], values: number[], stride: Stride): number[];
export function meanAndSd(series: number[][]): { mean: number[]; sd: number[] };
export function toFootSeries(columns: Record<string, number[]>, tZeroUnix: number): {
  t: number[];
  acc: number[][];
  gyro: number[][];
  press: number[][];
  total: number[];
};
export function buildTrialData(trial: Pick<SampleTrial, 'id' | 'strideAverage'>, meta: TrialMeta, sensorCsv: { left: string; right: string }): TrialData;
export function readManifest(root?: string): SampleManifest;
export function updateArchiveInfo(
  manifestText: string,
  archives: Record<string, { bytes: number; sha256: string }>,
  all: { bytes: number; sha256: string },
): string;
export function sha256Of(file: string): string;
