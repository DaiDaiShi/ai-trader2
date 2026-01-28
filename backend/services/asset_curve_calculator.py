"""
Asset Curve Calculator - New Algorithm
Draws curve by accounts, creates all-time list for every account: time, cash, positions.
Gets latest 20 close prices for all symbols, then fills curve with cash + sum(symbol price * position).
"""

from sqlalchemy.orm import Session
from typing import Dict, List, Tuple, Optional
from datetime import datetime, timezone, timedelta
import logging

from database.models import Trade, Account, CryptoKline
from services.market_data import get_kline_data


def get_all_asset_curves_data_new(db: Session, timeframe: str = "1h") -> List[Dict]:
    """
    New algorithm for asset curve calculation by accounts.
    
    Args:
        db: Database session
        timeframe: Time period for the curve, options: "5m", "1h", "1d"
        
    Returns:
        List of asset curve data points with timestamp, account info, and asset values
    """
    try:
        # Step 1: Get all accounts (including paused ones) - is_active only affects trading, not history display
        accounts = db.query(Account).all()
        if not accounts:
            return []
        
        logging.info(f"Found {len(accounts)} accounts (including paused)")
        
        # Step 2: Get all unique symbols from all account trades
        # Filter by replay period if replay mode is active
        symbols_query_base = db.query(Trade.symbol, Trade.market).distinct()
        
        try:
            from services.replay_service import get_replay_date_range
            replay_range = get_replay_date_range()
            if replay_range:
                start_date, current_date = replay_range
                symbols_query_base = symbols_query_base.filter(
                    Trade.trade_time >= start_date,
                    Trade.trade_time <= current_date
                )
                logging.info(f"Filtering symbols query for replay mode: {start_date} to {current_date}")
        except Exception:
            pass  # If replay service not available, continue without filter
        
        symbols_query = symbols_query_base.all()
        unique_symbols = set()
        for symbol, market in symbols_query:
            unique_symbols.add((symbol, market))
        
        if not unique_symbols:
            # No trades yet, return initial capital for all accounts at current time
            now = datetime.now()
            return [{
                "timestamp": int(now.timestamp()),
                "datetime_str": now.isoformat(),
                "account_id": account.id,
                "user_id": account.user_id,
                "username": account.name,
                "total_assets": float(account.initial_capital),
                "initial_capital": float(account.initial_capital),
                "profit": 0.0,
                "profit_percentage": 0.0,
                "cash": float(account.initial_capital),
                "positions_value": 0.0,
                "is_active": account.is_active == "true",
            } for account in accounts]
        
        logging.info(f"Found {len(unique_symbols)} unique symbols: {unique_symbols}")
        
        # Step 3: Generate timestamps and get kline data
        # In replay mode, generate timestamps based on replay period; otherwise use latest kline data
        symbol_klines = {}
        timestamps = []
        is_replay_mode = False
        
        try:
            from services.replay_service import get_replay_date_range, is_replay_active
            is_replay_mode = is_replay_active()
            replay_range = get_replay_date_range()
            if replay_range and is_replay_mode:
                replay_start_date, replay_current_date = replay_range
                logging.info(f"Replay mode active: generating timestamps from {replay_start_date} to {replay_current_date}")
                
                # Generate timestamps based on timeframe within replay period
                timestamps = _generate_timestamps_for_replay(replay_start_date, replay_current_date, timeframe)
                logging.info(f"Generated {len(timestamps)} timestamps for replay period")
                
                # For each symbol, fetch historical prices for these timestamps
                for symbol, market in unique_symbols:
                    try:
                        klines = []
                        for ts in timestamps:
                            ts_datetime = datetime.fromtimestamp(ts, tz=timezone.utc)
                            # Use replay_service to get historical price
                            from services.replay_service import get_historical_price
                            price = get_historical_price(symbol, market, ts_datetime)
                            if price is not None:
                                klines.append({
                                    'timestamp': ts,
                                    'datetime_str': ts_datetime.isoformat(),
                                    'close': price,
                                    'open': price,  # Use same price for open/close in replay
                                    'high': price,
                                    'low': price,
                                })
                        if klines:
                            symbol_klines[(symbol, market)] = klines
                            logging.info(f"Fetched {len(klines)} historical prices for {symbol}.{market} (replay period)")
                        else:
                            logging.warning(f"No historical prices found for {symbol}.{market} in replay period")
                    except Exception as e:
                        logging.error(f"Failed to fetch historical prices for {symbol}.{market}: {e}", exc_info=True)
        except Exception as e:
            logging.warning(f"Error checking replay mode: {e}")
            is_replay_mode = False
        
        # If not in replay mode, use normal kline data
        # If in replay mode but failed to get data, return initial capital at replay start
        if not is_replay_mode:
            for symbol, market in unique_symbols:
                try:
                    klines = get_kline_data(symbol, market, timeframe, 20)
                    if klines:
                        symbol_klines[(symbol, market)] = klines
                        logging.info(f"Fetched {len(klines)} klines for {symbol}.{market}")
                except Exception as e:
                    logging.warning(f"Failed to fetch klines for {symbol}.{market}: {e}")
            
            if not symbol_klines:
                # Fallback: return initial capital
                fallback_time = datetime.now(timezone.utc)
                return [{
                    "timestamp": int(fallback_time.timestamp()),
                    "datetime_str": fallback_time.isoformat(),
                    "account_id": account.id,
                    "user_id": account.user_id,
                    "username": account.name,
                    "total_assets": float(account.initial_capital),
                    "initial_capital": float(account.initial_capital),
                    "profit": 0.0,
                    "profit_percentage": 0.0,
                    "cash": float(account.initial_capital),
                    "positions_value": 0.0,
                    "is_active": account.is_active == "true",
                } for account in accounts]
            
            # Get timestamps from kline data
            first_klines = next(iter(symbol_klines.values()))
            timestamps = [k['timestamp'] for k in first_klines]
        elif is_replay_mode and (not timestamps or not symbol_klines):
            # In replay mode but failed to get historical data - return initial capital at replay start
            logging.warning("Replay mode active but failed to fetch historical prices - returning initial capital")
            try:
                from services.replay_service import get_replay_date_range
                replay_range = get_replay_date_range()
                if replay_range:
                    replay_start_date, _ = replay_range
                    fallback_time = replay_start_date.replace(hour=0, minute=0, second=0, microsecond=0)
                else:
                    fallback_time = datetime.now(timezone.utc)
            except Exception:
                fallback_time = datetime.now(timezone.utc)
            
            return [{
                "timestamp": int(fallback_time.timestamp()),
                "datetime_str": fallback_time.isoformat(),
                "account_id": account.id,
                "user_id": account.user_id,
                "username": account.name,
                "total_assets": float(account.initial_capital),
                "initial_capital": float(account.initial_capital),
                "profit": 0.0,
                "profit_percentage": 0.0,
                "cash": float(account.initial_capital),
                "positions_value": 0.0,
                "is_active": account.is_active == "true",
            } for account in accounts]
        
        logging.info(f"Processing {len(timestamps)} timestamps")
        if timestamps:
            first_ts = datetime.fromtimestamp(timestamps[0], tz=timezone.utc)
            last_ts = datetime.fromtimestamp(timestamps[-1], tz=timezone.utc)
            logging.info(f"Timestamp range: {first_ts.isoformat()} to {last_ts.isoformat()}")
        
        # Step 5: Calculate asset curves for each account
        result = []
        
        for account in accounts:
            account_id = account.id
            logging.info(f"Processing account {account_id}: {account.name}")
            
            # Create all-time list for this account: time, cash, positions
            account_timeline = _create_account_timeline(db, account, timestamps, symbol_klines)
            result.extend(account_timeline)
        
        # Sort result by timestamp and account_id for consistent ordering
        result.sort(key=lambda x: (x['timestamp'], x['account_id']))
        
        logging.info(f"Generated {len(result)} data points for asset curves")
        if result:
            first_result_ts = datetime.fromtimestamp(result[0]['timestamp'], tz=timezone.utc)
            last_result_ts = datetime.fromtimestamp(result[-1]['timestamp'], tz=timezone.utc)
            logging.info(f"Result date range: {first_result_ts.isoformat()} to {last_result_ts.isoformat()}")
        return result
        
    except Exception as e:
        logging.error(f"Failed to calculate asset curves: {e}")
        return []


