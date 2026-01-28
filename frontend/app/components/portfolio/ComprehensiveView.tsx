import AccountDataView from './AccountDataView'
import { AIDecision, getReplayState, ReplayState, startReplay, stopReplay, advanceReplay } from '@/lib/api'
import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card } from '@/components/ui/card'
import { toast } from 'react-hot-toast'
import { Play, Square, SkipForward } from 'lucide-react'

interface Account {
  id: number
  user_id: number
  name: string
  account_type: string
  initial_capital: number
  current_cash: number
  frozen_cash: number
}

interface Overview {
  account: Account
  return_rate: number
  total_notional_value: number
  positions_notional_value: number
}

interface Position {
  id: number
  account_id?: number
  user_id?: number
  symbol: string
  name: string
  market: string
  quantity: number
  available_quantity: number
  avg_cost: number
  leverage: number
  last_price?: number | null
  market_value?: number | null
  notional_value?: number | null
}

interface Order {
  id: number
  order_no: string
  symbol: string
  name: string
  market: string
  side: string
  order_type: string
  price?: number
  quantity: number
  leverage: number
  filled_quantity: number
  status: string
}

interface Trade {
  id: number
  order_id: number
  account_id?: number
  user_id?: number
  symbol: string
  name: string
  market: string
  side: string
  price: number
  quantity: number
  commission: number
  trade_time: string
}

interface ComprehensiveViewProps {
  overview: Overview | null
  positions: Position[]
  orders: Order[]
  trades: Trade[]
  aiDecisions: AIDecision[]
  allAssetCurves: any[]
  wsRef?: React.MutableRefObject<WebSocket | null>
  onSwitchUser: (username: string) => void
  onSwitchAccount: (accountId: number) => void
  onRefreshData: () => void
  accountRefreshTrigger?: number
  accounts?: any[]
  loadingAccounts?: boolean
}

