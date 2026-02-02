import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { Toaster, toast } from 'react-hot-toast'

// Create a module-level WebSocket singleton to avoid duplicate connections in React StrictMode
let __WS_SINGLETON__: WebSocket | null = null;

const resolveWsUrl = () => {
  if (typeof window === 'undefined') return 'ws://localhost:5611/ws'
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}


import Header from '@/components/layout/Header'
import Sidebar from '@/components/layout/Sidebar'
import Portfolio from '@/components/portfolio/Portfolio'
import ComprehensiveView from '@/components/portfolio/ComprehensiveView'
import { AIDecision, getAccounts } from '@/lib/api'

interface User {
  id: number
  username: string
}

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
  // Required by child components
  return_rate: number
  total_notional_value: number
  positions_notional_value: number
  // Optional extras for compatibility with snapshots
  total_assets?: number
  positions_value?: number
  positions_market_value?: number
  portfolio?: {
    total_assets: number
    positions_value: number
  }
}
interface Position { id: number; account_id: number; symbol: string; name: string; market: string; quantity: number; available_quantity: number; avg_cost: number; leverage: number; last_price?: number | null; market_value?: number | null; notional_value?: number | null }
interface Order { id: number; order_no: string; symbol: string; name: string; market: string; side: string; order_type: string; price?: number; quantity: number; leverage: number; filled_quantity: number; status: string }
interface Trade { id: number; order_id: number; account_id: number; symbol: string; name: string; market: string; side: string; price: number; quantity: number; commission: number; trade_time: string }