def _generate_timestamps_for_replay(start_date: datetime, current_date: datetime, timeframe: str) -> List[int]:
    """
    Generate timestamps for replay period based on timeframe.
    
    Args:
        start_date: Start of replay period
        current_date: Current date in replay (end of period)
        timeframe: Timeframe string ('5m', '1h', '1d')
    
    Returns:
        List of timestamps (Unix seconds)
    """
    timestamps = []
    
    # Map timeframe to timedelta
    timeframe_deltas = {
        '5m': timedelta(minutes=5),
        '1h': timedelta(hours=1),
        '1d': timedelta(days=1),
    }
    
    delta = timeframe_deltas.get(timeframe, timedelta(hours=1))
    
    current = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
    end = current_date.replace(hour=23, minute=59, second=59, microsecond=999999)
    
    # Limit to reasonable number of points (max 500)
    max_points = 500
    point_count = 0
    
    while current <= end and point_count < max_points:
        timestamps.append(int(current.timestamp()))
        current += delta
        point_count += 1
    
    logging.info(f"Generated {len(timestamps)} timestamps from {start_date.isoformat()} to {current_date.isoformat()} with {timeframe} interval")
    if timestamps:
        first_ts_dt = datetime.fromtimestamp(timestamps[0], tz=timezone.utc)
        last_ts_dt = datetime.fromtimestamp(timestamps[-1], tz=timezone.utc)
        logging.info(f"First timestamp: {first_ts_dt.isoformat()}, Last timestamp: {last_ts_dt.isoformat()}")
    return timestamps


