import { useMemo } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@workspace/ui/components/chart"
import type { TrendPoint } from "@/features/dashboard/api"

/**
 * 30-day stacked area of open-vulnerability counts by severity, summed across
 * projects. Colors come from the validated chart-severity fill palette (see
 * globals.css); days without a successful scan render as gaps, not zeros.
 * Stacking is baseline-up in severity order so critical stays anchored and
 * easiest to read.
 */
const chartConfig = {
  critical: {
    label: "Critical",
    color: "var(--color-chart-severity-critical)",
  },
  high: { label: "High", color: "var(--color-chart-severity-high)" },
  moderate: {
    label: "Moderate",
    color: "var(--color-chart-severity-moderate)",
  },
  low: { label: "Low", color: "var(--color-chart-severity-low)" },
} satisfies ChartConfig

const SERIES = ["critical", "high", "moderate", "low"] as const

/**
 * The API sends `YYYY-MM-DD` strings, but Eden treaty's response parser
 * revives ISO-like strings into Date objects — accept both.
 */
function formatTick(value: unknown): string {
  const d =
    value instanceof Date
      ? value
      : new Date(
          /^\d{4}-\d{2}-\d{2}$/.test(String(value))
            ? `${String(value)}T00:00:00Z`
            : String(value)
        )
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

export function VulnTrendChart({ trend }: { trend: TrendPoint[] }) {
  const hasAnyData = useMemo(
    () => trend.some((point) => point.critical !== null),
    [trend]
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-heading text-base">
          Open vulnerabilities · 30 days
        </CardTitle>
        <CardDescription>
          Daily totals across all projects, from each project's last successful
          scan of the day. Gaps are days without a scan.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasAnyData ? (
          <ChartContainer config={chartConfig} className="h-56 w-full">
            <AreaChart
              data={trend}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid vertical={false} strokeOpacity={0.35} />
              <XAxis
                dataKey="date"
                tickFormatter={formatTick}
                tickLine={false}
                axisLine={false}
                minTickGap={48}
                tickMargin={8}
              />
              <YAxis
                width={36}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <ChartTooltip
                cursor={{ strokeOpacity: 0.4 }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatTick(value)}
                  />
                }
              />
              {SERIES.map((key) => (
                <Area
                  key={key}
                  dataKey={key}
                  type="monotone"
                  stackId="severity"
                  fill={`var(--color-${key})`}
                  fillOpacity={0.9}
                  stroke="var(--background)"
                  strokeWidth={1.5}
                  connectNulls={false}
                  // An area needs two consecutive days to draw anything, so a
                  // day of data surrounded by scan-less gaps would be
                  // invisible — mark ONLY isolated points with a dot. Once
                  // history accumulates the dots disappear.
                  dot={(props) => {
                    const { index, cx, cy } = props as {
                      index?: number
                      cx?: number
                      cy?: number
                    }
                    const i = index ?? 0
                    const isIsolated =
                      trend[i]?.[key] !== null &&
                      (i === 0 || trend[i - 1]?.[key] === null) &&
                      (i === trend.length - 1 || trend[i + 1]?.[key] === null)
                    if (!isIsolated || cx === undefined || cy === undefined) {
                      return <g key={`${key}-${i}`} />
                    }
                    return (
                      <circle
                        key={`${key}-${i}`}
                        cx={cx}
                        cy={cy}
                        r={3}
                        fill={`var(--color-${key})`}
                      />
                    )
                  }}
                />
              ))}
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No scan history yet — the trend fills in as scans run.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
