import React, { useEffect, useState, useTransition } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  HelpCircle,
  Info,
  Layers,
  RotateCcw,
  ShieldAlert,
  Table as TableIcon,
  TrendingUp,
  UserCheck,
  Users,
  XCircle,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AnalyticsDashboardData,
  AnalyticsFilters,
  AnalyticsPeriod,
  DEFAULT_ANALYTICS_FILTERS,
  downloadAnalyticsCsv,
  fetchDashboardAnalytics,
  formatPercentageChange,
  formatRate,
  formatResolutionTime,
} from './analytics.js';
import { apiRequest } from './api.js';
import { RecordFilters } from './record-listing.js';

interface DashboardPageProps {
  onNavigateToRecords: (filters: Partial<RecordFilters>) => void;
}

type CatalogOption = { id: string; name: string };

const STATUS_COLORS: Record<string, string> = {
  PENDING: '#b77912',     // Amarelo/âmbar
  IN_PROGRESS: '#176fae', // Azul
  COMPLETED: '#14845a',   // Verde
  CANCELLED: '#7f8fa3',   // Cinza
};

const PRIORITY_COLORS: Record<string, string> = {
  LOW: '#14845a',
  MEDIUM: '#176fae',
  HIGH: '#dc5d32',
  CRITICAL: '#b4233f',
};

class DashboardErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Erro de renderização capturado no Dashboard:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="analytics-empty-state" role="alert" style={{ margin: '2rem' }}>
          <AlertTriangle aria-hidden="true" />
          <h3>Erro ao renderizar painel</h3>
          <p>{this.state.error?.message ?? 'Ocorreu um erro inesperado ao exibir o painel de métricas.'}</p>
          <button
            type="button"
            className="btn-export-csv"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Tentar novamente
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function DashboardPage(props: DashboardPageProps) {
  return (
    <DashboardErrorBoundary>
      <DashboardView {...props} />
    </DashboardErrorBoundary>
  );
}