def _create_account_timeline(
    db: Session, 
    account: Account, 
    timestamps: List[int], 
    symbol_klines: Dict[Tuple[str, str], List[Dict]]
) -> List[Dict]:
    """
    Create all-time list for an account: time, cash, positions.
    Calculate cash + sum(symbol price * position) for each timestamp.
    
    Args:
        db: Database session
        account: Account object
        timestamps: List of timestamps to calculate for
        symbol_klines: Dictionary of symbol klines data
        
    Returns:
        List of timeline data points for the account
    """
    account_id = account.id
    
    # Get all trades for this account, ordered by time
    # Filter by replay period if replay mode is active
    trade_query = db.query(Trade).filter(Trade.account_id == account_id)
    
    # Apply replay mode filter if active
    try:
        from services.replay_service import get_replay_date_range
        replay_range = get_replay_date_range()
        if replay_range:
            start_date, current_date = replay_range
            trade_query = trade_query.filter(
                Trade.trade_time >= start_date,
                Trade.trade_time <= current_date
            )
            logging.info(f"Filtering trades for replay mode: {start_date} to {current_date}")
    except Exception:
        pass  # If replay service not available, continue without filter
    
    trades = trade_query.order_by(Trade.trade_time.asc()).all()
    
    if not trades:
        # No trades, return initial capital at all timestamps
        # Generate datetime strings for timestamps
        datetime_strings = []
        for ts in timestamps:
            ts_dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            datetime_strings.append(ts_dt.isoformat())
        
        return [{
            "timestamp": ts,
            "datetime_str": datetime_strings[i],
            "account_id": account.id,
            "user_id": account.user_id,
            "username": account.name,
            "total_assets": float(account.initial_capital),
            "initial_capital": float(account.initial_capital),
            "profit": 0.0,
            "profit_percentage": 0.0,
            "cash": float(account.initial_capital),
            "positions_value": 0.0,
            "is_active": account.is_active == "true",
        } for i, ts in enumerate(timestamps)]
    
    # Calculate holdings and cash at each timestamp
    timeline = []
    
    # Get datetime strings for timestamps (for replay mode or fallback)
    datetime_strings = []
    for ts in timestamps:
        ts_dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        datetime_strings.append(ts_dt.isoformat())
    
    # Check if we should use actual account.current_cash for the last timestamp
    # This handles cases where cash was adjusted outside of trade history
    use_actual_cash_for_last = len(timestamps) > 0
    
    for i, ts in enumerate(timestamps):
        ts_datetime = datetime.fromtimestamp(ts, tz=timezone.utc)
        is_last_timestamp = (i == len(timestamps) - 1)
        
        # Calculate cash and positions up to this timestamp
        cash_change = 0.0
        position_quantities = {}
        
        for trade in trades:
            trade_time = trade.trade_time
            if not trade_time.tzinfo:
                trade_time = trade_time.replace(tzinfo=timezone.utc)
            
            if trade_time <= ts_datetime:
                # Update cash based on trade (include commission and interest)
                trade_amount = float(trade.price) * float(trade.quantity) + float(trade.commission) + float(trade.interest_charged)
                if trade.side == "BUY" or trade.side == "LONG":
                    cash_change -= trade_amount
                else:  # SELL or SHORT
                    cash_change += trade_amount
                
                # Update position quantity
                key = (trade.symbol, trade.market)
                if key not in position_quantities:
                    position_quantities[key] = 0.0
                
                if trade.side == "BUY" or trade.side == "LONG":
                    position_quantities[key] += float(trade.quantity)
                else:  # SELL or SHORT
                    position_quantities[key] -= float(trade.quantity)
        
        # For the last timestamp, use actual current_cash to account for any realized P&L or adjustments
        # For historical points, reconstruct from initial capital + cash changes
        if is_last_timestamp and use_actual_cash_for_last:
            current_cash = float(account.current_cash)
        else:
            current_cash = float(account.initial_capital) + cash_change
        
        # Calculate positions MARKET VALUE using prices at this timestamp
        # Market value = quantity * price (NOT * leverage!)
        # Leverage only affects margin requirement, not the position's equity value
        positions_value = 0.0
        
        # In replay mode, use historical prices from replay_service
        # Otherwise, use prices from kline data
        use_replay_prices = False
        try:
            from services.replay_service import is_replay_active
            use_replay_prices = is_replay_active()
        except Exception:
            pass
        
        # For the last timestamp, use actual Position table data to get accurate current positions
        if is_last_timestamp and use_actual_cash_for_last:
            from database.models import Position
            from services.market_data import get_last_price
            from decimal import Decimal
            positions = db.query(Position).filter(Position.account_id == account.id).all()
            for pos in positions:
                if pos.quantity > 0:
                    try:
                        price = get_last_price(pos.symbol, pos.market)
                        if price and price > 0:
                            price_dec = Decimal(str(price))
                            quantity_dec = Decimal(str(pos.quantity))
                            avg_cost_dec = Decimal(str(pos.avg_cost))
                            leverage_dec = Decimal(str(pos.leverage)) if pos.leverage and pos.leverage > 0 else Decimal("1")
                            
                            # Market value of position
                            market_value = quantity_dec * price_dec
                            
                            # For leveraged positions, only count margin + unrealized P&L
                            if leverage_dec > 1:
                                # Initial margin used
                                initial_margin = market_value / leverage_dec
                                # Unrealized P&L
                                unrealized_pnl = quantity_dec * (price_dec - avg_cost_dec)
                                # Position equity = margin + P&L
                                position_equity = initial_margin + unrealized_pnl
                            else:
                                # Non-leveraged position: equity = market value
                                position_equity = market_value
                            
                            positions_value += float(position_equity)
                    except Exception as e:
                        logging.warning(f"Could not get price for {pos.symbol}.{pos.market}: {e}")
        else:
            # For historical points, reconstruct from trades
            for (symbol, market), quantity in position_quantities.items():
                if quantity > 0:
                    price = None
                    
                    # In replay mode, use historical prices
                    if use_replay_prices:
                        try:
                            from services.replay_service import get_historical_price
                            price = get_historical_price(symbol, market, ts_datetime)
                        except Exception as e:
                            logging.warning(f"Failed to get historical price for {symbol} at {ts_datetime}: {e}")
                    
                    # Fallback to kline data if replay price not available
                    if price is None and (symbol, market) in symbol_klines:
                        klines = symbol_klines[(symbol, market)]
                        if i < len(klines) and klines[i].get('close'):
                            price = float(klines[i]['close'])
                    
                    if price:
                        # Market value (equity) = price * quantity
                        positions_value += float(price) * quantity
        
        total_assets = current_cash + positions_value
        # Calculate profit: total_assets - initial_capital
        profit = total_assets - float(account.initial_capital)
        # Calculate profit percentage
        profit_percentage = (profit / float(account.initial_capital)) * 100 if float(account.initial_capital) > 0 else 0
        
        timeline.append({
            "timestamp": ts,
            "datetime_str": datetime_strings[i] if i < len(datetime_strings) else datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(),
            "account_id": account.id,
            "user_id": account.user_id,
            "username": account.name,
            "total_assets": total_assets,
            "initial_capital": float(account.initial_capital),
            "profit": profit,
            "profit_percentage": profit_percentage,
            "cash": current_cash,
            "positions_value": positions_value,
            "is_active": account.is_active == "true",
        })
    
    return timeline