const PAGE_TITLES: Record<string, string> = {
  portfolio: 'Crypto Paper Trading',
  comprehensive: 'Open Alpha Arena',
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [positions, setPositions] = useState<Position[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [trades, setTrades] = useState<Trade[]>([])
  const [aiDecisions, setAiDecisions] = useState<AIDecision[]>([])
  const [allAssetCurves, setAllAssetCurves] = useState<any[]>([])
  const [currentPage, setCurrentPage] = useState<string>('comprehensive')
  const [accountRefreshTrigger, setAccountRefreshTrigger] = useState<number>(0)
  const wsRef = useRef<WebSocket | null>(null)
  const [accounts, setAccounts] = useState<any[]>([])
  const [accountsLoading, setAccountsLoading] = useState<boolean>(true)
  const [wsConnected, setWsConnected] = useState(false)
  const [wsError, setWsError] = useState<string | null>(null)

  useEffect(() => {
    let reconnectTimer: NodeJS.Timeout | null = null
    let ws = __WS_SINGLETON__
    const created = !ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED
    
    const connectWebSocket = () => {
      try {
        ws = new WebSocket(resolveWsUrl())
        __WS_SINGLETON__ = ws
        wsRef.current = ws
        
        const handleOpen = () => {
          console.log('WebSocket connected')
          setWsConnected(true)
          setWsError(null)
          // Start with hardcoded default user for paper trading
          ws!.send(JSON.stringify({ type: 'bootstrap', username: 'default', initial_capital: 10000 }))
        }
        
        const handleMessage = (e: MessageEvent) => {
          try {
            const msg = JSON.parse(e.data)
            if (msg.type === 'bootstrap_ok') {
              if (msg.user) {
                setUser(msg.user)
              }
              if (msg.account) {
                setAccount(msg.account)
              } else {
                // No account available - set error state
                setWsError('No account found. Please create an account in Settings.')
                setAccount(null)  // Explicitly set to null
              }
              // refresh accounts list once bootstrapped
              refreshAccounts()
              // Only request snapshot if we have an account
              if (msg.account) {
                ws!.send(JSON.stringify({ type: 'get_snapshot' }))
              }
            } else if (msg.type === 'snapshot' || msg.type === 'snapshot_full' || msg.type === 'snapshot_fast') {
              // Debug: log snapshot data
              console.log('Snapshot received:', {
                type: msg.type,
                positions: msg.positions?.length || 0,
                trades: msg.trades?.length || 0,
                ai_decisions: msg.ai_decisions?.length || 0,
                orders: msg.orders?.length || 0,
                sampleTrades: msg.trades?.slice(0, 2),
                samplePositions: msg.positions?.slice(0, 2)
              })
              setOverview(msg.overview)
              setPositions(msg.positions)
              setOrders(msg.orders)
              setTrades(msg.trades || [])
              setAiDecisions(msg.ai_decisions || [])
              // Only update asset curves if provided (snapshot_full includes them)
              if (msg.all_asset_curves) {
                setAllAssetCurves(msg.all_asset_curves)
              }
            } else if (msg.type === 'trades') {
              setTrades(msg.trades || [])
            } else if (msg.type === 'order_filled') {
              toast.success('Order filled')
              ws!.send(JSON.stringify({ type: 'get_snapshot' }))
            } else if (msg.type === 'order_pending') {
              toast('Order placed, waiting for fill', { icon: '⏳' })
              ws!.send(JSON.stringify({ type: 'get_snapshot' }))
            } else if (msg.type === 'user_switched') {
              toast.success(`Switched to ${msg.user.username}`)
              setUser(msg.user)
            } else if (msg.type === 'account_switched') {
              toast.success(`Switched to ${msg.account.name}`)
              setAccount(msg.account)
              refreshAccounts()
            } else if (msg.type === 'error') {
              console.error('WebSocket error:', msg.message)
              // Handle bootstrap error about no account
              if (msg.message && msg.message.includes('No account found')) {
                setWsError('No account found. Please create an account in Settings.')
                // Don't break connection - allow user to create account via UI
              } else {
                toast.error(msg.message || 'Order error')
              }
            }
          } catch (err) {
            console.error('Failed to parse WebSocket message:', err)
          }
        }
        
        const handleClose = (event: CloseEvent) => {
          console.log('WebSocket closed:', event.code, event.reason)
          setWsConnected(false)
          __WS_SINGLETON__ = null
          if (wsRef.current === ws) wsRef.current = null
          
          // Attempt to reconnect after 3 seconds if the close wasn't intentional
          if (event.code !== 1000 && event.code !== 1001) {
            reconnectTimer = setTimeout(() => {
              console.log('Attempting to reconnect WebSocket...')
              connectWebSocket()
            }, 3000)
          }
        }
        
        const handleError = (event: Event) => {
          console.error('WebSocket error:', event)
          setWsConnected(false)
          // Don't show toast for every error to avoid spam
          // toast.error('Connection error')
        }

        ws.addEventListener('open', handleOpen)
        ws.addEventListener('message', handleMessage)
        ws.addEventListener('close', handleClose)
        ws.addEventListener('error', handleError)
        
        return () => {
          ws?.removeEventListener('open', handleOpen)
          ws?.removeEventListener('message', handleMessage)
          ws?.removeEventListener('close', handleClose)
          ws?.removeEventListener('error', handleError)
        }
      } catch (err) {
        console.error('Failed to create WebSocket:', err)
        // Retry connection after 5 seconds
        reconnectTimer = setTimeout(connectWebSocket, 5000)
      }
    }
    
    if (created) {
      connectWebSocket()
    } else {
      wsRef.current = ws
    }

    return () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
      }
      // Don't close the socket in cleanup to avoid issues with React StrictMode
    }
  }, [])

  // Centralized accounts fetcher
  const refreshAccounts = async () => {
    try {
      setAccountsLoading(true)
      const list = await getAccounts()
      setAccounts(list)
    } catch (e) {
      console.error('Failed to fetch accounts', e)
    } finally {
      setAccountsLoading(false)
    }
  }

  // Fetch accounts on mount and when settings updated
  useEffect(() => {
    refreshAccounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountRefreshTrigger])

  const placeOrder = (payload: any) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('WS not connected, cannot place order')
      toast.error('Not connected to server')
      return
    }
    try {
      wsRef.current.send(JSON.stringify({ type: 'place_order', ...payload }))
      toast('Placing order...', { icon: '📝' })
    } catch (e) {
      console.error(e)
      toast.error('Failed to send order')
    }
  }

  const switchUser = (username: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('WS not connected, cannot switch user')
      toast.error('Not connected to server')
      return
    }
    try {
      wsRef.current.send(JSON.stringify({ type: 'switch_user', username }))
      toast('Switching account...', { icon: '🔄' })
    } catch (e) {
      console.error(e)
      toast.error('Failed to switch user')
    }
  }

  const switchAccount = (accountId: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('WS not connected, cannot switch account')
      toast.error('Not connected to server')
      return
    }
    try {
      wsRef.current.send(JSON.stringify({ type: 'switch_account', account_id: accountId }))
      toast('Switching account...', { icon: '🔄' })
    } catch (e) {
      console.error(e)
      toast.error('Failed to switch account')
    }
  }

  const handleAccountUpdated = () => {
    // Increment refresh trigger to force AccountSelector to refresh
    setAccountRefreshTrigger(prev => prev + 1)
    
    // Also refresh the current data snapshot
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'get_snapshot' }))
    }
  }

  if (!user || !account || !overview) {
    const pageTitle = PAGE_TITLES[currentPage] ?? PAGE_TITLES.portfolio
    
    if (wsError) {
      return (
        <div className="h-screen flex overflow-hidden">
          <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} onAccountUpdated={handleAccountUpdated} />
          <div className="flex-1 flex flex-col">
            <Header title={pageTitle} currentUser={user} currentAccount={account} />
            <div className="flex-1 flex flex-col items-center justify-center p-8">
              <div className="text-lg font-semibold text-red-600 mb-2">{wsError}</div>
              <div className="text-sm text-muted-foreground">
                Click the Settings icon in the sidebar to create an account.
              </div>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="h-screen flex overflow-hidden">
        <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} onAccountUpdated={handleAccountUpdated} />
        <div className="flex-1 flex flex-col">
          <Header title={pageTitle} />
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <div className="text-lg font-semibold mb-2">Connecting to trading server...</div>
            {!wsConnected && (
              <div className="text-sm text-muted-foreground mt-2">
                Make sure the backend server is running on port 5611
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  const renderMainContent = () => {
    const refreshData = () => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'get_snapshot' }))
      }
    }

    return (
      <main className="flex-1 p-4 overflow-hidden">
        {currentPage === 'portfolio' && (
          <Portfolio
            overview={overview}
            positions={positions}
            orders={orders}
            trades={trades}
            aiDecisions={aiDecisions}
            allAssetCurves={allAssetCurves}
            wsRef={wsRef}
            onSwitchAccount={switchAccount}
            onRefreshData={refreshData}
            accountRefreshTrigger={accountRefreshTrigger}
            accounts={accounts}
            loadingAccounts={accountsLoading}
          />
        )}
        
        {currentPage === 'comprehensive' && (
          <ComprehensiveView
            overview={overview}
            positions={positions}
            orders={orders}
            trades={trades}
            aiDecisions={aiDecisions}
            allAssetCurves={allAssetCurves}
            wsRef={wsRef}
            onSwitchUser={switchUser}
            onSwitchAccount={switchAccount}
            onRefreshData={refreshData}
            accountRefreshTrigger={accountRefreshTrigger}
            accounts={accounts}
            loadingAccounts={accountsLoading}
          />
        )}
      </main>
    )
  }

  const pageTitle = PAGE_TITLES[currentPage] ?? PAGE_TITLES.portfolio

  return (
    <div className="h-screen flex overflow-hidden">
      <Sidebar
        currentPage={currentPage}
        onPageChange={setCurrentPage}
        onAccountUpdated={handleAccountUpdated}
      />
      <div className="flex-1 flex flex-col">
        <Header
          title={pageTitle}
          currentUser={user}
          currentAccount={account}
          showAccountSelector={currentPage === 'portfolio' || currentPage === 'comprehensive'}
          onUserChange={switchUser}
        />
        {renderMainContent()}
      </div>
    </div>
  )
}

// Prevent multiple root creation (for HMR and StrictMode)
// Use a module-level variable that's checked before creating root
const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element not found')
}

// Store root in window to persist across HMR reloads
// Check window first to avoid creating duplicate roots
if (!(window as any).__reactRoot) {
  ;(window as any).__reactRoot = ReactDOM.createRoot(rootElement)
}

// Get the root instance
const root = (window as any).__reactRoot

// Render the app (safe to call multiple times during HMR)
root.render(
  <React.StrictMode>
    <Toaster position="top-right" />
    <App />
  </React.StrictMode>
)
