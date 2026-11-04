/**
 * サンプルデータのビューア（sample-data/index.html と、生成した en/sample-data/index.html から読み込む）
 *
 * 動画（顔にモザイク処理済み）と、左右インソールの波形（files/<id>/data.json。scripts/sample-data.mjs が生成）を
 * 同じ時刻で表示する。t = 0 は左足のジャンプ着地で、動画の再生位置 = t + data.videoTimeAtZeroS。
 * 試技の一覧と指標の表は trials.json から作る。外部ライブラリは使わず canvas と SVG に直接描く。
 *
 * 使い方: OrpheSampleViewer.init({ lang, strings })  strings はページの translations[lang]
 */
(() => {
  'use strict';

  const BASE_URL = new URL('.', document.currentScript.src);
  const FETCH_TIMEOUT_MS = 20000;
  const WINDOW_S = 4;
  const FRAME_S = 1 / 30;
  const COP_TRAIL_S = 0.4;
  const PRESSURE_COLOR_MAX_N = 80;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const COLORS = {
    axes: ['#2f6fd6', '#f2643a', '#18a37a'],
    press: ['#2f6fd6', '#f2643a', '#18a37a', '#8e5bd8', '#d99a00', '#d63f8c'],
    total: '#151719',
    grid: '#e6ebef',
    zero: '#c9d2da',
    text: '#59636f',
    cursor: '#151719',
    window: 'rgba(69, 230, 230, 0.22)',
    highlight: 'rgba(16, 20, 23, 0.07)',
    toeOff: '#8a96a1',
  };
  const FONT = '11px Roboto, Arial, sans-serif';
  const FONT_BOLD = '700 11px Roboto, Arial, sans-serif';

  /** 圧力センサーの位置（左足を上から見た 100 × 280 の座標。右足は左右反転）。ORPHE-INSOLE.js の配置図から読み取った値 */
  const SENSOR_POSITIONS = [[73.8, 49.2], [75.3, 93.3], [33.8, 62.1], [48.4, 100.5], [19.3, 108.1], [57.8, 236.9]];
  const INSOLE_PATH = 'M58 0C80 0 96 18 98 48C100 70 100 88 98 104C95 124 88 140 88 160C88 182 92 205 91 228C90 258 74 280 53 280C32 280 16 262 15 232C14 205 10 180 7 155C3 128 0 108 1 88C2 60 10 30 26 14C36 5 46 0 58 0Z';

  const METRIC_GROUPS = {
    temporal: ['strideTime', 'stance', 'swingTime', 'strideLength', 'speed'],
    foot: ['strikeAngle', 'toeOffAngle', 'footHeight', 'swingWidth', 'footAngle'],
    event: ['icAccZ', 'toeOffGyroX', 'swingVelY'],
  };
  const METRIC_DIGITS = { strideTime: 2, swingTime: 2, strideLength: 2, speed: 2, swingVelY: 1 };
  const SIGNED_METRICS = new Set(['strikeAngle', 'footAngle']);
  const GROUP_TAG_KEYS = { normal: 'groupNormalTag', bilateral: 'groupBilateralTag', unilateral: 'groupUnilateralTag', running: 'groupRunningTag' };
  const FEET = ['left', 'right'];

  let S = {};
  let manifest = null;
  let current = null;
  let data = null;
  let ranges = null;
  let t = 0;
  let activeTab = 'sync';
  let compareGroup = 'temporal';
  let loadController = null;
  let animationFrame = 0;
  let overviewCache = null;
  const el = {};

  // ---------------------------------------------------------------------------
  // 小物
  // ---------------------------------------------------------------------------

  function format(template, values) {
    return template.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? values[key] : whole));
  }

  function metricLabel(key) {
    return S['metric' + key[0].toUpperCase() + key.slice(1)] || key;
  }

  function formatNumber(value, digits, signed) {
    const text = Math.abs(value).toFixed(digits);
    if (value < 0 && Number(text) !== 0) return '−' + text;
    return (signed && value > 0 ? '+' : '') + text;
  }

  function formatMetric(key, value) {
    return formatNumber(value, METRIC_DIGITS[key] || 0, SIGNED_METRICS.has(key));
  }

  function downloadUrl(file) {
    const { repository, tag } = manifest.release;
    return `https://github.com/${repository}/releases/download/${tag}/${file}`;
  }

  function megabytes(bytes) {
    return (bytes / 1e6).toFixed(1) + ' MB';
  }

  function footLabel(foot) {
    const name = foot === 'left' ? S.footLeft : S.footRight;
    if (!current || !current.affectedSide) return name;
    const side = current.affectedSide === foot ? S.affected : S.unaffected;
    return document.documentElement.lang === 'ja' ? `${name}（${side}）` : `${name} (${side})`;
  }

  /** t[i] <= at を満たす最大の i（範囲外は端） */
  function indexAt(times, at) {
    let lo = 0;
    let hi = times.length - 1;
    if (at <= times[0]) return 0;
    if (at >= times[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= at) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  function niceStep(span, count) {
    const raw = span / Math.max(count, 1);
    const power = 10 ** Math.floor(Math.log10(raw));
    const unit = raw / power;
    return (unit >= 5 ? 10 : unit >= 2 ? 5 : unit >= 1 ? 2 : 1) * power;
  }

  /** 着地衝撃などの外れ値で縦軸が潰れないよう、分位点で範囲を決める */
  function robustRange(arrays, low, high, includeZero) {
    const values = [];
    for (const array of arrays) for (let i = 0; i < array.length; i += 2) if (array[i] !== null) values.push(array[i]);
    values.sort((a, b) => a - b);
    let min = values[Math.floor(values.length * low)] ?? 0;
    let max = values[Math.min(values.length - 1, Math.ceil(values.length * high))] ?? 1;
    if (includeZero) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    const pad = (max - min) * 0.08 || 1;
    return [min - pad, max + pad];
  }

  function setupCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(Math.round(rect.width), 1);
    const height = Math.max(Math.round(rect.height), 1);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  // ---------------------------------------------------------------------------
  // グラフ
  // ---------------------------------------------------------------------------

  /**
   * 1 枚のパネルを描く。
   * box: { x, y, w, h }（描画領域）, x0/x1, y0/y1（軸の範囲）
   */
  function drawPanel(ctx, box, options) {
    const { x0, x1, y0, y1 } = options;
    const sx = (v) => box.x + ((v - x0) / (x1 - x0)) * box.w;
    const sy = (v) => box.y + box.h - ((v - y0) / (y1 - y0)) * box.h;

    for (const band of options.bands || []) {
      const a = Math.max(sx(band.start), box.x);
      const b = Math.min(sx(band.end), box.x + box.w);
      if (b <= a) continue;
      ctx.fillStyle = band.color || COLORS.highlight;
      ctx.fillRect(a, box.y, b - a, box.h);
      if (band.label) {
        ctx.fillStyle = COLORS.text;
        ctx.font = FONT;
        ctx.textAlign = 'left';
        ctx.fillText(band.label, a + 4, box.y + 12);
      }
    }

    ctx.font = FONT;
    ctx.lineWidth = 1;
    const yStep = niceStep(y1 - y0, box.h > 120 ? 4 : 3);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(y0 / yStep) * yStep; v <= y1; v += yStep) {
      const y = Math.round(sy(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v) < yStep / 1000 ? COLORS.zero : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(box.x, y);
      ctx.lineTo(box.x + box.w, y);
      ctx.stroke();
      if (options.yLabels !== false) {
        ctx.fillStyle = COLORS.text;
        ctx.fillText(formatNumber(v, yStep < 1 ? 1 : 0, false), box.x - 6, y);
      }
    }
    ctx.textBaseline = 'alphabetic';

    if (options.xTicks) {
      const xStep = options.xStep || niceStep(x1 - x0, 5);
      ctx.textAlign = 'center';
      for (let v = Math.ceil(x0 / xStep) * xStep; v <= x1 + 1e-9; v += xStep) {
        const x = Math.round(sx(v)) + 0.5;
        ctx.strokeStyle = COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(x, box.y);
        ctx.lineTo(x, box.y + box.h);
        ctx.stroke();
        if (options.xLabels) {
          ctx.fillStyle = COLORS.text;
          ctx.fillText(formatNumber(v, xStep < 1 ? 1 : 0, false), x, box.y + box.h + 14);
        }
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    for (const area of options.areas || []) {
      ctx.fillStyle = area.color;
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      area.upper.forEach((v, i) => (i ? ctx.lineTo(sx(area.xs[i]), sy(v)) : ctx.moveTo(sx(area.xs[i]), sy(v))));
      for (let i = area.lower.length - 1; i >= 0; i -= 1) ctx.lineTo(sx(area.xs[i]), sy(area.lower[i]));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    for (const line of options.lines || []) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width || 1.2;
      ctx.beginPath();
      let started = false;
      const from = line.from ?? 0;
      const to = line.to ?? line.ys.length - 1;
      for (let i = from; i <= to; i += 1) {
        const v = line.ys[i];
        if (v === null) {
          started = false;
          continue;
        }
        const x = sx(line.xs[i]);
        const y = sy(v);
        if (started) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
    }
    for (const marker of options.markers || []) {
      const x = Math.round(sx(marker.x)) + 0.5;
      ctx.strokeStyle = marker.color;
      ctx.lineWidth = marker.width || 1;
      ctx.setLineDash(marker.dash || []);
      ctx.beginPath();
      ctx.moveTo(x, box.y);
      ctx.lineTo(x, box.y + box.h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    ctx.strokeStyle = COLORS.zero;
    ctx.lineWidth = 1;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    if (options.title) {
      ctx.fillStyle = COLORS.text;
      ctx.font = FONT_BOLD;
      ctx.textAlign = 'left';
      ctx.fillText(options.title, box.x, box.y - 6);
    }
  }

  /** 狭い画面では右列の縦軸ラベルを省き、列の間隔を詰める */
  function columnLayout(width) {
    return width < 480 ? { left: 36, gap: 10 } : { left: 46, gap: 44 };
  }

  /** 2 列（左足・右足）× rows 行のパネル配置 */
  function grid(width, height, rows, { top = 34, bottom = 26, left = 46, gap = 44, rowGap = 26 } = {}) {
    const columnWidth = (width - left - gap - 8) / 2;
    const rowHeight = (height - top - bottom - rowGap * (rows - 1)) / rows;
    return (row, column) => ({
      x: left + column * (columnWidth + gap),
      y: top + row * (rowHeight + rowGap),
      w: columnWidth,
      h: rowHeight,
    });
  }

  function highlightBands() {
    return (current.highlights || []).map((h) => ({ start: h.start, end: h.end, label: S[`highlight${h.key[0].toUpperCase()}${h.key.slice(1)}`] }));
  }

  function drawSync() {
    const { ctx, width, height } = setupCanvas(el.chartSync);
    if (!data) return;
    const x0 = t - WINDOW_S / 2;
    const x1 = t + WINDOW_S / 2;
    const box = grid(width, height, 3, columnLayout(width));
    const rows = [
      { key: 'acc', title: S.chartAcc, colors: COLORS.axes, range: ranges.acc },
      { key: 'gyro', title: S.chartGyro, colors: COLORS.axes, range: ranges.gyro },
      { key: 'press', title: S.chartPress, colors: COLORS.press, range: ranges.press, total: true },
    ];
    const bands = highlightBands();
    FEET.forEach((foot, column) => {
      const series = data.feet[foot];
      const from = Math.max(indexAt(series.t, x0) - 1, 0);
      const to = Math.min(indexAt(series.t, x1) + 1, series.t.length - 1);
      ctx.fillStyle = COLORS.total;
      ctx.font = '700 13px Roboto, Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(footLabel(foot), box(0, column).x, 14);
      rows.forEach((row, r) => {
        const lines = series[row.key].map((ys, i) => ({ xs: series.t, ys, color: row.colors[i], from, to }));
        if (row.total) lines.push({ xs: series.t, ys: totals[foot], color: COLORS.total, width: 1.8, from, to });
        drawPanel(ctx, box(r, column), {
          x0, x1, y0: row.range[0], y1: row.range[1],
          title: row.title,
          lines,
          bands: r === 0 ? bands : bands.map((b) => ({ ...b, label: '' })),
          xTicks: true,
          xStep: 1,
          xLabels: r === rows.length - 1,
          yLabels: column === 0 || width >= 480,
          markers: [{ x: t, color: COLORS.cursor, width: 1.5 }],
        });
      });
    });
    ctx.fillStyle = COLORS.text;
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.fillText(S.chartTime, width - 8, height - 2);
  }

  let totals = null;

  function overviewLayout(width, height) {
    const left = 46;
    const laneGap = 22;
    const top = 22;
    const laneHeight = (height - top - 22 - laneGap) / 2;
    return FEET.map((foot, i) => ({ x: left, y: top + i * (laneHeight + laneGap), w: width - left - 8, h: laneHeight }));
  }

  function drawOverview() {
    const { ctx, width, height } = setupCanvas(el.chartOverview);
    if (!data) return;
    const [x0, x1] = ranges.time;
    const lanes = overviewLayout(width, height);
    if (!overviewCache || overviewCache.width !== width || overviewCache.height !== height || overviewCache.id !== current.id) {
      const canvas = document.createElement('canvas');
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const off = canvas.getContext('2d');
      off.setTransform(ratio, 0, 0, ratio, 0, 0);
      off.fillStyle = COLORS.text;
      off.font = FONT_BOLD;
      off.textAlign = 'left';
      off.fillText(S.chartOverview, lanes[0].x, 12);
      FEET.forEach((foot, i) => {
        drawPanel(off, lanes[i], {
          x0, x1, y0: 0, y1: ranges.press[1],
          lines: [{ xs: data.feet[foot].t, ys: totals[foot], color: COLORS.total, width: 1 }],
          bands: highlightBands().map((b) => ({ ...b, label: i === 0 ? b.label : '' })),
          xTicks: true,
          xStep: niceStep(x1 - x0, 8),
          xLabels: i === 1,
          yLabels: false,
        });
        off.fillStyle = COLORS.text;
        off.font = FONT;
        off.textAlign = 'right';
        off.fillText(foot === 'left' ? 'L' : 'R', lanes[i].x - 8, lanes[i].y + lanes[i].h / 2 + 4);
      });
      overviewCache = { canvas, width, height, id: current.id };
    }
    ctx.drawImage(overviewCache.canvas, 0, 0, width, height);
    for (const lane of lanes) {
      const sx = (v) => lane.x + ((v - x0) / (x1 - x0)) * lane.w;
      const a = Math.max(sx(t - WINDOW_S / 2), lane.x);
      const b = Math.min(sx(t + WINDOW_S / 2), lane.x + lane.w);
      ctx.fillStyle = COLORS.window;
      ctx.fillRect(a, lane.y, Math.max(b - a, 1), lane.h);
      ctx.strokeStyle = COLORS.cursor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx(t), lane.y);
      ctx.lineTo(sx(t), lane.y + lane.h);
      ctx.stroke();
    }
  }

  function drawStride() {
    const { ctx, width, height } = setupCanvas(el.chartStride);
    if (!data) return;
    const message = !current.strideAverage ? S.strideNone : !data.strideAverage || FEET.some((f) => !data.strideAverage[f]) ? S.strideEmpty : '';
    if (message) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '14px Roboto, Arial, sans-serif';
      ctx.textAlign = 'center';
      wrapText(ctx, message, width / 2, height / 2 - 20, Math.min(width - 40, 520), 20);
      return;
    }
    const average = data.strideAverage;
    const xs = Array.from({ length: average.left.mean.total.length }, (_, i) => i);
    const range = (key, index) => {
      let min = Infinity;
      let max = -Infinity;
      for (const foot of FEET) {
        const means = index === undefined ? average[foot].mean[key] : [average[foot].mean[key][index]];
        const sds = index === undefined ? average[foot].sd[key] : [average[foot].sd[key][index]];
        const list = key === 'total' ? [average[foot].mean.total] : means;
        const sdList = key === 'total' ? [average[foot].sd.total] : sds;
        list.forEach((series, s) => series.forEach((v, i) => {
          min = Math.min(min, v - sdList[s][i]);
          max = Math.max(max, v + sdList[s][i]);
        }));
      }
      const pad = (max - min) * 0.08 || 1;
      return [Math.min(min - pad, key === 'total' || key === 'press' ? 0 : min - pad), max + pad];
    };
    const rows = [
      { key: 'acc', title: S.chartAcc, colors: COLORS.axes, range: range('acc') },
      { key: 'gyro', title: S.chartGyro, colors: COLORS.axes, range: range('gyro') },
      { key: 'press', title: S.chartPress, colors: COLORS.press, range: range('press') },
      { key: 'total', title: S.chartTotal, colors: [COLORS.total], range: range('total') },
    ];
    const box = grid(width, height, rows.length, { ...columnLayout(width), bottom: 34 });
    FEET.forEach((foot, column) => {
      const stats = average[foot];
      ctx.fillStyle = COLORS.total;
      ctx.font = '700 13px Roboto, Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${footLabel(foot)}  ${format(S.strideCount, { n: stats.n })}`, box(0, column).x, 14);
      rows.forEach((row, r) => {
        const means = row.key === 'total' ? [stats.mean.total] : stats.mean[row.key];
        const sds = row.key === 'total' ? [stats.sd.total] : stats.sd[row.key];
        drawPanel(ctx, box(r, column), {
          x0: 0, x1: 100, y0: row.range[0], y1: row.range[1],
          title: row.title,
          areas: means.map((m, i) => ({ xs, upper: m.map((v, k) => v + sds[i][k]), lower: m.map((v, k) => v - sds[i][k]), color: row.colors[i] })),
          lines: means.map((m, i) => ({ xs, ys: m, color: row.colors[i], width: row.key === 'total' ? 1.8 : 1.4 })),
          markers: [{ x: stats.toeOffPct, color: COLORS.toeOff, width: 1 }],
          xTicks: true,
          xStep: 20,
          xLabels: r === rows.length - 1,
          yLabels: column === 0 || width >= 480,
        });
      });
    });
    ctx.fillStyle = COLORS.text;
    ctx.font = FONT;
    ctx.textAlign = 'right';
    ctx.fillText(S.strideAxis, width - 8, height - 4);
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const units = document.documentElement.lang === 'ja' ? Array.from(text) : text.split(' ');
    const joiner = document.documentElement.lang === 'ja' ? '' : ' ';
    let line = '';
    let row = 0;
    for (const unit of units) {
      const next = line ? line + joiner + unit : unit;
      if (ctx.measureText(next).width > maxWidth && line) {
        ctx.fillText(line, x, y + row * lineHeight);
        line = unit;
        row += 1;
      } else {
        line = next;
      }
    }
    if (line) ctx.fillText(line, x, y + row * lineHeight);
  }

  // ---------------------------------------------------------------------------
  // 足底圧マップ
  // ---------------------------------------------------------------------------

  const pressureNodes = {};

  function svg(tag, attributes, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    if (parent) parent.appendChild(node);
    return node;
  }

  function sensorPosition(foot, index) {
    const [x, y] = SENSOR_POSITIONS[index];
    return foot === 'left' ? [x, y] : [100 - x, y];
  }

  function buildPressureMap() {
    el.pressure.textContent = '';
    const root = svg('svg', { viewBox: '0 0 240 336', role: 'img', 'aria-label': S.chartPress }, el.pressure);
    FEET.forEach((foot, column) => {
      const offsetX = column === 0 ? 10 : 130;
      const label = svg('text', { x: offsetX + 50, y: 14, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: COLORS.total }, root);
      const group = svg('g', { transform: `translate(${offsetX} 26)` }, root);
      const outline = svg('path', { d: INSOLE_PATH, fill: '#f4f7f9', stroke: '#c9d2da', 'stroke-width': 1.2 }, group);
      if (foot === 'right') outline.setAttribute('transform', 'translate(100 0) scale(-1 1)');
      const trail = svg('polyline', { fill: 'none', stroke: COLORS.total, 'stroke-width': 1.2, 'stroke-opacity': 0.45, points: '' }, group);
      const circles = SENSOR_POSITIONS.map((_, i) => {
        const [x, y] = sensorPosition(foot, i);
        const circle = svg('circle', { cx: x, cy: y, r: 9, fill: '#eef2f5', stroke: 'white', 'stroke-width': 1.5 }, group);
        const text = svg('text', { x, y: y + 3.5, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: COLORS.total }, group);
        text.textContent = String(i + 1);
        return circle;
      });
      const cop = svg('circle', { r: 3.6, fill: COLORS.total, stroke: 'white', 'stroke-width': 1, visibility: 'hidden' }, group);
      const total = svg('text', { x: offsetX + 50, y: 330, 'text-anchor': 'middle', 'font-size': 11, fill: COLORS.text }, root);
      pressureNodes[foot] = { label, circles, cop, trail, total };
    });
  }

  function pressureColor(value) {
    const ratio = Math.min(Math.max(value / PRESSURE_COLOR_MAX_N, 0), 1);
    const stops = [[0, [238, 242, 245]], [0.4, [69, 230, 230]], [1, [255, 96, 64]]];
    let i = 0;
    while (i < stops.length - 2 && ratio > stops[i + 1][0]) i += 1;
    const [r0, c0] = stops[i];
    const [r1, c1] = stops[i + 1];
    const k = (ratio - r0) / (r1 - r0);
    return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * k)).join(',')})`;
  }

  function centerOfPressure(foot, index) {
    const press = data.feet[foot].press;
    let sum = 0;
    let x = 0;
    let y = 0;
    for (let ch = 0; ch < 6; ch += 1) {
      const v = press[ch][index] || 0;
      const [px, py] = sensorPosition(foot, ch);
      sum += v;
      x += px * v;
      y += py * v;
    }
    return sum > 0 ? [x / sum, y / sum] : null;
  }

  function drawPressureMap() {
    if (!data) return;
    for (const foot of FEET) {
      const series = data.feet[foot];
      const nodes = pressureNodes[foot];
      const index = indexAt(series.t, t);
      nodes.label.textContent = footLabel(foot);
      nodes.circles.forEach((circle, ch) => {
        const v = series.press[ch][index] || 0;
        circle.setAttribute('fill', pressureColor(v));
        circle.setAttribute('r', String(8 + Math.min(v, PRESSURE_COLOR_MAX_N) / PRESSURE_COLOR_MAX_N * 6));
      });
      const cop = centerOfPressure(foot, index);
      nodes.cop.setAttribute('visibility', cop ? 'visible' : 'hidden');
      if (cop) {
        nodes.cop.setAttribute('cx', cop[0].toFixed(1));
        nodes.cop.setAttribute('cy', cop[1].toFixed(1));
      }
      const points = [];
      const start = indexAt(series.t, t - COP_TRAIL_S);
      for (let i = start; i <= index; i += 2) {
        const p = centerOfPressure(foot, i);
        if (p) points.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
      }
      nodes.trail.setAttribute('points', points.join(' '));
      nodes.total.textContent = `${S.pressureTotal} ${(totals[foot][index] || 0).toFixed(0)} N`;
    }
  }

  // ---------------------------------------------------------------------------
  // 再生と同期
  // ---------------------------------------------------------------------------

  function videoTimeOf(sensorTime) {
    return sensorTime + data.videoTimeAtZeroS;
  }

  function clampTime(value) {
    if (!ranges) return value;
    return Math.min(Math.max(value, ranges.time[0]), ranges.time[1]);
  }

  function render() {
    el.time.textContent = `t = ${formatNumber(t, 2, false)} s`;
    if (activeTab === 'sync') {
      drawOverview();
      drawSync();
      drawPressureMap();
    }
  }

  function tick() {
    if (data && !el.video.paused) t = el.video.currentTime - data.videoTimeAtZeroS;
    render();
    animationFrame = el.video.paused ? 0 : requestAnimationFrame(tick);
  }

  function seek(sensorTime) {
    if (!data) return;
    t = clampTime(sensorTime);
    const duration = Number.isFinite(el.video.duration) ? el.video.duration : Infinity;
    const target = Math.min(Math.max(videoTimeOf(t), 0), duration);
    if (Math.abs(el.video.currentTime - target) > 1e-3) el.video.currentTime = target;
    render();
  }

  function setPlaying(playing) {
    if (playing) {
      el.video.play().catch((error) => console.error('[sample-data] video.play() failed', error));
    } else {
      el.video.pause();
    }
  }

  function updatePlayButton() {
    const playing = !el.video.paused;
    el.play.textContent = playing ? '❚❚' : '▶';
    el.play.setAttribute('aria-label', playing ? S.viewerPause : S.viewerPlay);
  }

  function attachSeekHandlers(canvas, toTime) {
    let dragging = false;
    const handle = (event) => {
      const rect = canvas.getBoundingClientRect();
      const time = toTime(event.clientX - rect.left, rect.width);
      if (time !== null) seek(time);
    };
    canvas.addEventListener('pointerdown', (event) => {
      if (!data) return;
      dragging = true;
      canvas.setPointerCapture(event.pointerId);
      el.video.pause();
      handle(event);
    });
    canvas.addEventListener('pointermove', (event) => dragging && handle(event));
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
  }

  // ---------------------------------------------------------------------------
  // 試技の切り替え
  // ---------------------------------------------------------------------------

  function trialById(id) {
    return manifest && manifest.trials.find((trial) => trial.id === id);
  }

  function computeRanges() {
    const all = (key) => FEET.flatMap((foot) => data.feet[foot][key]);
    totals = {};
    for (const foot of FEET) {
      const press = data.feet[foot].press;
      totals[foot] = data.feet[foot].t.map((_, i) => press.reduce((sum, ch) => sum + (ch[i] || 0), 0));
    }
    const times = FEET.flatMap((foot) => [data.feet[foot].t[0], data.feet[foot].t[data.feet[foot].t.length - 1]]);
    ranges = {
      acc: robustRange(all('acc'), 0.002, 0.998, true),
      gyro: robustRange(all('gyro'), 0.002, 0.998, true),
      press: [0, Math.max(...FEET.map((foot) => Math.max(...totals[foot]))) * 1.05 || 10],
      time: [Math.min(...times), Math.max(...times)],
    };
  }

  function renderTrialChrome() {
    el.select.value = current.id;
    el.badges.textContent = '';
    const group = document.createElement('span');
    group.className = `device-badge group-badge group-${current.group}`;
    group.textContent = S[GROUP_TAG_KEYS[current.group]];
    el.badges.appendChild(group);
    el.download.href = downloadUrl(current.archive);
    el.downloadSize.textContent = megabytes(current.archiveBytes);
    for (const notes of document.querySelectorAll('.trial-notes')) {
      notes.classList.toggle('is-hidden', notes.dataset.trial !== current.id);
    }
    for (const row of el.compare.querySelectorAll('tbody tr')) {
      row.classList.toggle('is-selected', row.dataset.trial === current.id);
    }
    renderMetricsCard();
    el.sync.textContent = '';
  }

  function renderMetricsCard() {
    const card = el.metrics;
    card.textContent = '';
    const title = document.createElement('h3');
    title.textContent = S.metricsCardTitle;
    card.appendChild(title);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const text of ['', footLabel('left'), footLabel('right')]) {
      const th = document.createElement('th');
      th.textContent = text;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const [group, keys] of Object.entries(METRIC_GROUPS)) {
      const groupRow = body.insertRow();
      const th = document.createElement('th');
      th.colSpan = 3;
      th.textContent = S[`metricGroup${group[0].toUpperCase()}${group.slice(1)}`];
      groupRow.appendChild(th);
      for (const key of keys) {
        const row = body.insertRow();
        row.insertCell().textContent = metricLabel(key);
        for (const value of current.metrics[key]) row.insertCell().textContent = formatMetric(key, value);
      }
    }
    card.appendChild(table);
    if (current.metricsNote === 'freezing') {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = S.metricsCardFreezing;
      card.appendChild(note);
    }
  }

  async function selectTrial(id) {
    const trial = trialById(id);
    if (!trial || (current && current.id === id && data)) return;
    current = trial;
    data = null;
    overviewCache = null;
    renderTrialChrome();
    el.status.textContent = S.viewerLoading;
    el.video.pause();
    el.video.poster = new URL(`files/${id}/poster.jpg`, BASE_URL).href;
    el.video.src = new URL(`files/${id}/video.mp4`, BASE_URL).href;
    render();
    drawStride();

    if (loadController) loadController.abort();
    loadController = new AbortController();
    const signal = AbortSignal.any([loadController.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
    try {
      const response = await fetch(new URL(`files/${id}/data.json`, BASE_URL), { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${response.url}`);
      const loaded = await response.json();
      if (current.id !== id) return;
      data = loaded;
    } catch (error) {
      if (error.name === 'AbortError' && current.id !== id) return;
      console.error(`[sample-data] failed to load ${id}`, error);
      el.status.textContent = S.viewerLoadError;
      return;
    }
    computeRanges();
    el.status.textContent = '';
    const { rightOffsetMs, videoOffsetS, videoOffsetMethod } = data.sync;
    el.sync.textContent = format(S.viewerSyncInfo, {
      right: formatNumber(rightOffsetMs, 1, false),
      video: formatNumber(videoOffsetS, 3, false),
    }) + (videoOffsetMethod === 'median' ? S.viewerSyncMedian : '');
    t = clampTime(el.video.currentTime - data.videoTimeAtZeroS);
    render();
    drawStride();
  }

  function scrollToViewer() {
    document.getElementById('viewer').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function trialFromHash() {
    const match = /^#trial-([\w-]+)$/.exec(window.location.hash);
    return match && trialById(match[1]) ? match[1] : null;
  }

  function openTrial(id, { scroll }) {
    if (!trialById(id)) return;
    history.replaceState(null, '', `#trial-${id}`);
    selectTrial(id);
    if (scroll) scrollToViewer();
  }

  // ---------------------------------------------------------------------------
  // 表と凡例
  // ---------------------------------------------------------------------------

  function renderCompareTable() {
    const table = el.compare;
    table.textContent = '';
    const keys = METRIC_GROUPS[compareGroup];
    const head = table.createTHead().insertRow();
    for (const text of [S.compareTrial, ...keys.map(metricLabel)]) {
      const th = document.createElement('th');
      th.textContent = text;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const trial of manifest.trials) {
      const row = body.insertRow();
      row.dataset.trial = trial.id;
      row.tabIndex = 0;
      row.classList.toggle('is-selected', current && current.id === trial.id);
      row.insertCell().textContent = trial.name[document.documentElement.lang] + (trial.metricsNote ? ' *' : '');
      for (const key of keys) row.insertCell().textContent = trial.metrics[key].map((v) => formatMetric(key, v)).join(' / ');
      const open = () => openTrial(trial.id, { scroll: true });
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') open();
      });
    }
  }

  function renderLegend() {
    el.legend.textContent = '';
    const items = [
      ...['axisX', 'axisY', 'axisZ'].map((key, i) => [S[key], COLORS.axes[i]]),
      ...[1, 2, 3, 4, 5, 6].map((n, i) => [S[`sensor${n}`], COLORS.press[i]]),
      [S.pressureTotal, COLORS.total],
    ];
    for (const [label, color] of items) {
      const item = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.style.color = color;
      item.append(swatch, label);
      el.legend.appendChild(item);
    }
  }

  function setTab(tab) {
    activeTab = tab;
    for (const button of document.querySelectorAll('#viewer-app [data-tab]')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    }
    el.panelSync.hidden = tab !== 'sync';
    el.panelStride.hidden = tab !== 'stride';
    if (tab === 'stride') drawStride();
    else render();
  }

  // ---------------------------------------------------------------------------
  // 初期化
  // ---------------------------------------------------------------------------

  function bindElements() {
    Object.assign(el, {
      select: document.getElementById('viewer-trial'),
      prev: document.getElementById('viewer-prev'),
      next: document.getElementById('viewer-next'),
      badges: document.getElementById('viewer-badges'),
      download: document.getElementById('viewer-download'),
      downloadSize: document.getElementById('viewer-download-size'),
      body: document.getElementById('viewer-body'),
      video: document.getElementById('viewer-video'),
      play: document.getElementById('viewer-play'),
      time: document.getElementById('viewer-time'),
      sync: document.getElementById('viewer-sync'),
      pressure: document.getElementById('viewer-pressure'),
      chartOverview: document.getElementById('chart-overview'),
      chartSync: document.getElementById('chart-sync'),
      chartStride: document.getElementById('chart-stride'),
      panelSync: document.getElementById('panel-sync'),
      panelStride: document.getElementById('panel-stride'),
      legend: document.getElementById('viewer-legend'),
      status: document.getElementById('viewer-status'),
      metrics: document.getElementById('viewer-metrics'),
      compare: document.getElementById('compare-table'),
    });
  }

  function bindEvents() {
    el.select.addEventListener('change', () => openTrial(el.select.value, { scroll: false }));
    const step = (delta) => {
      const index = manifest.trials.findIndex((trial) => trial.id === current.id);
      const next = manifest.trials[(index + delta + manifest.trials.length) % manifest.trials.length];
      openTrial(next.id, { scroll: false });
    };
    el.prev.addEventListener('click', () => step(-1));
    el.next.addEventListener('click', () => step(1));

    el.play.addEventListener('click', () => setPlaying(el.video.paused));
    el.video.addEventListener('click', () => setPlaying(el.video.paused));
    el.video.addEventListener('play', () => {
      updatePlayButton();
      if (!animationFrame) animationFrame = requestAnimationFrame(tick);
    });
    el.video.addEventListener('pause', updatePlayButton);
    el.video.addEventListener('ended', updatePlayButton);
    el.video.addEventListener('seeked', () => {
      if (data && el.video.paused) {
        t = clampTime(el.video.currentTime - data.videoTimeAtZeroS);
        render();
      }
    });
    for (const button of document.querySelectorAll('#viewer-app [data-rate]')) {
      button.addEventListener('click', () => {
        // src を差し替えると playbackRate は defaultPlaybackRate に戻るので、両方を設定して試技の切り替え後も保つ
        el.video.defaultPlaybackRate = Number(button.dataset.rate);
        el.video.playbackRate = Number(button.dataset.rate);
        for (const other of document.querySelectorAll('#viewer-app [data-rate]')) other.classList.toggle('active', other === button);
      });
    }
    el.body.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLSelectElement) return;
      if (event.key === ' ') {
        event.preventDefault();
        setPlaying(el.video.paused);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        el.video.pause();
        seek(t + (event.key === 'ArrowRight' ? FRAME_S : -FRAME_S));
      }
    });

    attachSeekHandlers(el.chartSync, (x, width) => {
      const layout = columnLayout(width);
      const box = grid(width, 1, 1, layout)(0, 0);
      const column = x > box.x + box.w + layout.gap / 2 ? 1 : 0;
      const start = box.x + column * (box.w + layout.gap);
      return t - WINDOW_S / 2 + ((x - start) / box.w) * WINDOW_S;
    });
    attachSeekHandlers(el.chartOverview, (x, width) => {
      const lane = overviewLayout(width, el.chartOverview.getBoundingClientRect().height)[0];
      return ranges.time[0] + ((x - lane.x) / lane.w) * (ranges.time[1] - ranges.time[0]);
    });

    for (const button of document.querySelectorAll('#viewer-app [data-tab]')) {
      button.addEventListener('click', () => setTab(button.dataset.tab));
    }
    for (const button of document.querySelectorAll('#compare-tabs [data-group]')) {
      button.addEventListener('click', () => {
        compareGroup = button.dataset.group;
        for (const other of document.querySelectorAll('#compare-tabs [data-group]')) {
          other.setAttribute('aria-selected', String(other === button));
        }
        renderCompareTable();
      });
    }
    for (const link of document.querySelectorAll('a[data-trial-link]')) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        openTrial(link.dataset.trialLink, { scroll: true });
      });
    }
    window.addEventListener('hashchange', () => {
      const id = trialFromHash();
      if (id) openTrial(id, { scroll: true });
    });

    let resizeFrame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        overviewCache = null;
        render();
        if (activeTab === 'stride') drawStride();
      });
    }).observe(el.body);
  }

  async function init({ strings }) {
    S = strings;
    bindElements();
    try {
      const response = await fetch(new URL('trials.json', BASE_URL), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${response.url}`);
      manifest = await response.json();
    } catch (error) {
      console.error('[sample-data] failed to load trials.json', error);
      el.status.textContent = S.viewerLoadError;
      return;
    }
    for (const trial of manifest.trials) {
      const option = document.createElement('option');
      option.value = trial.id;
      option.textContent = `${trial.id.slice(0, 2)}  ${trial.name[document.documentElement.lang]}`;
      el.select.appendChild(option);
    }
    buildPressureMap();
    renderLegend();
    bindEvents();
    const fromHash = trialFromHash();
    await selectTrial(fromHash || manifest.trials[0].id);
    renderCompareTable();
    if (fromHash) scrollToViewer();
  }

  window.OrpheSampleViewer = { init };
})();
