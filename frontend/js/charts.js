// ECharts option builders. Pure functions: data + colour tokens in, option out.

import { esc, fmtNumber, fmtValue, periodLabel } from './format.js';

const compact = new Intl.NumberFormat('sv-SE', { notation: 'compact', maximumFractionDigits: 1 });
const axisNumber = (v) => (Math.abs(v) >= 10_000 ? compact.format(v) : fmtNumber(v, Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0));

function tooltipBase(t) {
  return {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: t.ink, fontFamily: 'inherit', fontSize: 13 },
    extraCssText: 'box-shadow:0 6px 20px rgba(0,0,0,.18);border-radius:10px;',
  };
}

const tipValue = (text) => `<div style="font-weight:700;font-size:15px">${esc(text)}</div>`;

/**
 * Colour scale by rank (quantiles): each colour class holds the same number of
 * regions. Works well for skewed data such as population.
 */
export function quantileScale(values, ramp) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = ramp.length;
  return {
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    color(v) {
      if (!Number.isFinite(v) || !sorted.length) return null;
      if (sorted.length === 1) return ramp[Math.floor(n / 2)];
      const rank = sorted.indexOf(v);
      return ramp[Math.min(n - 1, Math.floor((rank / sorted.length) * n))];
    },
  };
}

export function mapOption({ ds, mapName, codes, valueOf, nameOf, selectedCode, selectedColor, scale, aspectScale, t }) {
  return {
    animationDurationUpdate: 250,
    tooltip: {
      ...tooltipBase(t),
      trigger: 'item',
      formatter: (p) => `${tipValue(fmtValue(valueOf(p.name), ds))}<div style="color:${t.ink2}">${esc(nameOf(p.name))}</div>`,
    },
    series: [
      {
        type: 'map',
        map: mapName,
        roam: false,
        aspectScale,
        top: 8,
        bottom: 8,
        left: 8,
        right: 8,
        selectedMode: false,
        label: { show: false },
        itemStyle: { areaColor: t.empty, borderColor: t.surface, borderWidth: 0.8 },
        emphasis: { label: { show: false }, itemStyle: { borderColor: t.ink, borderWidth: 1.5 } },
        data: codes.map((code) => {
          const v = valueOf(code);
          const c = scale.color(v) ?? t.empty;
          const sel = code === selectedCode;
          return {
            name: code,
            value: v,
            itemStyle: { areaColor: c, borderColor: sel ? selectedColor : t.surface, borderWidth: sel ? 3 : 0.8 },
            emphasis: { itemStyle: { areaColor: c } },
          };
        }),
      },
    ],
  };
}

/**
 * @param series [{name, data, color}]
 */
