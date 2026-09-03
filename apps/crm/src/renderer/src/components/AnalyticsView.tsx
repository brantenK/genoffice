import React from 'react'
import type { CrmStats, Deal } from '../../../shared/types'

interface AnalyticsViewProps {
  stats: CrmStats
  deals: Deal[]
}

export function AnalyticsView({ stats, deals }: AnalyticsViewProps) {
  const avgDealSize = stats.totalDeals > 0 ? Math.round(stats.totalPipelineValue / stats.totalDeals) : 0

  const stageBreakdown = [
    { stage: 'lead', label: 'Lead Generation', color: '#64748b' },
    { stage: 'qualified', label: 'Qualification', color: '#0284c7' },
    { stage: 'proposal', label: 'Proposal Submitted', color: '#d97706' },
    { stage: 'negotiation', label: 'Contract Review', color: '#7c3aed' },
    { stage: 'won', label: 'Closed Won', color: '#059669' },
    { stage: 'lost', label: 'Closed Lost', color: '#dc2626' },
  ].map((item) => {
    const list = deals.filter((d) => d.stage === item.stage)
    const val = list.reduce((sum, d) => sum + (d.amount || 0), 0)
    const pct = stats.totalPipelineValue > 0 ? Math.round((val / stats.totalPipelineValue) * 100) : 0
    return { ...item, count: list.length, value: val, pct }
  })

  return (
    <div className="crm-analytics-container">
      {/* Metric Cards Grid */}
      <div className="crm-stat-cards-grid">
        <div className="crm-stat-card">
          <div className="crm-stat-title">Total Pipeline Value</div>
          <div className="crm-stat-number">${stats.totalPipelineValue.toLocaleString()}</div>
          <div className="crm-stat-sub">Across {stats.totalDeals} active opportunities</div>
        </div>

        <div className="crm-stat-card">
          <div className="crm-stat-title">Closed Won Revenue</div>
          <div className="crm-stat-number" style={{ color: '#059669' }}>
            ${stats.wonValue.toLocaleString()}
          </div>
          <div className="crm-stat-sub">Confirmed signed contracts</div>
        </div>

        <div className="crm-stat-card">
          <div className="crm-stat-title">Win Rate</div>
          <div className="crm-stat-number" style={{ color: '#6366f1' }}>
            {stats.winRatePct}%
          </div>
          <div className="crm-stat-sub">Of closed deal outcomes</div>
        </div>

        <div className="crm-stat-card">
          <div className="crm-stat-title">Average Deal Size</div>
          <div className="crm-stat-number">${avgDealSize.toLocaleString()}</div>
          <div className="crm-stat-sub">Per registered opportunity</div>
        </div>
      </div>

      {/* Stage Breakdown Progress Bars */}
      <div className="crm-chart-card">
        <div className="crm-chart-header">
          <div className="crm-chart-title">Pipeline Stage Distribution</div>
          <div style={{ fontSize: '12px', color: 'var(--crm-text-muted)' }}>
            Total Value: ${stats.totalPipelineValue.toLocaleString()}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {stageBreakdown.map((item) => (
            <div key={item.stage} className="crm-progress-row">
              <div className="crm-progress-label-wrap">
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      backgroundColor: item.color,
                      display: 'inline-block',
                    }}
                  />
                  <span>
                    {item.label} ({item.count} deals)
                  </span>
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                  ${item.value.toLocaleString()} ({item.pct}%)
                </span>
              </div>
              <div className="crm-progress-track">
                <div
                  className="crm-progress-fill"
                  style={{
                    width: `${Math.max(item.pct, item.count > 0 ? 2 : 0)}%`,
                    backgroundColor: item.color,
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
