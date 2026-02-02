import { useState, useEffect } from 'react'
import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  ChartOptions,
} from 'chart.js'
import { Card } from '@/components/ui/card'
import { getCryptoKline } from '@/lib/api'

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
)

interface Trade {
  id: number
  symbol: string
  market?: string
  side: string
  price: number
  quantity: number
  trade_time: string
}

interface ReplayState {
  active: boolean
  state?: {
    start_date: string
    end_date: string
    current_date: string
    speed_multiplier: number
    progress?: number
  }
}

interface PriceChartProps {
  symbol: string
  market: string
  trades: Trade[]
  accountId?: number
  replayState?: ReplayState | null
}

interface KlineData {
  timestamp: number
  datetime?: string
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
}

export default function PriceChart({ symbol, market, trades, accountId, replayState }: PriceChartProps) {
  const [klineData, setKlineData] = useState<KlineData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [timeframe, setTimeframe] = useState<'1m' | '5m' | '15m' | '1h' | '1d'>('1d')
  const [historyRange, setHistoryRange] = useState<'1M' | '3M' | '6M' | '1Y' | '2Y' | 'ALL'>('1Y')
  
  // Replay mode: get current date to filter data
  const isReplayActive = replayState?.active ?? false
  const replayCurrentDate = replayState?.state?.current_date ? new Date(replayState.state.current_date) : null
  const replayStartDate = replayState?.state?.start_date ? new Date(replayState.state.start_date) : null

  // Filter trades for this symbol (handle missing market - default to CRYPTO)
  // Also filter by replay date range if in replay mode
  const symbolTrades = trades.filter(t => {
    const symbolMatch = t.symbol === symbol && (t.market === market || (!t.market && market === 'CRYPTO'))
    if (!symbolMatch) return false
    
    // In replay mode, only show trades within the replay period
    if (isReplayActive && replayStartDate && replayCurrentDate) {
      const tradeTime = new Date(t.trade_time).getTime()
      const startTime = replayStartDate.getTime()
      const currentTime = replayCurrentDate.getTime()
      return tradeTime >= startTime && tradeTime <= currentTime
    }
    
    return true
  })
  
  // Debug: log filtered trades
  if (trades.length > 0 || symbolTrades.length > 0) {
    console.log(`PriceChart ${symbol}: ${trades.length} total trades, ${symbolTrades.length} for ${symbol}, replay=${isReplayActive}`)
  }

  // Calculate count based on timeframe and history range
  const getDataCount = (): number => {
    // For daily candles, calculate how many we need based on history range
    if (timeframe === '1d') {
      switch (historyRange) {
        case '1M': return 31   // ~1 month (31 days)
        case '3M': return 93   // ~3 months (90 days)
        case '6M': return 183  // ~6 months (180 days)
        case '1Y': return 365  // ~1 year
        case '2Y': return 500  // ~2 years (max API limit, ~1.4 years of daily data)
        case 'ALL': return 500 // Max allowed by API
        default: return 365
      }
    }
    // For shorter timeframes, use appropriate counts based on history range
    if (historyRange === 'ALL') {
      return 500 // Max allowed
    }
    
    // Calculate based on timeframe and desired history
    const daysMap: Record<string, number> = {
      '1M': 30,
      '3M': 90,
      '6M': 180,
      '1Y': 365,
      '2Y': 730
    }
    const days = daysMap[historyRange] || 365
    
    switch (timeframe) {
      case '1m': return Math.min(500, days * 24 * 60) // minutes per day
      case '5m': return Math.min(500, days * 24 * 12) // 5-min candles per day
      case '15m': return Math.min(500, days * 24 * 4)  // 15-min candles per day
      case '1h': return Math.min(500, days * 24)        // hourly candles per day
      default: return 100
    }
  }

  // Fetch kline data - refetch when replay state changes
  useEffect(() => {
    const fetchKlineData = async () => {
      try {
        setLoading(true)
        setError(null)
        const count = getDataCount()
        const response = await getCryptoKline(symbol, market, timeframe, count)
        if (response && response.data && Array.isArray(response.data)) {
          setKlineData(response.data)
        } else {
          setError('No data available')
        }
      } catch (err) {
        console.error(`Failed to fetch kline data for ${symbol}:`, err)
        setError(`Failed to load price data for ${symbol}`)
      } finally {
        setLoading(false)
      }
    }

    if (symbol) {
      fetchKlineData()
      // In replay mode, don't auto-refresh - wait for replay state changes
      if (!isReplayActive) {
        const refreshInterval = (timeframe === '1d') ? 300000 : 30000
        const interval = setInterval(fetchKlineData, refreshInterval)
        return () => clearInterval(interval)
      }
    }
  }, [symbol, market, timeframe, historyRange, isReplayActive, replayState?.state?.current_date])

  if (loading && klineData.length === 0) {
    return (
      <Card className="p-4">
        <div className="text-sm text-muted-foreground">Loading price chart for {symbol}...</div>
      </Card>
    )
  }

  if (error || klineData.length === 0) {
    return (
      <Card className="p-4">
        <div className="text-sm text-red-600">{error || `No price data available for ${symbol}`}</div>
      </Card>
    )
  }

  // Prepare chart data - ensure we have valid data
  // In replay mode, filter to only show data up to the current replay date
  const validKlineData = klineData.filter(k => {
    const price = k.close ?? k.open ?? null
    const isValidPrice = price !== null && price !== undefined && !isNaN(Number(price)) && Number(price) > 0
    
    if (!isValidPrice) return false
    
    // In replay mode, only show data up to current replay date
    if (isReplayActive && replayCurrentDate && replayStartDate) {
      const klineTime = k.datetime ? new Date(k.datetime).getTime() : (k.timestamp || 0) * 1000
      const replayTime = replayCurrentDate.getTime()
      const startTime = replayStartDate.getTime()
      // Show data from start of replay period up to current replay date
      return klineTime <= replayTime && klineTime >= startTime - (30 * 24 * 60 * 60 * 1000) // Include 30 days before start for context
    }
    
    return true
  })

  if (validKlineData.length === 0) {
    return (
      <Card className="p-4">
        <div className="text-sm text-red-600">No valid price data available for {symbol}</div>
      </Card>
    )
  }

  const labels = validKlineData.map(k => {
    if (k.datetime) {
      return new Date(k.datetime).toLocaleString()
    }
    return new Date((k.timestamp || 0) * 1000).toLocaleString()
  })

  // Extract prices - prioritize close, then open
  const prices = validKlineData.map(k => {
    const price = k.close ?? k.open ?? 0
    return Number(price)
  })

  // Debug: Log price range to verify correctness
  if (prices.length > 0) {
    const minPrice = Math.min(...prices)
    const maxPrice = Math.max(...prices)
    console.log(`Price chart for ${symbol}: Min=$${minPrice}, Max=$${maxPrice}, First=$${prices[0]}, Last=$${prices[prices.length - 1]}, Count=${prices.length}`)
  }

  // Prepare trade markers (buy/sell points)
  const buyMarkers: { x: number; y: number; label: string }[] = []
  const sellMarkers: { x: number; y: number; label: string }[] = []

  symbolTrades.forEach(trade => {
    const tradeTime = new Date(trade.trade_time).getTime()
    // Find the closest kline data point in validKlineData
    let closestIndex = 0
    let minDiff = Infinity
    
    validKlineData.forEach((k, idx) => {
      const klineTime = (k.timestamp || 0) * 1000
      const diff = Math.abs(tradeTime - klineTime)
      if (diff < minDiff) {
        minDiff = diff
        closestIndex = idx
      }
    })

    const marker = {
      x: closestIndex,
      y: trade.price,
      label: `${trade.side} ${trade.quantity.toFixed(4)} @ $${trade.price.toFixed(4)}`
    }

    if (trade.side === 'BUY' || trade.side === 'LONG') {
      buyMarkers.push(marker)
    } else if (trade.side === 'SELL' || trade.side === 'SHORT') {
      sellMarkers.push(marker)
    }
  })

  // Create arrays for buy/sell markers aligned with price data
  const buyData = new Array(prices.length).fill(null)
  const sellData = new Array(prices.length).fill(null)
  
  buyMarkers.forEach(marker => {
    if (marker.x >= 0 && marker.x < buyData.length) {
      buyData[marker.x] = marker.y
    }
  })
  
  sellMarkers.forEach(marker => {
    if (marker.x >= 0 && marker.x < sellData.length) {
      sellData[marker.x] = marker.y
    }
  })

  // Debug: Log first few prices to verify they're correct
  if (prices.length > 0) {
    console.log(`Price chart for ${symbol}: First price=${prices[0]}, Last price=${prices[prices.length - 1]}, Count=${prices.length}`)
  }

  const chartData = {
    labels,
    datasets: [
      {
        label: 'Price',
        data: prices,
        borderColor: 'rgb(59, 130, 246)',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        tension: 0.1,
        pointRadius: 0,
        pointHoverRadius: 4,
      },
      // Buy markers
      {
        label: 'Buy',
        data: buyData,
        pointRadius: (ctx: any) => {
          return ctx.parsed.y !== null && ctx.parsed.y !== undefined ? 8 : 0
        },
        pointHoverRadius: 10,
        pointBackgroundColor: 'rgb(34, 197, 94)',
        pointBorderColor: 'rgb(255, 255, 255)',
        pointBorderWidth: 2,
        showLine: false,
      },
      // Sell markers
      {
        label: 'Sell',
        data: sellData,
        pointRadius: (ctx: any) => {
          return ctx.parsed.y !== null && ctx.parsed.y !== undefined ? 8 : 0
        },
        pointHoverRadius: 10,
        pointBackgroundColor: 'rgb(239, 68, 68)',
        pointBorderColor: 'rgb(255, 255, 255)',
        pointBorderWidth: 2,
        showLine: false,
      },
    ],
  }

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
      },
      tooltip: {
        callbacks: {
          label: function(context) {
            if (context.datasetIndex === 0) {
              const price = context.parsed.y
              // Format price appropriately based on magnitude
              if (price >= 1000) {
                return `Price: $${price.toFixed(2)}`
              } else if (price >= 1) {
                return `Price: $${price.toFixed(4)}`
              } else {
                return `Price: $${price.toFixed(6)}`
              }
            } else if (context.datasetIndex === 1 && context.parsed.y !== null) {
              // Find the buy marker for this index
              const marker = buyMarkers.find(m => m.x === context.dataIndex)
              return marker ? marker.label : `Buy @ $${context.parsed.y.toFixed(4)}`
            } else if (context.datasetIndex === 2 && context.parsed.y !== null) {
              // Find the sell marker for this index
              const marker = sellMarkers.find(m => m.x === context.dataIndex)
              return marker ? marker.label : `Sell @ $${context.parsed.y.toFixed(4)}`
            }
            return ''
          }
        }
      },
      title: {
        display: true,
        text: isReplayActive && replayCurrentDate 
          ? `${symbol} Price Chart (Replay: ${replayCurrentDate.toLocaleDateString()})`
          : `${symbol} Price Chart`,
      },
    },
    scales: {
      y: {
        beginAtZero: false,
        title: {
          display: true,
          text: 'Price (USD)',
        },
      },
      x: {
        title: {
          display: true,
          text: 'Time',
        },
        ticks: {
          maxTicksLimit: 10,
        },
      },
    },
  }

  return (
    <Card className="p-4">
      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-semibold">{symbol} Price Chart</h3>
        <div className="flex gap-2 flex-wrap">
          {/* Timeframe selector */}
          <div className="flex gap-1 border rounded p-1">
            {(['1m', '5m', '15m', '1h', '1d'] as const).map(tf => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-2 py-1 text-xs rounded ${
                  timeframe === tf
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-transparent text-secondary-foreground hover:bg-secondary/50'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
          {/* History range selector (only show for daily timeframe) */}
          {timeframe === '1d' && (
            <div className="flex gap-1 border rounded p-1">
              {(['1M', '3M', '6M', '1Y', '2Y', 'ALL'] as const).map(range => (
                <button
                  key={range}
                  onClick={() => setHistoryRange(range)}
                  className={`px-2 py-1 text-xs rounded ${
                    historyRange === range
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-transparent text-secondary-foreground hover:bg-secondary/50'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="h-64">
        <Line data={chartData} options={options} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <div>
          <span className="inline-flex items-center gap-1 mr-4">
            <span className="w-3 h-3 bg-green-500 rounded-full"></span>
            Buy ({buyMarkers.length})
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-3 bg-red-500 rounded-full"></span>
            Sell ({sellMarkers.length})
          </span>
        </div>
        <div className="text-xs">
          {isReplayActive && replayCurrentDate ? (
            <span className="text-blue-600">
              Replay: {validKlineData.length} points up to {replayCurrentDate.toLocaleDateString()}
            </span>
          ) : (
            <>
              Showing {validKlineData.length} data points
              {timeframe === '1d' && historyRange !== 'ALL' && ` (~${Math.round(validKlineData.length / 365 * 12)} months)`}
            </>
          )}
        </div>
      </div>
    </Card>
  )
}