function DashboardView({ onNavigateToRecords }: DashboardPageProps) {
  const [filters, setFilters] = useState<AnalyticsFilters>(DEFAULT_ANALYTICS_FILTERS);
  const [data, setData] = useState<AnalyticsDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Catalog select options
  const [reasons, setReasons] = useState<CatalogOption[]>([]);
  const [subreasons, setSubreasons] = useState<CatalogOption[]>([]);
  const [channels, setChannels] = useState<CatalogOption[]>([]);

  // Accessible table toggles for charts
  const [showEvolutionTable, setShowEvolutionTable] = useState(false);
  const [showStatusTable, setShowStatusTable] = useState(false);
  const [showPriorityTable, setShowPriorityTable] = useState(false);
  const [showReasonsTable, setShowReasonsTable] = useState(false);
  const [showSubreasonsTable, setShowSubreasonsTable] = useState(false);
  const [showChannelsTable, setShowChannelsTable] = useState(false);
  const [showAgingTable, setShowAgingTable] = useState(false);

  // Load catalog options once
  useEffect(() => {
    let active = true;
    Promise.all([
      apiRequest<{ items: CatalogOption[] }>('/catalog/reasons?status=active&pageSize=100').catch(() => ({ items: [] })),
      apiRequest<{ items: CatalogOption[] }>('/catalog/channels?status=active&pageSize=100').catch(() => ({ items: [] })),
    ]).then(([reasonsRes, channelsRes]) => {
      if (active) {
        setReasons(reasonsRes.items);
        setChannels(channelsRes.items);
      }
    });
    return () => { active = false; };
  }, []);

  // Load subreasons when reason filter changes
  useEffect(() => {
    let active = true;
    const url = filters.reasonId
      ? `/catalog/subreasons?status=active&reasonId=${filters.reasonId}&pageSize=100`
      : '/catalog/subreasons?status=active&pageSize=100';

    apiRequest<{ items: CatalogOption[] }>(url)
      .then(res => {
        if (active) setSubreasons(res.items);
      })
      .catch(() => {
        if (active) setSubreasons([]);
      });
    return () => { active = false; };
  }, [filters.reasonId]);

  // Fetch Dashboard Analytics with AbortController
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchDashboardAnalytics(filters, controller.signal)
      .then(dashboardData => {
        startTransition(() => {
          setData(dashboardData);
          setLoading(false);
        });
      })
      .catch(err => {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Falha ao carregar métricas operacionais.');
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [filters]);

  const handlePeriodChange = (period: AnalyticsPeriod) => {
    setFilters(prev => ({
      ...prev,
      period,
      // If switching away from custom, clear custom dates
      ...(period !== 'custom' ? { startDate: undefined, endDate: undefined } : {}),
    }));
  };

  const handleExportCsv = async () => {
    try {
      setExporting(true);
      await downloadAnalyticsCsv(filters);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro ao exportar CSV.');
    } finally {
      setExporting(false);
    }
  };

  const clearAllFilters = () => {
    setFilters(DEFAULT_ANALYTICS_FILTERS);
  };

  const isCustom = filters.period === 'custom';
  const hasSpecificFilters = Boolean(
    filters.reasonId || filters.subreasonId || filters.channelId || filters.priority || filters.status || filters.startDate || filters.endDate
  );

  const statusDistribution = data?.distributions?.byStatus ?? [];
  const priorityDistribution = data?.distributions?.byPriority ?? [];
  const channelsDistribution = data?.distributions?.byChannel ?? [];
  const topReasons = data?.distributions?.topReasons ?? [];
  const topSubreasons = data?.distributions?.topSubreasons ?? [];
  const backlogAging = data?.distributions?.backlogAge ?? [];
  const timeSeries = data?.timeSeries ?? [];
  const teamPerformance = data?.teamPerformance ?? [];

  return (
    <div className="analytics-container" aria-label="Dashboard Operacional">
      {/* Page Header */}
      <div className="page-header">
        <div className="page-title">
          <div className="page-header-copy">
            <h1>Dashboards e Relatórios</h1>
            <p>Indicadores operacionais reais, análise de causas, SLA e produtividade da equipe.</p>
          </div>
        </div>
        <div className="analytics-header-actions">
          <button
            type="button"
            className="btn-export-csv"
            onClick={handleExportCsv}
            disabled={exporting || loading || Boolean(data?.isEmptyDatabase)}
            aria-label="Exportar relatório CSV em tempo real"
          >
            <Download aria-hidden="true" width={16} height={16} />
            {exporting ? 'Exportando...' : 'Exportar CSV'}
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <section className="analytics-filter-bar" aria-label="Filtros do dashboard">
        <div className="analytics-periods" role="radiogroup" aria-label="Seleção rápida de período">
          <button
            type="button"
            className={`period-pill ${filters.period === '7d' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('7d')}
            role="radio"
            aria-checked={filters.period === '7d'}
          >
            Últimos 7 dias
          </button>
          <button
            type="button"
            className={`period-pill ${filters.period === '30d' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('30d')}
            role="radio"
            aria-checked={filters.period === '30d'}
          >
            Últimos 30 dias
          </button>
          <button
            type="button"
            className={`period-pill ${filters.period === '90d' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('90d')}
            role="radio"
            aria-checked={filters.period === '90d'}
          >
            Últimos 3 meses
          </button>
          <button
            type="button"
            className={`period-pill ${filters.period === '6m' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('6m')}
            role="radio"
            aria-checked={filters.period === '6m'}
          >
            Últimos 6 meses
          </button>
          <button
            type="button"
            className={`period-pill ${filters.period === 'year' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('year')}
            role="radio"
            aria-checked={filters.period === 'year'}
          >
            Este ano
          </button>
          <button
            type="button"
            className={`period-pill ${filters.period === 'custom' ? 'active' : ''}`}
            onClick={() => handlePeriodChange('custom')}
            role="radio"
            aria-checked={filters.period === 'custom'}
          >
            Personalizado
          </button>
        </div>

        {isCustom && (
          <div className="analytics-filter-row" style={{ marginTop: '4px' }}>
            <div className="analytics-filter-field">
              <label htmlFor="analytics-date-start">Data inicial</label>
              <input
                id="analytics-date-start"
                type="date"
                value={filters.startDate ?? ''}
                onChange={e => setFilters(prev => ({ ...prev, startDate: e.target.value || undefined }))}
              />
            </div>
            <div className="analytics-filter-field">
              <label htmlFor="analytics-date-end">Data final</label>
              <input
                id="analytics-date-end"
                type="date"
                value={filters.endDate ?? ''}
                onChange={e => setFilters(prev => ({ ...prev, endDate: e.target.value || undefined }))}
              />
            </div>
          </div>
        )}

        <div className="analytics-filter-row">
          <div className="analytics-filter-field">
            <label htmlFor="analytics-filter-reason">Motivo</label>
            <select
              id="analytics-filter-reason"
              value={filters.reasonId ?? ''}
              onChange={e => setFilters(prev => ({ ...prev, reasonId: e.target.value || undefined, subreasonId: undefined }))}
            >
              <option value="">Todos os motivos</option>
              {reasons.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>

          <div className="analytics-filter-field">
            <label htmlFor="analytics-filter-subreason">Submotivo</label>
            <select
              id="analytics-filter-subreason"
              value={filters.subreasonId ?? ''}
              onChange={e => setFilters(prev => ({ ...prev, subreasonId: e.target.value || undefined }))}
            >
              <option value="">Todos os submotivos</option>
              {subreasons.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="analytics-filter-field">
            <label htmlFor="analytics-filter-channel">Canal</label>
            <select
              id="analytics-filter-channel"
              value={filters.channelId ?? ''}
              onChange={e => setFilters(prev => ({ ...prev, channelId: e.target.value || undefined }))}
            >
              <option value="">Todos os canais</option>
              {channels.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          <div className="analytics-filter-field">
            <label htmlFor="analytics-filter-priority">Prioridade</label>
            <select
              id="analytics-filter-priority"
              value={filters.priority ?? ''}
              onChange={e => setFilters(prev => ({ ...prev, priority: (e.target.value as AnalyticsFilters['priority']) || undefined }))}
            >
              <option value="">Todas as prioridades</option>
              <option value="LOW">Baixa</option>
              <option value="MEDIUM">Média</option>
              <option value="HIGH">Alta</option>
              <option value="CRITICAL">Crítica</option>
            </select>
          </div>

          <div className="analytics-filter-field">
            <label htmlFor="analytics-filter-status">Status operacional</label>
            <select
              id="analytics-filter-status"
              value={filters.status ?? ''}
              onChange={e => setFilters(prev => ({ ...prev, status: (e.target.value as AnalyticsFilters['status']) || undefined }))}
            >
              <option value="">Todos os status</option>
              <option value="PENDING">Pendente</option>
              <option value="IN_PROGRESS">Em andamento</option>
              <option value="COMPLETED">Concluído</option>
              <option value="CANCELLED">Cancelado</option>
            </select>
          </div>

          {hasSpecificFilters && (
            <button
              type="button"
              className="period-pill"
              onClick={clearAllFilters}
              style={{ height: '36px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <RotateCcw width={14} height={14} />
              Limpar filtros
            </button>
          )}
        </div>

        {filters.status && (
          <div className="status-semantics-note" role="note">
            <Info aria-hidden="true" />
            <span>
              <strong>Filtro de status ativo:</strong> A situação operacional atual reflete casos em status{' '}
              <em>{filters.status === 'PENDING' ? 'Pendente' : filters.status === 'IN_PROGRESS' ? 'Em andamento' : filters.status === 'COMPLETED' ? 'Concluído' : 'Cancelado'}</em>.
              As séries históricas refletem a movimentação auditada sem reescrever eventos passados.
            </span>
          </div>
        )}
      </section>

      {/* Error State */}
      {error && (
        <div className="analytics-empty-state" role="alert">
          <AlertTriangle />
          <h3>Erro ao processar dados analíticos</h3>
          <p>{error}</p>
          <button type="button" className="btn-export-csv" onClick={() => setFilters({ ...filters })}>
            Tentar novamente
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && !error && (
        <div className="analytics-container" aria-busy="true" aria-label="Carregando dados analíticos">
          <div className="kpi-grid-movement">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="analytics-skeleton skeleton-kpi" />
            ))}
          </div>
          <div className="charts-grid-analytics">
            <div className="chart-card-full-width analytics-skeleton skeleton-chart" />
            <div className="analytics-skeleton skeleton-chart" />
            <div className="analytics-skeleton skeleton-chart" />
          </div>
        </div>
      )}

      {/* Empty Database State */}
      {!loading && !error && data?.isEmptyDatabase && (
        <div className="analytics-empty-state">
          <BarChart3 />
          <h3>Ainda não existem ocorrências registradas no sistema</h3>
          <p>Os indicadores e gráficos serão gerados automaticamente assim que as primeiras ocorrências forem cadastradas na plataforma.</p>
        </div>
      )}

      {/* Loaded Dashboard Content */}
      {!loading && !error && data && !data.isEmptyDatabase && (
        <>
          {/* Section 1: Movimentação no Período */}
          <div className="analytics-section-header">
            <h2>Movimentação no Período Selecionado</h2>
            <span>Comparado ao período anterior de igual duração</span>
          </div>

          <div className="kpi-grid-movement">
            {/* Casos Abertos */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({})}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({})}
              title="Clique para ver os registros correspondentes"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Casos Abertos</span>
                <span className="kpi-icon-wrap"><Layers width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{data.metrics.openedInPeriod.current}</span>
                <ComparisonBadge metric={data.metrics.openedInPeriod} isInverse={false} />
              </div>
              <span className="kpi-card-footer">
                Período anterior: {data.metrics.openedInPeriod.previous} casos
              </span>
            </div>

            {/* Casos Concluídos */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({ status: 'Concluído' })}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({ status: 'Concluído' })}
              title="Clique para ver os casos concluídos"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Casos Concluídos</span>
                <span className="kpi-icon-wrap" style={{ color: 'var(--color-success)' }}><CheckCircle2 width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{data.metrics.completedInPeriod.current}</span>
                <ComparisonBadge metric={data.metrics.completedInPeriod} isInverse={false} />
              </div>
              <span className="kpi-card-footer">
                Período anterior: {data.metrics.completedInPeriod.previous} casos
              </span>
            </div>

            {/* Casos Cancelados */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({ status: 'Cancelado' })}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({ status: 'Cancelado' })}
              title="Clique para ver os casos cancelados"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Casos Cancelados</span>
                <span className="kpi-icon-wrap"><XCircle width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{data.metrics.cancelledInPeriod.current}</span>
                <ComparisonBadge metric={data.metrics.cancelledInPeriod} isInverse={true} />
              </div>
              <span className="kpi-card-footer">
                Período anterior: {data.metrics.cancelledInPeriod.previous} casos
              </span>
            </div>

            {/* Tempo Médio de Resolução */}
            <div className="kpi-card">
              <div className="kpi-card-header">
                <span className="kpi-title">Tempo Médio de Resolução</span>
                <span className="kpi-icon-wrap"><Clock width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{formatResolutionTime(data.metrics.avgResolutionSeconds.current)}</span>
                {data.metrics.avgResolutionSeconds.changeSeconds !== null && (
                  <span className={`kpi-comparison-badge ${data.metrics.avgResolutionSeconds.changeSeconds <= 0 ? 'kpi-badge-positive' : 'kpi-badge-negative'}`}>
                    {data.metrics.avgResolutionSeconds.changeSeconds <= 0 ? <ArrowDownRight width={12} height={12} /> : <ArrowUpRight width={12} height={12} />}
                    {formatResolutionTime(Math.abs(data.metrics.avgResolutionSeconds.changeSeconds))}
                  </span>
                )}
              </div>
              <span className="kpi-card-footer">
                Período anterior: {formatResolutionTime(data.metrics.avgResolutionSeconds.previous)}
              </span>
            </div>

            {/* SLA Compliance */}
            <div className="kpi-card">
              <div className="kpi-card-header">
                <span className="kpi-title">Conformidade com SLA</span>
                <span className="kpi-icon-wrap"><TrendingUp width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{formatRate(data.metrics.slaCompliance.currentRate)}</span>
                {data.metrics.slaCompliance.rateChange !== null && (
                  <span className={`kpi-comparison-badge ${data.metrics.slaCompliance.rateChange >= 0 ? 'kpi-badge-positive' : 'kpi-badge-negative'}`}>
                    {data.metrics.slaCompliance.rateChange >= 0 ? <ArrowUpRight width={12} height={12} /> : <ArrowDownRight width={12} height={12} />}
                    {formatRate(Math.abs(data.metrics.slaCompliance.rateChange))}
                  </span>
                )}
              </div>
              <span className="kpi-card-footer">
                {data.metrics.slaCompliance.onTimeCount} no prazo · {data.metrics.slaCompliance.lateCount} fora do prazo
              </span>
            </div>
          </div>

          {/* Section 2: Situação Operacional Atual */}
          <div className="analytics-section-header" style={{ marginTop: 'var(--space-4)' }}>
            <h2>Situação Operacional Atual</h2>
            <span>Posição em tempo real da base de casos ativos</span>
          </div>

          <div className="kpi-grid-snapshot">
            {/* Pendentes */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({ status: 'Pendente' })}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({ status: 'Pendente' })}
              title="Clique para ver chamados pendentes"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Pendentes</span>
                <span className="kpi-icon-wrap" style={{ color: 'var(--color-warning)' }}><Clock width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{data.metrics.currentPending}</span>
              </div>
              <span className="kpi-card-footer">Aguardando início do atendimento</span>
            </div>

            {/* Em Andamento */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({ status: 'Em andamento' })}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({ status: 'Em andamento' })}
              title="Clique para ver chamados em andamento"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Em Andamento</span>
                <span className="kpi-icon-wrap" style={{ color: 'var(--color-info)' }}><TrendingUp width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{data.metrics.currentInProgress}</span>
              </div>
              <span className="kpi-card-footer">Em tratamento ativo</span>
            </div>

            {/* Atrasados */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({ attention: 'Atrasados' })}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({ attention: 'Atrasados' })}
              title="Clique para ver chamados atrasados"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Atrasados</span>
                <span className="kpi-icon-wrap" style={{ color: 'var(--color-danger)' }}><ShieldAlert width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value" style={{ color: data.metrics.currentOverdue > 0 ? 'var(--color-danger)' : undefined }}>
                  {data.metrics.currentOverdue}
                </span>
              </div>
              <span className="kpi-card-footer">Prazo de SLA excedido</span>
            </div>

            {/* Próximos do Prazo */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({ attention: 'Próximos do prazo' })}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({ attention: 'Próximos do prazo' })}
              title="Clique para ver casos próximos do vencimento"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Próximos do Prazo</span>
                <span className="kpi-icon-wrap" style={{ color: 'var(--color-warning-strong)' }}><Calendar width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{data.metrics.currentNearDue}</span>
              </div>
              <span className="kpi-card-footer">Vencem hoje ou nos próximos 2 dias</span>
            </div>

            {/* Sem Atualização */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({ attention: 'Sem atualização' })}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({ attention: 'Sem atualização' })}
              title="Clique para ver chamados sem atualização há mais de 3 dias"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Sem Atualização</span>
                <span className="kpi-icon-wrap"><AlertTriangle width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{data.metrics.currentStale}</span>
              </div>
              <span className="kpi-card-footer">Sem atividade há mais de 3 dias</span>
            </div>

            {/* Sem Responsável */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({ attention: 'Sem responsável' })}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({ attention: 'Sem responsável' })}
              title="Clique para ver chamados sem responsável"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Sem Responsável</span>
                <span className="kpi-icon-wrap"><UserCheck width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{data.metrics.currentUnassigned}</span>
              </div>
              <span className="kpi-card-footer">Casos abertos não atribuídos</span>
            </div>

            {/* Alta ou Crítica */}
            <div
              className="kpi-card"
              tabIndex={0}
              role="button"
              onClick={() => onNavigateToRecords({ priority: 'Alta' })}
              onKeyDown={e => e.key === 'Enter' && onNavigateToRecords({ priority: 'Alta' })}
              title="Clique para ver chamados de alta e crítica prioridade"
            >
              <div className="kpi-card-header">
                <span className="kpi-title">Alta ou Crítica</span>
                <span className="kpi-icon-wrap" style={{ color: 'var(--color-danger)' }}><AlertTriangle width={16} height={16} /></span>
              </div>
              <div className="kpi-value-row">
                <span className="kpi-value">{data.metrics.currentHighOrCritical}</span>
              </div>
              <span className="kpi-card-footer">Casos de maior severidade</span>
            </div>
          </div>

          {/* Section 3: Visualizações Gráficas e Tabelas Acessíveis */}
          <div className="charts-grid-analytics">
            {/* 1. Evolução Temporal de Abertura vs Conclusão */}
            <div className="chart-card-analytics chart-card-full-width">
              <div className="chart-card-header">
                <div>
                  <h3>Evolução Temporal: Abertura vs. Conclusão</h3>
                  <p>Granularidade automática ({data.period.granularity === 'day' ? 'diária' : data.period.granularity === 'week' ? 'semanal' : 'mensal'}) com preenchimento contínuo</p>
                </div>
                <div className="chart-card-actions">
                  <button
                    type="button"
                    className="btn-toggle-table"
                    onClick={() => setShowEvolutionTable(v => !v)}
                    aria-label="Alternar exibição entre gráfico e tabela acessível"
                  >
                    <TableIcon width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '4px' }} />
                    {showEvolutionTable ? 'Ver gráfico' : 'Tabela de dados'}
                  </button>
                </div>
              </div>
              <div className="chart-body-analytics">
                {showEvolutionTable ? (
                  <div className="accessible-chart-table-wrap">
                    <table className="accessible-chart-table">
                      <thead>
                        <tr>
                          <th>Período</th>
                          <th>Abertos</th>
                          <th>Concluídos</th>
                        </tr>
                      </thead>
                      <tbody>
                        {timeSeries.map(row => (
                          <tr key={row.key}>
                            <td>{row.label}</td>
                            <td>{row.opened}</td>
                            <td>{row.completed}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : timeSeries.length === 0 ? (
                  <span className="text-caption">Sem movimentação no período selecionado.</span>
                ) : (
                  <ResponsiveContainer width="100%" height={290} minWidth={100} minHeight={290}>
                    <AreaChart data={timeSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="colorOpened" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#d00063" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#d00063" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="colorCompleted" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#14845a" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#14845a" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }} />
                      <Legend />
                      <Area type="monotone" dataKey="opened" name="Casos Abertos" stroke="#d00063" strokeWidth={2} fillOpacity={1} fill="url(#colorOpened)" />
                      <Area type="monotone" dataKey="completed" name="Casos Concluídos" stroke="#14845a" strokeWidth={2} fillOpacity={1} fill="url(#colorCompleted)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* 2. Distribuição por Status (Donut com poucas categorias, ou barras caso cresça) */}
            <div className="chart-card-analytics">
              <div className="chart-card-header">
                <div>
                  <h3>Casos por Status</h3>
                  <p>Distribuição operacional proporcional</p>
                </div>
                <div className="chart-card-actions">
                  <button
                    type="button"
                    className="btn-toggle-table"
                    onClick={() => setShowStatusTable(v => !v)}
                  >
                    <TableIcon width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '4px' }} />
                    {showStatusTable ? 'Ver gráfico' : 'Tabela'}
                  </button>
                </div>
              </div>
              <div className="chart-body-analytics">
                {showStatusTable ? (
                  <div className="accessible-chart-table-wrap">
                    <table className="accessible-chart-table">
                      <thead>
                        <tr>
                          <th>Status</th>
                          <th>Quantidade</th>
                          <th>Percentual</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statusDistribution.map(item => (
                          <tr key={item.status} onClick={() => onNavigateToRecords({ status: item.status === 'PENDING' ? 'Pendente' : item.status === 'IN_PROGRESS' ? 'Em andamento' : item.status === 'COMPLETED' ? 'Concluído' : 'Cancelado' })}>
                            <td>{item.label}</td>
                            <td>{item.count}</td>
                            <td>{formatRate(item.percentage)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : statusDistribution.length === 0 || statusDistribution.every(s => s.count === 0) ? (
                  <span className="text-caption">Sem ocorrências registradas para este filtro.</span>
                ) : statusDistribution.length <= 4 ? (
                  <ResponsiveContainer width="100%" height={260} minWidth={100} minHeight={260}>
                    <PieChart>
                      <Pie
                        data={statusDistribution}
                        dataKey="count"
                        nameKey="label"
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={90}
                        paddingAngle={4}
                        cursor="pointer"
                        onClick={(entry: any) => {
                          const statusKey = (entry?.status ?? entry?.nameKey) as string;
                          const statusMap: Record<string, 'Pendente' | 'Em andamento' | 'Concluído' | 'Cancelado'> = {
                            PENDING: 'Pendente',
                            IN_PROGRESS: 'Em andamento',
                            COMPLETED: 'Concluído',
                            CANCELLED: 'Cancelado',
                          };
                          if (statusMap[statusKey]) {
                            onNavigateToRecords({ status: statusMap[statusKey] });
                          }
                        }}
                      >
                        {statusDistribution.map(entry => (
                          <Cell key={entry.status} fill={STATUS_COLORS[entry.status] ?? '#64748b'} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  /* Fallback to bar chart if categories grow */
                  <ResponsiveContainer width="100%" height={260} minWidth={100} minHeight={260}>
                    <BarChart data={statusDistribution}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" />
                      <YAxis allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="count" name="Casos" fill="#176fae" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* 3. Distribuição por Prioridade */}
            <div className="chart-card-analytics">
              <div className="chart-card-header">
                <div>
                  <h3>Casos por Prioridade</h3>
                  <p>Volume classificado por severidade</p>
                </div>
                <div className="chart-card-actions">
                  <button
                    type="button"
                    className="btn-toggle-table"
                    onClick={() => setShowPriorityTable(v => !v)}
                  >
                    <TableIcon width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '4px' }} />
                    {showPriorityTable ? 'Ver gráfico' : 'Tabela'}
                  </button>
                </div>
              </div>
              <div className="chart-body-analytics">
                {showPriorityTable ? (
                  <div className="accessible-chart-table-wrap">
                    <table className="accessible-chart-table">
                      <thead>
                        <tr>
                          <th>Prioridade</th>
                          <th>Quantidade</th>
                          <th>Percentual</th>
                        </tr>
                      </thead>
                      <tbody>
                        {priorityDistribution.map(item => (
                          <tr key={item.priority} onClick={() => onNavigateToRecords({ priority: item.priority === 'LOW' ? 'Baixa' : item.priority === 'MEDIUM' ? 'Média' : item.priority === 'HIGH' ? 'Alta' : 'Crítica' })}>
                            <td>{item.label}</td>
                            <td>{item.count}</td>
                            <td>{formatRate(item.percentage)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : priorityDistribution.length === 0 || priorityDistribution.every(p => p.count === 0) ? (
                  <span className="text-caption">Sem ocorrências registradas para este filtro.</span>
                ) : (
                  <ResponsiveContainer width="100%" height={260} minWidth={100} minHeight={260}>
                    <BarChart data={priorityDistribution}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }} />
                      <Bar
                        dataKey="count"
                        name="Casos"
                        radius={[4, 4, 0, 0]}
                        cursor="pointer"
                        onClick={(entry: any) => {
                          const priorityKey = (entry?.priority ?? entry?.payload?.priority) as string;
                          const priorityMap: Record<string, 'Baixa' | 'Média' | 'Alta' | 'Crítica'> = {
                            LOW: 'Baixa',
                            MEDIUM: 'Média',
                            HIGH: 'Alta',
                            CRITICAL: 'Crítica',
                          };
                          if (priorityMap[priorityKey]) {
                            onNavigateToRecords({ priority: priorityMap[priorityKey] });
                          }
                        }}
                      >
                        {priorityDistribution.map(entry => (
                          <Cell key={entry.priority} fill={PRIORITY_COLORS[entry.priority] ?? '#176fae'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* 4. Principais Motivos */}
            <div className="chart-card-analytics">
              <div className="chart-card-header">
                <div>
                  <h3>Principais Motivos de Abertura</h3>
                  <p>Ranking de causas no período</p>
                </div>
                <div className="chart-card-actions">
                  <button
                    type="button"
                    className="btn-toggle-table"
                    onClick={() => setShowReasonsTable(v => !v)}
                  >
                    <TableIcon width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '4px' }} />
                    {showReasonsTable ? 'Ver gráfico' : 'Tabela'}
                  </button>
                </div>
              </div>
              <div className="chart-body-analytics">
                {showReasonsTable ? (
                  <div className="accessible-chart-table-wrap">
                    <table className="accessible-chart-table">
                      <thead>
                        <tr>
                          <th>Motivo</th>
                          <th>Quantidade</th>
                          <th>Percentual</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topReasons.map(item => (
                          <tr key={item.id} onClick={() => onNavigateToRecords({ reason: item.name })}>
                            <td>{item.name}</td>
                            <td>{item.count}</td>
                            <td>{formatRate(item.percentage)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : topReasons.length === 0 ? (
                  <span className="text-caption">Nenhum motivo registrado no período.</span>
                ) : (
                  <ResponsiveContainer width="100%" height={260} minWidth={100} minHeight={260}>
                    <BarChart data={topReasons} layout="vertical" margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-border)" />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }} />
                      <Bar
                        dataKey="count"
                        name="Ocorrências"
                        fill="#176fae"
                        radius={[0, 4, 4, 0]}
                        cursor="pointer"
                        onClick={(entry: any) => {
                          const reasonName = entry?.name ?? entry?.payload?.name;
                          if (reasonName) onNavigateToRecords({ reason: reasonName });
                        }}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* 5. Principais Submotivos */}
            <div className="chart-card-analytics">
              <div className="chart-card-header">
                <div>
                  <h3>Principais Submotivos</h3>
                  <p>Detalhamento de causas no período</p>
                </div>
                <div className="chart-card-actions">
                  <button
                    type="button"
                    className="btn-toggle-table"
                    onClick={() => setShowSubreasonsTable(v => !v)}
                  >
                    <TableIcon width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '4px' }} />
                    {showSubreasonsTable ? 'Ver gráfico' : 'Tabela'}
                  </button>
                </div>
              </div>
              <div className="chart-body-analytics">
                {showSubreasonsTable ? (
                  <div className="accessible-chart-table-wrap">
                    <table className="accessible-chart-table">
                      <thead>
                        <tr>
                          <th>Submotivo</th>
                          <th>Quantidade</th>
                          <th>Percentual</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topSubreasons.map(item => (
                          <tr key={item.id}>
                            <td>{item.name}</td>
                            <td>{item.count}</td>
                            <td>{formatRate(item.percentage)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : topSubreasons.length === 0 ? (
                  <span className="text-caption">Nenhum submotivo registrado no período.</span>
                ) : (
                  <ResponsiveContainer width="100%" height={260} minWidth={100} minHeight={260}>
                    <BarChart data={topSubreasons} layout="vertical" margin={{ left: 10, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--color-border)" />
                      <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }} />
                      <Bar dataKey="count" name="Ocorrências" fill="#d00063" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* 6. Canais de Atendimento */}
            <div className="chart-card-analytics">
              <div className="chart-card-header">
                <div>
                  <h3>Canais de Entrada</h3>
                  <p>Origem dos atendimentos registrados</p>
                </div>
                <div className="chart-card-actions">
                  <button
                    type="button"
                    className="btn-toggle-table"
                    onClick={() => setShowChannelsTable(v => !v)}
                  >
                    <TableIcon width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '4px' }} />
                    {showChannelsTable ? 'Ver gráfico' : 'Tabela'}
                  </button>
                </div>
              </div>
              <div className="chart-body-analytics">
                {showChannelsTable ? (
                  <div className="accessible-chart-table-wrap">
                    <table className="accessible-chart-table">
                      <thead>
                        <tr>
                          <th>Canal</th>
                          <th>Quantidade</th>
                          <th>Percentual</th>
                        </tr>
                      </thead>
                      <tbody>
                        {channelsDistribution.map(item => (
                          <tr key={item.id}>
                            <td>{item.name}</td>
                            <td>{item.count}</td>
                            <td>{formatRate(item.percentage)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : channelsDistribution.length === 0 ? (
                  <span className="text-caption">Nenhum canal registrado no período.</span>
                ) : (
                  <ResponsiveContainer width="100%" height={260} minWidth={100} minHeight={260}>
                    <BarChart data={channelsDistribution}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                      <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }} />
                      <Bar dataKey="count" name="Casos" fill="#14845a" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* 7. Idade do Backlog Ativo (Aging) */}
            <div className="chart-card-analytics">
              <div className="chart-card-header">
                <div>
                  <h3>Idade do Backlog Ativo (Aging)</h3>
                  <p>Tempo de permanência em aberto (Pendentes e Em Andamento)</p>
                </div>
                <div className="chart-card-actions">
                  <button
                    type="button"
                    className="btn-toggle-table"
                    onClick={() => setShowAgingTable(v => !v)}
                  >
                    <TableIcon width={13} height={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '4px' }} />
                    {showAgingTable ? 'Ver gráfico' : 'Tabela'}
                  </button>
                </div>
              </div>
              <div className="chart-body-analytics">
                {showAgingTable ? (
                  <div className="accessible-chart-table-wrap">
                    <table className="accessible-chart-table">
                      <thead>
                        <tr>
                          <th>Faixa de idade</th>
                          <th>Quantidade</th>
                          <th>Percentual</th>
                        </tr>
                      </thead>
                      <tbody>
                        {backlogAging.map(item => (
                          <tr key={item.range}>
                            <td>{item.range}</td>
                            <td>{item.count}</td>
                            <td>{formatRate(item.percentage)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : backlogAging.length === 0 || backlogAging.every(b => b.count === 0) ? (
                  <span className="text-caption">Nenhum caso ativo no backlog atualmente.</span>
                ) : (
                  <ResponsiveContainer width="100%" height={260} minWidth={100} minHeight={260}>
                    <BarChart data={backlogAging}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
                      <XAxis dataKey="range" tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--color-text-secondary)' }} />
                      <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }} />
                      <Bar dataKey="count" name="Casos no backlog" fill="#b77912" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* 8. Produtividade e Desempenho da Equipe */}
            <div className="team-performance-card">
              <div className="chart-card-header">
                <div>
                  <h3>Desempenho e Produtividade da Equipe</h3>
                  <p>Métricas auditadas de conclusão, tempo médio de resolução e carga ativa</p>
                </div>
              </div>
              <div className="team-perf-table-wrap">
                <table className="team-perf-table">
                  <thead>
                    <tr>
                      <th>Membro da equipe</th>
                      <th>Perfil</th>
                      <th>Casos ativos atribuídos</th>
                      <th>Concluídos no período</th>
                      <th>Tempo médio de resolução</th>
                      <th>Atrasados atribuídos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {teamPerformance.length === 0 ? (
                      <tr>
                        <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: 'var(--color-text-muted)' }}>
                          Nenhum membro da equipe localizado.
                        </td>
                      </tr>
                    ) : (
                      teamPerformance.map(member => {
                        const memberKey = member.id || member.name;
                        return (
                          <tr
                            key={memberKey}
                            style={{ cursor: 'pointer' }}
                            onClick={() => onNavigateToRecords({ owner: member.name })}
                            title={`Ver chamados sob responsabilidade de ${member.name}`}
                          >
                            <td>
                              <div className="team-perf-user-cell">
                                <strong>{member.name}</strong>
                                {member.email && <small>{member.email}</small>}
                              </div>
                            </td>
                            <td>
                              <span className="account-state state-active" style={{ fontSize: '10px' }}>
                                {member.role === 'ADMIN' ? 'Administrador' : member.role === 'ANALYST' ? 'Analista' : 'Visualizador'}
                              </span>
                            </td>
                            <td>
                              <strong>{member.currentlyAssigned}</strong>
                            </td>
                            <td>
                              <strong style={{ color: member.completedInPeriod > 0 ? 'var(--color-success)' : undefined }}>
                                {member.completedInPeriod}
                              </strong>
                            </td>
                            <td>
                              {formatResolutionTime(member.avgResolutionSeconds)}
                            </td>
                            <td>
                              <strong style={{ color: member.overdueCount > 0 ? 'var(--color-danger)' : undefined }}>
                                {member.overdueCount}
                              </strong>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <div className="team-perf-attribution-note">
                <Users width={14} height={14} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '6px' }} />
                <strong>Rastreabilidade auditável:</strong> Os casos concluídos são atribuídos exclusivamente a quem executou a conclusão registrada no histórico (ActivityLog), sem transferir créditos indevidos ao responsável atual.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ComparisonBadge({ metric, isInverse = false }: { metric: { percentageChange: number | null; change: number }; isInverse?: boolean }) {
  const { text, polarity } = formatPercentageChange(metric.percentageChange);

  let badgeClass = 'kpi-badge-neutral';
  if (polarity === 'positive') {
    badgeClass = isInverse ? 'kpi-badge-negative' : 'kpi-badge-positive';
  } else if (polarity === 'negative') {
    badgeClass = isInverse ? 'kpi-badge-positive' : 'kpi-badge-negative';
  }

  return (
    <span className={`kpi-comparison-badge ${badgeClass}`} title={`Variação absoluta: ${metric.change >= 0 ? '+' : ''}${metric.change}`}>
      {polarity === 'positive' && <ArrowUpRight width={12} height={12} />}
      {polarity === 'negative' && <ArrowDownRight width={12} height={12} />}
      {text}
    </span>
  );
}
