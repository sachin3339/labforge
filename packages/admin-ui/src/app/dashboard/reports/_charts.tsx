// Enterprise-grade SVG chart primitives. No dependencies — everything
// is server-rendered. Tooltips use native <title> so they work without
// JS. Designed to render inside a `card` with the surrounding context
// providing the heading.

type LinePoint = { label: string; value: number; secondary?: number };

const PALETTE = {
  brand: '#4f46e5', // indigo-600
  brandSoft: 'rgba(79, 70, 229, 0.12)',
  good: '#16a34a',
  goodSoft: 'rgba(22, 163, 74, 0.12)',
  warn: '#f59e0b',
  bad: '#dc2626',
  ink: '#1f2937',
  muted: '#6b7280',
  grid: '#e5e7eb',
};

/** Compact number formatter: 1234 -> 1.2k. */
export function fmtNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return Math.round(n).toString();
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86_400);
  const h = Math.round((seconds % 86_400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}

// ---------------- Line / area chart ----------------

/**
 * Multi-series area+line chart with axes, gridlines, and per-point
 * <title> tooltips. Width is responsive (uses viewBox); height is fixed.
 */
export function LineAreaChart({
  data,
  height = 220,
  yLabel,
  series = ['primary', 'secondary'],
  primaryLabel = 'Primary',
  secondaryLabel = 'Secondary',
}: {
  data: LinePoint[];
  height?: number;
  yLabel?: string;
  series?: Array<'primary' | 'secondary'>;
  primaryLabel?: string;
  secondaryLabel?: string;
}) {
  const W = 800;
  const H = height;
  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-ink-100 bg-white text-xs text-ink-900/40"
        style={{ height }}
      >
        No data in selected window
      </div>
    );
  }

  const maxV = Math.max(
    1,
    ...data.map((d) => Math.max(d.value, d.secondary ?? 0)),
  );
  // Round the y-axis ceiling to a friendly number.
  const ceil = niceCeil(maxV);
  const ticks = 4;
  const tickVals = Array.from({ length: ticks + 1 }, (_, i) =>
    Math.round((ceil / ticks) * i),
  );

  const x = (i: number) =>
    data.length === 1 ? padL + innerW / 2 : padL + (i / (data.length - 1)) * innerW;
  const y = (v: number) => padT + innerH - (v / ceil) * innerH;

  const pathFor = (key: 'value' | 'secondary') => {
    const pts = data
      .map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y((d[key] ?? 0)).toFixed(1)}`)
      .join(' ');
    return pts;
  };
  const areaFor = (key: 'value' | 'secondary') => {
    if (data.length === 0) return '';
    return [
      pathFor(key),
      `L ${x(data.length - 1).toFixed(1)} ${y(0).toFixed(1)}`,
      `L ${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`,
    ].join(' ');
  };

  // x labels: show ~6 evenly-spaced labels
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full rounded-md border border-ink-100 bg-white"
      style={{ height }}
      role="img"
      aria-label={yLabel ?? 'chart'}
    >
      {/* gridlines + y-axis ticks */}
      {tickVals.map((tv, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(tv)}
            y2={y(tv)}
            stroke={PALETTE.grid}
            strokeDasharray={i === 0 ? '' : '2 3'}
          />
          <text
            x={padL - 6}
            y={y(tv) + 3}
            textAnchor="end"
            fontSize="9"
            fill={PALETTE.muted}
            fontFamily="ui-sans-serif, system-ui"
          >
            {fmtNum(tv)}
          </text>
        </g>
      ))}

      {/* secondary area+line (rendered first so primary draws on top) */}
      {series.includes('secondary') && (
        <>
          <path d={areaFor('secondary')} fill={PALETTE.goodSoft} />
          <path d={pathFor('secondary')} fill="none" stroke={PALETTE.good} strokeWidth="1.6" />
        </>
      )}
      {/* primary */}
      {series.includes('primary') && (
        <>
          <path d={areaFor('value')} fill={PALETTE.brandSoft} />
          <path d={pathFor('value')} fill="none" stroke={PALETTE.brand} strokeWidth="2" />
        </>
      )}

      {/* point dots + invisible hit areas with native tooltip */}
      {data.map((d, i) => (
        <g key={i}>
          {series.includes('primary') && (
            <circle cx={x(i)} cy={y(d.value)} r="2.5" fill={PALETTE.brand}>
              <title>{`${d.label} — ${primaryLabel}: ${d.value}${
                d.secondary !== undefined ? `\n${secondaryLabel}: ${d.secondary}` : ''
              }`}</title>
            </circle>
          )}
          {series.includes('secondary') && d.secondary !== undefined && (
            <circle cx={x(i)} cy={y(d.secondary)} r="2" fill={PALETTE.good} />
          )}
          {i % labelEvery === 0 && (
            <text
              x={x(i)}
              y={H - 10}
              textAnchor="middle"
              fontSize="9"
              fill={PALETTE.muted}
              fontFamily="ui-sans-serif, system-ui"
            >
              {d.label.length > 10 ? d.label.slice(5) : d.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / exp;
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * exp;
}

// ---------------- Donut ----------------

/**
 * Donut chart with center label. Slices smaller than 2% are still drawn
 * but their text label is suppressed.
 */
export function Donut({
  segments,
  size = 160,
  thickness = 22,
  centerLabel,
  centerValue,
}: {
  segments: Array<{ label: string; value: number; color?: string }>;
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const r = size / 2 - thickness / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  const total = segments.reduce((s, x) => s + x.value, 0);
  const defaults = [PALETTE.brand, PALETTE.good, PALETTE.warn, PALETTE.bad, '#06b6d4', '#a855f7', '#475569'];

  if (total === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center text-xs text-ink-900/40"
        style={{ width: size, height: size }}
      >
        <div
          className="rounded-full border-2 border-dashed border-ink-200"
          style={{ width: r * 2, height: r * 2 }}
        />
        <span className="mt-1">No data</span>
      </div>
    );
  }

  let cursor = 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img">
      {segments.map((seg, i) => {
        const frac = seg.value / total;
        const start = cursor;
        cursor += frac;
        const end = cursor;
        const color = seg.color ?? defaults[i % defaults.length];
        const path = arcPath(cx, cy, r, start * Math.PI * 2, end * Math.PI * 2);
        return (
          <path key={seg.label} d={path} fill="none" stroke={color} strokeWidth={thickness}>
            <title>{`${seg.label}: ${seg.value} (${Math.round(frac * 100)}%)`}</title>
          </path>
        );
      })}
      {centerValue !== undefined && (
        <text
          x={cx}
          y={cy + 2}
          textAnchor="middle"
          fontSize="20"
          fontWeight="600"
          fill={PALETTE.ink}
          fontFamily="ui-sans-serif, system-ui"
        >
          {centerValue}
        </text>
      )}
      {centerLabel && (
        <text
          x={cx}
          y={cy + 20}
          textAnchor="middle"
          fontSize="10"
          fill={PALETTE.muted}
          fontFamily="ui-sans-serif, system-ui"
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
}

function arcPath(
  cx: number,
  cy: number,
  r: number,
  startRad: number,
  endRad: number,
): string {
  // Use 0.999 of a full circle to avoid SVG arc degeneracy when a single
  // slice owns the entire donut.
  if (endRad - startRad >= Math.PI * 2) endRad = startRad + Math.PI * 1.9999;
  const x1 = cx + r * Math.cos(startRad - Math.PI / 2);
  const y1 = cy + r * Math.sin(startRad - Math.PI / 2);
  const x2 = cx + r * Math.cos(endRad - Math.PI / 2);
  const y2 = cy + r * Math.sin(endRad - Math.PI / 2);
  const large = endRad - startRad > Math.PI ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

// ---------------- Gauge (radial progress) ----------------

export function Gauge({
  percent,
  label,
  size = 140,
  thickness = 14,
  tone,
}: {
  percent: number;
  label?: string;
  size?: number;
  thickness?: number;
  tone?: 'good' | 'warn' | 'bad' | 'auto';
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const t: 'good' | 'warn' | 'bad' =
    tone && tone !== 'auto'
      ? tone
      : clamped < 60
        ? 'good'
        : clamped < 85
          ? 'warn'
          : 'bad';
  const color =
    t === 'good' ? PALETTE.good : t === 'warn' ? PALETTE.warn : PALETTE.bad;

  const r = size / 2 - thickness / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img">
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={PALETTE.grid}
        strokeWidth={thickness}
      />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={thickness}
        strokeDasharray={`${(clamped / 100) * circ} ${circ}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
      />
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        fontSize="22"
        fontWeight="700"
        fill={PALETTE.ink}
        fontFamily="ui-sans-serif, system-ui"
      >
        {clamped.toFixed(0)}%
      </text>
      {label && (
        <text
          x={cx}
          y={cy + 22}
          textAnchor="middle"
          fontSize="10"
          fill={PALETTE.muted}
          fontFamily="ui-sans-serif, system-ui"
        >
          {label}
        </text>
      )}
    </svg>
  );
}