export function lineOption({ ds, series, periodIdx, indexMode, endLabels, legendSelected, zoom, t }) {
  const labels = ds.periods.map(periodLabel);
  const fmt = (v) => (indexMode ? fmtNumber(v, 1) : fmtValue(v, ds));
  const zoomable = labels.length > 60;
  const showLegend = series.length > 1;

  return {
    animationDuration: 300,
    animationDurationUpdate: 200,
    grid: {
      left: 4,
      right: endLabels ? 120 : 20,
      top: showLegend ? 40 : 14,
      bottom: zoomable ? 44 : 4,
      containLabel: true,
    },
    legend: showLegend
      ? {
          top: 0,
          left: 0,
          icon: 'roundRect',
          itemWidth: 16,
          itemHeight: 3,
          itemGap: 16,
          textStyle: { color: t.ink2 },
          inactiveColor: t.baseline,
          selected: legendSelected,
        }
      : { show: false },
    tooltip: {
      ...tooltipBase(t),
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: t.axis, width: 1 } },
      formatter: (items) => {
        if (!items.length) return '';
        const head = `<div style="color:${t.muted};margin-bottom:4px">${esc(labels[items[0].dataIndex])}</div>`;
        const rows = items
          .map(
            (it) =>
              `<div style="display:flex;align-items:center;gap:8px;margin-top:2px">` +
              `<span style="display:inline-block;width:14px;height:2px;border-radius:1px;background:${it.color}"></span>` +
              `<b>${esc(fmt(it.value))}</b><span style="color:${t.ink2}">${esc(it.seriesName)}</span></div>`,
          )
          .join('');
        return head + rows;
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
      axisLine: { lineStyle: { color: t.baseline } },
      axisTick: { show: false },
      axisLabel: { color: t.axis, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: t.grid } },
      axisLabel: { color: t.axis, formatter: axisNumber },
    },
    dataZoom: zoomable
      ? [
          { type: 'inside', start: zoom[0], end: zoom[1] },
          {
            type: 'slider',
            start: zoom[0],
            end: zoom[1],
            height: 18,
            bottom: 6,
            borderColor: t.border,
            fillerColor: 'rgba(57,135,229,0.15)',
            handleStyle: { color: t.surface, borderColor: t.axis },
            moveHandleStyle: { color: t.baseline },
            textStyle: { color: t.axis },
            dataBackground: { lineStyle: { color: t.baseline }, areaStyle: { color: t.grid } },
            selectedDataBackground: { lineStyle: { color: t.series[0] }, areaStyle: { color: t.grid } },
          },
        ]
      : [],
    series: series.map((s, k) => ({
      type: 'line',
      name: s.name,
      data: s.data,
      color: s.color,
      showSymbol: false,
      symbolSize: 8,
      lineStyle: { width: 2 },
      emphasis: { focus: 'series', lineStyle: { width: 2.5 } },
      endLabel: endLabels ? { show: true, formatter: '{a}', color: t.ink2, fontSize: 12, distance: 8 } : { show: false },
      markLine:
        k === 0
          ? {
              symbol: 'none',
              silent: true,
              label: { show: false },
              lineStyle: { color: t.axis, type: 'dashed', width: 1 },
              data: [{ xAxis: labels[periodIdx] }],
              animation: false,
            }
          : undefined,
    })),
  };
}

/**
 * Horizontal ranking bars.
 * @param rows [{code, name, value, selected, color}] sorted descending
 */
export function rankOption({ ds, rows, reference, t }) {
  const showValues = rows.length <= 30;
  return {
    animationDuration: 300,
    animationDurationUpdate: 250,
    grid: { left: 4, right: showValues ? 64 : 24, top: reference ? 24 : 6, bottom: 4, containLabel: true },
    tooltip: {
      ...tooltipBase(t),
      trigger: 'item',
      formatter: (p) => `${tipValue(fmtValue(rows[p.dataIndex].value, ds))}<div style="color:${t.ink2}">${esc(rows[p.dataIndex].name)}</div>`,
    },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: t.grid } },
      axisLabel: { color: t.axis, formatter: axisNumber, hideOverlap: true },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: rows.map((r) => r.name),
      axisTick: { show: false },
      axisLine: { lineStyle: { color: t.baseline } },
      axisLabel: {
        color: t.ink2,
        formatter: (v, i) => (rows[i]?.selected ? `{sel|${v}}` : v),
        rich: { sel: { color: t.ink, fontWeight: 700 } },
      },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 16,
        barCategoryGap: '28%',
        cursor: 'pointer',
        data: rows.map((r) => ({
          value: r.value,
          itemStyle: {
            color: r.color,
            borderRadius: [0, 4, 4, 0],
          },
        })),
        label: showValues
          ? { show: true, position: 'right', color: t.ink2, fontSize: 11, formatter: (p) => fmtNumber(p.value, ds.decimals) }
          : { show: false },
        emphasis: { itemStyle: { opacity: 0.8 } },
        markLine: reference
          ? {
              symbol: 'none',
              silent: true,
              animation: false,
              lineStyle: { color: t.ink2, type: 'dashed', width: 1 },
              // y-axis is inverted, so 'start' is the top of the line
              label: { position: 'start', formatter: reference.label, color: t.ink2, fontSize: 11, distance: 6 },
              data: [{ xAxis: reference.value }],
            }
          : undefined,
      },
    ],
  };
}
