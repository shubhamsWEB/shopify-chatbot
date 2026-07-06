// Recharts wrappers for the admin dashboard. Client-only render (ResponsiveContainer
// needs a real width; avoids SSR hydration mismatch in the embedded admin).
import { useEffect, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  AreaChart, Area, PieChart, Pie, Cell, LineChart, Line, Legend,
} from "recharts";

// Spec the analytics assistant emits for an inline chart (data resolved server-side
// from the real analytics bundle, so it's always grounded).
export interface ChartSpec {
  kind: "bar" | "line" | "pie";
  title: string;
  data: Array<Record<string, string | number>>;
  xKey?: string;     // category key (default "name")
  series?: string[]; // numeric keys for line/multi (default ["value"])
}

const PALETTE = ["#5C6AC4", "#47C1BF", "#9C6ADE", "#F49342", "#50B83C", "#DE3618", "#006FBB", "#EEC200"];
const GRID = "#f0f1f3";
const AXIS = "#8c9196";

function ClientOnly({ height, children }: { height: number; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return <div style={{ width: "100%", height }}>{mounted ? children : null}</div>;
}

const axisProps = { stroke: AXIS, fontSize: 11, tickLine: false, axisLine: false } as const;
const tooltipStyle = { borderRadius: 10, border: "1px solid #e3e5e8", fontSize: 12, boxShadow: "0 2px 8px rgba(0,0,0,0.08)" };

export function TrendChart({ data }: { data: Array<{ day: string; events: number; carts: number; orders: number }> }) {
  return (
    <ClientOnly height={220}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="gEvents" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#5C6AC4" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#5C6AC4" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="day" {...axisProps} />
          <YAxis {...axisProps} allowDecimals={false} width={34} />
          <Tooltip contentStyle={tooltipStyle} />
          <Area type="monotone" dataKey="events" name="Events" stroke="#5C6AC4" strokeWidth={2} fill="url(#gEvents)" />
          <Area type="monotone" dataKey="carts" name="Add to cart" stroke="#47C1BF" strokeWidth={2} fill="none" />
          <Area type="monotone" dataKey="orders" name="Orders" stroke="#50B83C" strokeWidth={2} fill="none" />
        </AreaChart>
      </ResponsiveContainer>
    </ClientOnly>
  );
}

export function FunnelBars({ data }: { data: Array<{ label: string; count: number }> }) {
  return (
    <ClientOnly height={220}>
      <ResponsiveContainer>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 24, bottom: 0 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" {...axisProps} allowDecimals={false} />
          <YAxis type="category" dataKey="label" {...axisProps} width={92} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f6f6f7" }} />
          <Bar dataKey="count" name="Count" radius={[0, 6, 6, 0]} barSize={18}>
            {data.map((_, i) => <Cell key={i} fill={PALETTE[0]} fillOpacity={1 - i * 0.13} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ClientOnly>
  );
}

// Horizontal bars: full-length labels, no rotated text, height scales with rows.
export function CategoryBars({ data }: { data: Array<{ name: string; value: number }> }) {
  const rows = data.slice(0, 8);
  return (
    <ClientOnly height={Math.max(120, rows.length * 34 + 24)}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={GRID} horizontal={false} />
          <XAxis type="number" {...axisProps} allowDecimals={false} />
          <YAxis type="category" dataKey="name" {...axisProps} width={150} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f6f6f7" }} />
          <Bar dataKey="value" name="Count" radius={[0, 6, 6, 0]} barSize={18} fill={PALETTE[0]} />
        </BarChart>
      </ResponsiveContainer>
    </ClientOnly>
  );
}

export function AssistantChart({ spec }: { spec: ChartSpec }) {
  if (!spec?.data?.length) return null;
  const xKey = spec.xKey || "name";
  const series = spec.series && spec.series.length ? spec.series : ["value"];
  return (
    <div style={{ marginTop: 10, border: "1px solid #e3e5e8", borderRadius: 12, padding: "10px 12px 6px", background: "#fff" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 }}>{spec.title}</div>
      <ClientOnly height={210}>
        <ResponsiveContainer>
          {spec.kind === "line" ? (
            <LineChart data={spec.data} margin={{ top: 6, right: 10, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey={xKey} {...axisProps} />
              <YAxis {...axisProps} allowDecimals={false} width={34} />
              <Tooltip contentStyle={tooltipStyle} />
              {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {series.map((s, i) => <Line key={s} type="monotone" dataKey={s} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />)}
            </LineChart>
          ) : spec.kind === "pie" ? (
            <PieChart>
              <Pie data={spec.data} dataKey={series[0]} nameKey={xKey} innerRadius={46} outerRadius={76} paddingAngle={2} label={(e: any) => e[xKey]}>
                {spec.data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          ) : (
            <BarChart data={spec.data} margin={{ top: 6, right: 10, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey={xKey} {...axisProps} interval={0} angle={-15} textAnchor="end" height={46} />
              <YAxis {...axisProps} allowDecimals={false} width={34} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "#f6f6f7" }} />
              {series.map((s, i) => <Bar key={s} dataKey={s} radius={[6, 6, 0, 0]} barSize={24} fill={PALETTE[i % PALETTE.length]} />)}
            </BarChart>
          )}
        </ResponsiveContainer>
      </ClientOnly>
    </div>
  );
}

// Donut with a side legend — floating labels overflowed the aside column.
export function Donut({ data }: { data: Array<{ name: string; value: number }> }) {
  if (!data.length) return null;
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ flex: "0 0 150px", minWidth: 0 }}>
        <ClientOnly height={150}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={40} outerRadius={64} paddingAngle={2}>
                {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} />
            </PieChart>
          </ResponsiveContainer>
        </ClientOnly>
      </div>
      <div style={{ fontSize: 12, color: "#374151", minWidth: 120 }}>
        {data.slice(0, 6).map((d, i) => (
          <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: PALETTE[i % PALETTE.length], flexShrink: 0 }} />
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</span>
            <span style={{ marginLeft: "auto", color: "#8c9196" }}>{Math.round((d.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