// ---------------- Sparkline ----------------

export function Sparkline({
  values,
  width = 120,
  height = 30,
  tone = 'brand',
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: 'brand' | 'good' | 'bad';
}) {
  if (values.length === 0) {
    return <div style={{ width, height }} />;
  }
  const max = Math.max(1, ...values);
  const stride = values.length > 1 ? width / (values.length - 1) : 0;
  const path = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stride).toFixed(1)} ${(height - (v / max) * height).toFixed(1)}`)
    .join(' ');
  const color = tone === 'good' ? PALETTE.good : tone === 'bad' ? PALETTE.bad : PALETTE.brand;
  return (
    <svg width={width} height={height} role="img">
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// ---------------- Stat tile with delta ----------------

export function KpiTile({
  label,
  value,
  delta,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  /** Percent change vs. previous period. Positive = up. */
  delta?: number;
  hint?: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  const borderTone =
    tone === 'good'
      ? 'border-l-emerald-500'
      : tone === 'warn'
        ? 'border-l-amber-500'
        : tone === 'bad'
          ? 'border-l-red-500'
          : 'border-l-brand';
  return (
    <div className={`card border-l-4 ${borderTone}`}>
      <div className="text-[11px] uppercase tracking-wide text-ink-900/50">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-3xl font-semibold tracking-tight">{value}</div>
        {delta !== undefined && Number.isFinite(delta) && (
          <span
            className={`text-xs font-medium ${
              delta >= 0 ? 'text-emerald-700' : 'text-red-700'
            }`}
          >
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}%
          </span>
        )}
      </div>
      {hint && <div className="mt-1 text-[11px] text-ink-900/50">{hint}</div>}
    </div>
  );
}

// ---------------- Horizontal bar (top-N list) ----------------

export function HorizontalBars({
  rows,
  formatter = (n) => fmtNum(n),
}: {
  rows: Array<{ label: string; value: number; href?: string }>;
  formatter?: (n: number) => string;
}) {
  if (rows.length === 0) {
    return <div className="text-xs text-ink-900/40">No data</div>;
  }
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between text-xs">
            <span className="truncate font-medium text-ink-900/80">{r.label}</span>
            <span className="ml-2 tabular-nums text-ink-900/60">{formatter(r.value)}</span>
          </div>
          <div className="mt-1 h-2 w-full rounded-full bg-ink-50">
            <div
              className="h-2 rounded-full bg-brand"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
