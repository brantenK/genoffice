import React from 'react'
import type { CrmStats, Deal } from '../../../shared/types'

interface AnalyticsViewProps {
  stats: CrmStats
  deals: Deal[]
}

export function AnalyticsView({ stats, deals }: AnalyticsViewProps) {
  const avgDealSize = stats.totalDeals > 0 ? Math.round(stats.totalPipelineValue / stats.totalDeals) : 0

  const stageBreakdown = [
    { stage: 'lead', label: 'Lead Generation', color: '#94a3b8' },
    { stage: 'qualified', label: 'Qualification', color: '#38bdf8' },
    { stage: 'proposal', label: 'Proposal Submitted', color: '#fbbf24' },
    { stage: 'negotiation', label: 'Contract Review', color: '#f97316' },
    { stage: 'won', label: 'Closed Won', color: '#22c55e' },
    { stage: 'lost', label: 'Closed Lost', color: '#ef4444' },
  ].map((item) => {
    const list = deals.filter((d) => d.stage === item.stage)
    const val = list.reduce((sum, d) => sum + (d.amount || 0), 0)
    const pct = stats.totalPipelineValue > 0 ? Math.round((val / stats.totalPipelineValue) * 100) : 0
    return { ...item, count: list.length, value: val, pct }
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Metric Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
        <div className="crm-table-container" style={{ padding: '20px' }}>
          <div className="crm-stat-label">Total Pipeline Value</div>
          <div style={{ fontSize: '26px', fontWeight: 800, marginTop: '8px', color: 'var(--text-primary)' }}>
            ${stats.totalPipelineValue.toLocaleString()}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Across {stats.totalDeals} active opportunities
          </div>
        </div>

        <div className="crm-table-container" style={{ padding: '20px' }}>
          <div className="crm-stat-label">Closed Won Revenue</div>
          <div style={{ fontSize: '26px', fontWeight: 800, marginTop: '8px', color: '#16a34a' }}>
            ${stats.wonValue.toLocaleString()}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Confirmed signed contracts
          </div>
        </div>

        <div className="crm-table-container" style={{ padding: '20px' }}>
          <div className="crm-stat-label">Win Rate</div>
          <div style={{ fontSize: '26px', fontWeight: 800, marginTop: '8px', color: '#6366f1' }}>
            {stats.winRatePct}%
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Of closed deal outcomes
          </div>
        </div>

        <div className="crm-table-container" style={{ padding: '20px' }}>
          <div className="crm-stat-label">Average Opportunity Size</div>
          <div style={{ fontSize: '26px', fontWeight: 800, marginTop: '8px', color: 'var(--text-primary)' }}>
            ${avgDealSize.toLocaleString()}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Per registered opportunity
          </div>
        </div>
      </div>

      {/* Stage Breakdown Progress Bars */}
      <div className="crm-table-container" style={{ padding: '24px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '16px', color: 'var(--text-primary)' }}>
          Pipeline Stage Distribution
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {stageBreakdown.map((item) => (
            <div key={item.stage}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '6px' }}>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {item.label} ({item.count} deals)
                </span>
                <span style={{ fontWeight: 700, color: 'var(--text-secondary)' }}>
                  ${item.value.toLocaleString()} ({item.pct}%)
                </span>
              </div>
              <div
                style={{
                  height: '8px',
                  background: 'var(--surface-subtle)',
                  borderRadius: '4px',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.max(item.pct, 2)}%`,
                    backgroundColor: item.color,
                    borderRadius: '4px',
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
