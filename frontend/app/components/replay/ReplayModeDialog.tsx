import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from 'react-hot-toast'
import { startReplay, stopReplay, getReplayState, advanceReplay, ReplayState } from '@/lib/api'
import { Play, Pause, Square, SkipForward } from 'lucide-react'

interface ReplayModeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function ReplayModeDialog({ open, onOpenChange }: ReplayModeDialogProps) {
  const [replayState, setReplayState] = useState<ReplayState | null>(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [speedMultiplier, setSpeedMultiplier] = useState(1.0)
  const [loading, setLoading] = useState(false)

  // Set default dates (last 30 days)
  useEffect(() => {
    if (open && !startDate && !endDate) {
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - 30)
      
      setEndDate(end.toISOString().split('T')[0])
      setStartDate(start.toISOString().split('T')[0])
    }
  }, [open, startDate, endDate])

  // Poll replay state when dialog is open
  useEffect(() => {
    if (!open) return

    const fetchState = async () => {
      try {
        const state = await getReplayState()
        setReplayState(state)
      } catch (err) {
        console.error('Failed to fetch replay state:', err)
      }
    }

    fetchState()
    const interval = setInterval(fetchState, 2000) // Poll every 2 seconds
    return () => clearInterval(interval)
  }, [open])

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
      const startDateTime = new Date(startDate).toISOString()
      const endDateTime = new Date(endDate).toISOString()
      
      await startReplay(startDateTime, endDateTime, speedMultiplier)
      toast.success('Replay mode started')
      const state = await getReplayState()
      setReplayState(state)
    } catch (err: any) {
      toast.error(err.message || 'Failed to start replay mode')
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
    } catch (err: any) {
      toast.error(err.message || 'Failed to advance replay')
    }
  }

  const isActive = replayState?.active ?? false
  const currentState = replayState?.state

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Replay / Backtest Mode</DialogTitle>
          <DialogDescription>
            Simulate trading using historical price data. The system will replay trades using prices from the selected period.
          </DialogDescription>
        </DialogHeader>

        {isActive && currentState ? (
          <div className="space-y-4">
            <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-blue-900">Replay Active</span>
                <span className="text-sm text-blue-700">
                  {currentState.progress?.toFixed(1)}% complete
                </span>
              </div>
              <div className="text-sm text-blue-800 space-y-1">
                <div>Start: {new Date(currentState.start_date).toLocaleString()}</div>
                <div>End: {new Date(currentState.end_date).toLocaleString()}</div>
                <div>Current: {new Date(currentState.current_date).toLocaleString()}</div>
                <div>Speed: {currentState.speed_multiplier}x</div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={() => handleAdvance(300)}
                variant="outline"
                size="sm"
                className="flex-1"
              >
                <SkipForward className="w-4 h-4 mr-2" />
                Advance 5 min
              </Button>
              <Button
                onClick={() => handleAdvance(3600)}
                variant="outline"
                size="sm"
                className="flex-1"
              >
                <SkipForward className="w-4 h-4 mr-2" />
                Advance 1 hour
              </Button>
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
        ) : (
          <div className="space-y-4">
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
                1x = 2 sec/day, 2x = 1 sec/day, 0.5x = 4 sec/day
              </p>
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
        )}
      </DialogContent>
    </Dialog>
  )
}
