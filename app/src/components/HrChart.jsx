import { useTranslation } from 'react-i18next'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  YAxis,
  Tooltip,
  ReferenceLine,
} from 'recharts'

/**
 * Live HR chart during recording.
 * data: [{ t: number, hr: number }]
 * stats: { min, avg, max }
 */
export default function HrChart({ data, stats }) {
  const { t } = useTranslation()

  if (!data || data.length === 0) {
    return (
      <div style={{
        height: 160,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-4)',
        fontSize: '.9rem',
        background: 'var(--bg-input)',
        borderRadius: 'var(--r-md)',
        border: '1.5px dashed var(--border-strong)',
      }}>
        {t('chart.waiting')}
      </div>
    )
  }

  const avg = stats?.avg
  const domain = avg
    ? [Math.max(30, Math.round(avg - 28)), Math.round(avg + 28)]
    : ['auto', 'auto']

  return (
    <div style={{ background: 'var(--bg-card)', borderRadius: 'var(--r-md)', padding: '12px 4px 4px', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
      <ResponsiveContainer width="100%" height={155}>
        <AreaChart data={data} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
          <defs>
            <linearGradient id="hrFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor="#2BBDBD" stopOpacity={0.18} />
              <stop offset="95%" stopColor="#2BBDBD" stopOpacity={0}    />
            </linearGradient>
          </defs>

          <YAxis
            domain={domain}
            tick={{ fill: 'var(--text-4)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />

          <Tooltip
            contentStyle={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              color: 'var(--text-2)',
              fontSize: 13,
              boxShadow: 'var(--shadow-md)',
            }}
            formatter={v => [`${v} bpm`, 'FC']}
            labelFormatter={l => `${l}s`}
            cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1.5 }}
          />

          {avg && (
            <ReferenceLine
              y={avg}
              stroke="var(--border-strong)"
              strokeDasharray="5 4"
              strokeWidth={1.5}
            />
          )}

          <Area
            type="monotone"
            dataKey="hr"
            stroke="#2BBDBD"
            strokeWidth={2.5}
            fill="url(#hrFill)"
            dot={false}
            activeDot={{ r: 4, fill: '#2BBDBD', strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>

      {stats && (avg != null) && (
        <div style={{ display: 'flex', justifyContent: 'space-around', padding: '4px 8px 8px' }}>
          {[
            { label: t('chart.min'), value: stats.min },
            { label: t('chart.avg'), value: avg },
            { label: t('chart.max'), value: stats.max },
          ].map(({ label, value }) => (
            <div key={label} style={{ textAlign: 'center' }}>
              <div style={{ color: 'var(--text-4)', fontSize: '.72rem', fontWeight: 500 }}>{label}</div>
              <div style={{ color: 'var(--text-2)', fontSize: '1rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                {value != null ? Math.round(value) : '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