export default function ComprehensiveView({
  overview,
  positions,
  orders,
  trades,
  aiDecisions,
  allAssetCurves,
  wsRef,
  onSwitchUser,
  onSwitchAccount,
  onRefreshData,
  accountRefreshTrigger,
  accounts,
  loadingAccounts
}: ComprehensiveViewProps) {
  const [replayState, setReplayState] = useState<ReplayState | null>(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [speedMultiplier, setSpeedMultiplier] = useState(1.0)
  const [tradingIntervalDays, setTradingIntervalDays] = useState(1) // 1 for daily, 7 for weekly
  const [loading, setLoading] = useState(false)
  const [showReplayControls, setShowReplayControls] = useState(false)

  // Set default dates (last 30 days)
  useEffect(() => {
    if (!startDate && !endDate) {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 30)
      
      setEndDate(end.toISOString().split('T')[0])
      setStartDate(start.toISOString().split('T')[0])
    }
  }, [startDate, endDate])

  // Poll replay state continuously
  useEffect(() => {
    const fetchState = async () => {
      try {
        const state = await getReplayState()
        setReplayState(state)
        // Auto-refresh data when replay state changes
        if (state.active) {
          onRefreshData()
        }
      } catch (err) {
        console.error('Failed to fetch replay state:', err)
      }
    }

    fetchState()
    const interval = setInterval(fetchState, 2000) // Poll every 2 seconds
    return () => clearInterval(interval)
  }, [onRefreshData])

  // Auto-advance replay time when active
  useEffect(() => {
    if (!replayState?.active || !replayState?.state) return

    const currentState = replayState.state
    // Use trading interval (1d = 86400s, 7d = 604800s) instead of fixed 300s
    // Get trading interval from state or default to 1 day
    const tradingIntervalDays = (currentState as any).trading_interval_days || 1
    const tradingIntervalSeconds = tradingIntervalDays * 86400 // 1d = 86400s, 7d = 604800s
    
    // Advance by trading interval, adjusted by speed multiplier
    const speedMs = (tradingIntervalSeconds / currentState.speed_multiplier) * 1000 // Convert to milliseconds

    const interval = setInterval(async () => {
      try {
        await advanceReplay(tradingIntervalSeconds) // Advance by trading interval
        const newState = await getReplayState()
        setReplayState(newState)
        onRefreshData() // Refresh data after advancing
      } catch (err) {
        console.error('Failed to advance replay:', err)
      }
    }, speedMs)

    return () => clearInterval(interval)
  }, [replayState?.active, replayState?.state?.speed_multiplier, onRefreshData])

  const handleStart = async () => {
    if (!startDate || !endDate) {
      toast.error('Please select start and end dates')
      return
    }

    if (new Date(startDate) >= new Date(endDate)) {
      toast.error('Start date must be before end date')
      return
    }

    setLoading(true)
    try {
      // Convert date strings (YYYY-MM-DD) to full ISO datetime strings
      // Ensure we use UTC to avoid timezone issues
      const startDateTime = `${startDate}T00:00:00Z`
      const endDateTime = `${endDate}T23:59:59Z`
      
      console.log('Starting replay with:', { startDateTime, endDateTime, speedMultiplier, tradingIntervalDays })
      
      const response = await startReplay(startDateTime, endDateTime, speedMultiplier, tradingIntervalDays)
      console.log('Replay start response:', response)
      
      if (response.success) {
        toast.success('Replay mode started')
        // Small delay to ensure backend state is ready
        setTimeout(async () => {
          try {
            const state = await getReplayState()
            setReplayState(state)
            setShowReplayControls(false)
            onRefreshData() // Refresh all data
          } catch (stateErr) {
            console.error('Failed to fetch replay state:', stateErr)
          }
        }, 500)
      } else {
        throw new Error(response.message || 'Failed to start replay mode')
      }
    } catch (err: any) {
      console.error('Failed to start replay:', err)
      const errorMessage = err.message || err.data?.detail || err.data?.message || 'Failed to start replay mode'
      toast.error(`Failed to start replay: ${errorMessage}`)
    } finally {
      setLoading(false)
    }
  }

  const handleStop = async () => {
    setLoading(true)
    try {
      await stopReplay()
      toast.success('Replay mode stopped')
      setReplayState(null)
    } catch (err: any) {
      toast.error(err.message || 'Failed to stop replay mode')
    } finally {
      setLoading(false)
    }
  }

  const handleAdvance = async (seconds: number = 300) => {
    try {
      await advanceReplay(seconds)
      const state = await getReplayState()
      setReplayState(state)
      onRefreshData()
    } catch (err: any) {
      toast.error(err.message || 'Failed to advance replay')
    }
  }

  const isActive = replayState?.active ?? false
  const currentState = replayState?.state

  return (
    <div className="h-full flex flex-col">
      {/* Replay Controls Panel */}
      {showReplayControls && !isActive && (
        <Card className="p-4 mb-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Start Replay / Backtest</h3>
              <Button variant="ghost" size="sm" onClick={() => setShowReplayControls(false)}>×</Button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="start-date">Start Date</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  max={endDate || new Date().toISOString().split('T')[0]}
                />
              </div>
              <div>
                <Label htmlFor="end-date">End Date</Label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  max={new Date().toISOString().split('T')[0]}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="speed">Speed Multiplier</Label>
                <Input
                  id="speed"
                  type="number"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={speedMultiplier}
                  onChange={(e) => setSpeedMultiplier(parseFloat(e.target.value) || 1.0)}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  1.0 = real-time speed, 2.0 = 2x speed, etc.
                </p>
              </div>
              <div>
                <Label htmlFor="trading-interval">Trading Interval</Label>
                <select
                  id="trading-interval"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  value={tradingIntervalDays}
                  onChange={(e) => setTradingIntervalDays(parseInt(e.target.value))}
                >
                  <option value={1}>1 Day (Daily)</option>
                  <option value={7}>7 Days (Weekly)</option>
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  How often accounts will trade during replay
                </p>
              </div>
            </div>
            <Button
              onClick={handleStart}
              disabled={loading || !startDate || !endDate}
              className="w-full"
            >
              <Play className="w-4 h-4 mr-2" />
              Start Replay
            </Button>
          </div>
        </Card>
      )}

      {/* Replay Active Controls */}
      {isActive && currentState && (
        <Card className="p-4 mb-4 bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                <span className="font-semibold text-blue-900 dark:text-blue-100">Replay Mode Active</span>
              </div>
              <div className="text-sm text-blue-800 dark:text-blue-200">
                {currentState.progress ? `${currentState.progress.toFixed(1)}%` : 'Running'} | 
                Speed: {currentState.speed_multiplier}x | 
                Interval: {((currentState as any).trading_interval_days || 1)}d | 
                Current: {new Date(currentState.current_date).toLocaleString()}
              </div>
            </div>
            <div className="flex gap-2">
              {(() => {
                const tradingIntervalDays = (currentState as any).trading_interval_days || 1
                const tradingIntervalSeconds = tradingIntervalDays * 86400
                return (
                  <>
                    <Button
                      onClick={() => handleAdvance(tradingIntervalSeconds)}
                      variant="outline"
                      size="sm"
                    >
                      <SkipForward className="w-4 h-4 mr-2" />
                      +{tradingIntervalDays}d
                    </Button>
                    <Button
                      onClick={() => handleAdvance(tradingIntervalSeconds * 7)}
                      variant="outline"
                      size="sm"
                    >
                      <SkipForward className="w-4 h-4 mr-2" />
                      +{tradingIntervalDays * 7}d
                    </Button>
                  </>
                )
              })()}
              <Button
                onClick={handleStop}
                variant="destructive"
                size="sm"
                disabled={loading}
              >
                <Square className="w-4 h-4 mr-2" />
                Stop
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Start Replay Button (when not active) */}
      {!isActive && !showReplayControls && (
        <div className="mb-4 flex justify-end">
          <Button
            variant="outline"
            onClick={() => setShowReplayControls(true)}
            className="flex items-center gap-2"
          >
            <Play className="w-4 h-4" />
            Start Replay / Backtest
          </Button>
        </div>
      )}

      <AccountDataView
        overview={overview}
        positions={positions}
        orders={orders}
        trades={trades}
        aiDecisions={aiDecisions}
        allAssetCurves={allAssetCurves}
        wsRef={wsRef}
        onSwitchAccount={onSwitchAccount}
        onRefreshData={onRefreshData}
        accountRefreshTrigger={accountRefreshTrigger}
        accounts={accounts}
        loadingAccounts={loadingAccounts}
        showAssetCurves={true}
        showTradingPanel={false}
        replayState={replayState}
      />
    </div>
  )
}