def get_account_asset_curve(db: Session, account_id: int, timeframe: str = "1h") -> List[Dict]:
    """
    Get asset curve data for a specific account.
    
    Args:
        db: Database session
        account_id: ID of the account to get curve for
        timeframe: Time period for the curve
        
    Returns:
        List of asset curve data points for the account
    """
    try:
        # Get the specific account - don't filter by is_active so paused accounts can be viewed
        account = db.query(Account).filter(Account.id == account_id).first()
        
        if not account:
            return []
        
        # Get all unique symbols from this account's trades
        # Filter by replay period if replay mode is active
        symbols_query_base = db.query(Trade.symbol, Trade.market).filter(
            Trade.account_id == account_id
        ).distinct()
        
        try:
            from services.replay_service import get_replay_date_range
            replay_range = get_replay_date_range()
            if replay_range:
                start_date, current_date = replay_range
                symbols_query_base = symbols_query_base.filter(
                    Trade.trade_time >= start_date,
                    Trade.trade_time <= current_date
                )
                logging.info(f"Filtering symbols query for replay mode: {start_date} to {current_date}")
        except Exception:
            pass  # If replay service not available, continue without filter
        
        symbols_query = symbols_query_base.all()
        
        unique_symbols = set()
        for symbol, market in symbols_query:
            unique_symbols.add((symbol, market))
        
        if not unique_symbols:
            # No trades yet, return initial capital
            now = datetime.now()
            return [{
                "timestamp": int(now.timestamp()),
                "datetime_str": now.isoformat(),
                "account_id": account.id,
                "user_id": account.user_id,
                "username": account.name,
                "total_assets": float(account.initial_capital),
                "initial_capital": float(account.initial_capital),
                "profit": 0.0,
                "profit_percentage": 0.0,
                "cash": float(account.initial_capital),
                "positions_value": 0.0,
                "is_active": account.is_active == "true",
            }]
        
        # Get kline data for account's symbols
        # In replay mode, generate timestamps based on replay period; otherwise use latest kline data
        symbol_klines = {}
        timestamps = []
        replay_start_date = None
        replay_current_date = None
        
        try:
            from services.replay_service import get_replay_date_range
            replay_range = get_replay_date_range()
            if replay_range:
                replay_start_date, replay_current_date = replay_range
                logging.info(f"Replay mode active: generating timestamps from {replay_start_date} to {replay_current_date}")
                
                # Generate timestamps based on timeframe within replay period
                timestamps = _generate_timestamps_for_replay(replay_start_date, replay_current_date, timeframe)
                logging.info(f"Generated {len(timestamps)} timestamps for replay period")
                
                # For each symbol, fetch historical prices for these timestamps
                for symbol, market in unique_symbols:
                    try:
                        klines = []
                        for ts in timestamps:
                            ts_datetime = datetime.fromtimestamp(ts, tz=timezone.utc)
                            # Use replay_service to get historical price
                            from services.replay_service import get_historical_price
                            price = get_historical_price(symbol, market, ts_datetime)
                            if price is not None:
                                klines.append({
                                    'timestamp': ts,
                                    'datetime_str': ts_datetime.isoformat(),
                                    'close': price,
                                    'open': price,  # Use same price for open/close in replay
                                    'high': price,
                                    'low': price,
                                })
                        if klines:
                            symbol_klines[(symbol, market)] = klines
                            logging.info(f"Fetched {len(klines)} historical prices for {symbol}.{market} (replay period)")
                    except Exception as e:
                        logging.warning(f"Failed to fetch historical prices for {symbol}.{market}: {e}")
        except Exception:
            pass  # Not in replay mode
        
        # If not in replay mode or replay mode failed, use normal kline data
        if not timestamps or not symbol_klines:
            for symbol, market in unique_symbols:
                try:
                    klines = get_kline_data(symbol, market, timeframe, 20)
                    if klines:
                        symbol_klines[(symbol, market)] = klines
                        logging.info(f"Fetched {len(klines)} klines for {symbol}.{market}")
                except Exception as e:
                    logging.warning(f"Failed to fetch klines for {symbol}.{market}: {e}")
            
            if not symbol_klines:
                # Fallback: return initial capital
                fallback_time = datetime.now(timezone.utc)
                return [{
                    "timestamp": int(fallback_time.timestamp()),
                    "datetime_str": fallback_time.isoformat(),
                    "account_id": account.id,
                    "user_id": account.user_id,
                    "username": account.name,
                    "total_assets": float(account.initial_capital),
                    "initial_capital": float(account.initial_capital),
                    "profit": 0.0,
                    "profit_percentage": 0.0,
                    "cash": float(account.initial_capital),
                    "positions_value": 0.0,
                    "is_active": account.is_active == "true",
                }]
            
            # Get timestamps from kline data
            first_klines = next(iter(symbol_klines.values()))
            timestamps = [k['timestamp'] for k in first_klines]
        
        # Create timeline for this account
        timeline = _create_account_timeline(db, account, timestamps, symbol_klines)
        
        return timeline
        
    except Exception as e:
        logging.error(f"Failed to get account asset curve for account {account_id}: {e}")
        return []