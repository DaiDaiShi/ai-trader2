"""
Replay/Backtest Service - Simulates trading using historical price data
"""
import logging
from datetime import datetime, timedelta
from typing import Dict, Optional, List, Tuple
from decimal import Decimal
from sqlalchemy.orm import Session

from database.connection import SessionLocal
from database.models import SystemConfig, Account, Position, Order, Trade
from services.market_data import get_kline_data

logger = logging.getLogger(__name__)

# Global replay state
_replay_state: Optional[Dict] = None


def reset_all_accounts_for_replay(db: Session, trading_interval_seconds: int = 86400) -> None:
    """
    Reset all accounts for replay mode:
    - Reset cash to initial_capital
    - Clear all positions, orders, and trades
    - Set trading interval for replay mode
    
    Args:
        db: Database session
        trading_interval_seconds: Trading interval in seconds (86400 for 1d, 604800 for 7d)
    """
    try:
        # Get all accounts
        accounts = db.query(Account).all()
        if not accounts:
            logger.warning("No accounts found to reset for replay mode")
            # Still set the trading interval even if no accounts
        else:
            logger.info(f"Resetting {len(accounts)} accounts for replay mode")
        
        # Store original trading interval before resetting
        original_interval_cfg = db.query(SystemConfig).filter(SystemConfig.key == "auto_trade_interval_seconds").first()
        original_interval = original_interval_cfg.value if original_interval_cfg else "300"
        
        # Save original interval for restoration later
        replay_original_interval_cfg = db.query(SystemConfig).filter(SystemConfig.key == "replay_original_interval").first()
        if replay_original_interval_cfg:
            replay_original_interval_cfg.value = original_interval
        else:
            replay_original_interval_cfg = SystemConfig(
                key="replay_original_interval",
                value=original_interval,
                description="Original trading interval before replay mode"
            )
            db.add(replay_original_interval_cfg)
        
        # Set replay trading interval
        if original_interval_cfg:
            original_interval_cfg.value = str(trading_interval_seconds)
        else:
            original_interval_cfg = SystemConfig(
                key="auto_trade_interval_seconds",
                value=str(trading_interval_seconds),
                description="Auto trading interval in seconds (replay mode)"
            )
            db.add(original_interval_cfg)
        
        # Reset each account (if any exist)
        for account in accounts:
            try:
                # Reset cash to initial capital
                account.current_cash = account.initial_capital
                account.frozen_cash = Decimal('0.00')
                account.margin_used = Decimal('0.00')
                
                # Delete trades first (they reference orders)
                trades_deleted = db.query(Trade).filter(Trade.account_id == account.id).delete()
                
                # Delete orders (they reference positions)
                orders_deleted = db.query(Order).filter(Order.account_id == account.id).delete()
                
                # Delete positions last
                positions_deleted = db.query(Position).filter(Position.account_id == account.id).delete()
                
                logger.info(
                    f"Reset account {account.name} (ID: {account.id}): "
                    f"cash=${account.initial_capital}, deleted {positions_deleted} positions, "
                    f"{orders_deleted} orders, {trades_deleted} trades"
                )
            except Exception as account_err:
                logger.error(f"Failed to reset account {account.name} (ID: {account.id}): {account_err}", exc_info=True)
                raise
        
        db.commit()
        logger.info(f"✅ All accounts reset for replay mode. Trading interval set to {trading_interval_seconds}s ({trading_interval_seconds // 86400}d)")
        
    except Exception as e:
        logger.error(f"Failed to reset accounts for replay: {e}", exc_info=True)
        db.rollback()
        raise


def restore_trading_interval_after_replay(db: Session) -> None:
    """Restore original trading interval after replay mode ends"""
    try:
        # Get original interval
        original_interval_cfg = db.query(SystemConfig).filter(SystemConfig.key == "replay_original_interval").first()
        if not original_interval_cfg or not original_interval_cfg.value:
            logger.warning("No original trading interval found, using default 300s")
            original_interval = "300"
        else:
            original_interval = original_interval_cfg.value
        
        # Restore original interval
        interval_cfg = db.query(SystemConfig).filter(SystemConfig.key == "auto_trade_interval_seconds").first()
        if interval_cfg:
            interval_cfg.value = original_interval
        else:
            interval_cfg = SystemConfig(
                key="auto_trade_interval_seconds",
                value=original_interval,
                description="Auto trading interval in seconds"
            )
            db.add(interval_cfg)
        
        db.commit()
        logger.info(f"✅ Restored trading interval to {original_interval}s after replay")
        
        # Reset auto trading job with restored interval
        try:
            from services.scheduler import reset_auto_trading_job
            reset_auto_trading_job()
        except Exception as e:
            logger.warning(f"Failed to reset auto trading job after replay: {e}")
        
    except Exception as e:
        logger.error(f"Failed to restore trading interval: {e}", exc_info=True)
        db.rollback()


def start_replay(start_date: datetime, end_date: datetime, speed_multiplier: float = 1.0, trading_interval_days: int = 1) -> Dict:
    """
    Start replay mode with historical data
    
    Args:
        start_date: Start date for replay
        end_date: End date for replay
        speed_multiplier: Speed multiplier (1.0 = real-time, 2.0 = 2x speed, etc.)
        trading_interval_days: Trading interval in days (1 for daily, 7 for weekly)
    
    Returns:
        Replay state dictionary
    """
    global _replay_state
    
    if _replay_state and _replay_state.get('active'):
        raise ValueError("Replay mode is already active. Stop it first.")
    
    # Validate dates
    if start_date >= end_date:
        raise ValueError("Start date must be before end date")
    
    # Allow end date to be today (compare dates only, not time)
    now = datetime.now()
    if end_date.date() > now.date():
        raise ValueError("End date cannot be in the future")
    
    # Validate trading interval
    if trading_interval_days not in [1, 7]:
        raise ValueError("Trading interval must be 1 (daily) or 7 (weekly) days")
    
    # Convert trading interval to seconds
    trading_interval_seconds = trading_interval_days * 86400  # 1d = 86400s, 7d = 604800s
    
    # Store replay state
    _replay_state = {
        'active': True,
        'start_date': start_date,
        'end_date': end_date,
        'current_date': start_date,
        'speed_multiplier': speed_multiplier,
        'trading_interval_days': trading_interval_days,
        'price_cache': {},  # Cache historical prices by symbol and timestamp
        'started_at': datetime.now(),
    }
    
    logger.info(f"Replay mode starting: {start_date} to {end_date} (speed: {speed_multiplier}x, interval: {trading_interval_days}d)")
    
    # Reset all accounts and set trading interval
    db = SessionLocal()
    try:
        logger.info("Resetting all accounts for replay...")
        reset_all_accounts_for_replay(db, trading_interval_seconds)
        logger.info("Saving replay config...")
        _save_replay_config(db, start_date, end_date, speed_multiplier)
        logger.info("Replay setup completed successfully")
    except Exception as e:
        logger.error(f"Failed to setup replay mode: {e}", exc_info=True)
        # Reset replay state if setup failed
        _replay_state = None
        db.rollback()
        raise
    finally:
        db.close()
    
    # Reset auto trading job AFTER database operations complete (it will skip if replay is active)
    try:
        from services.scheduler import reset_auto_trading_job
        logger.info("Resetting auto trading job...")
        reset_auto_trading_job()
    except Exception as e:
        logger.warning(f"Failed to reset auto trading job (non-critical): {e}")
    
    logger.info(f"✅ Replay mode started successfully")
    return _replay_state.copy()


def stop_replay() -> None:
    """Stop replay mode and restore normal trading interval"""
    global _replay_state
    
    if _replay_state:
        logger.info(f"Replay mode stopping. Replayed from {_replay_state['start_date']} to {_replay_state['current_date']}")
        _replay_state = None
    
    # Restore trading interval and clear replay config
    db = SessionLocal()
    try:
        restore_trading_interval_after_replay(db)
        _clear_replay_config(db)
    finally:
        db.close()
    
    logger.info("✅ Replay mode stopped and trading interval restored")


def get_replay_state() -> Optional[Dict]:
    """Get current replay state"""
    return _replay_state.copy() if _replay_state else None


def is_replay_active() -> bool:
    """Check if replay mode is active"""
    return _replay_state is not None and _replay_state.get('active', False)


def get_historical_price(symbol: str, market: str, timestamp: datetime) -> Optional[float]:
    """
    Get historical price for a symbol at a specific timestamp
    
    Args:
        symbol: Trading symbol
        market: Market (e.g., 'CRYPTO')
        timestamp: Timestamp to get price for
    
    Returns:
        Historical price or None if not available
    """
    if not is_replay_active():
        return None
    
    global _replay_state
    
    # Ensure timestamp is within replay period
    if timestamp < _replay_state['start_date']:
        timestamp = _replay_state['start_date']
    if timestamp > _replay_state['current_date']:
        timestamp = _replay_state['current_date']
    
    # Use daily kline data - find the closest daily candle
    # Round timestamp to start of day for daily candles
    day_start = timestamp.replace(hour=0, minute=0, second=0, microsecond=0)
    
    cache_key = f"{symbol}_{market}_{day_start.timestamp()}"
    
    # Check cache first
    if cache_key in _replay_state['price_cache']:
        return _replay_state['price_cache'][cache_key]
    
    # Fetch historical kline data
    try:
        # Use 'since' parameter to fetch historical data starting from replay start_date
        # Convert start_date to milliseconds timestamp for CCXT
        since_ms = int(_replay_state['start_date'].timestamp() * 1000)
        
        # Calculate how many candles we need to cover the replay period
        days_in_replay = (_replay_state['current_date'] - _replay_state['start_date']).days + 1
        count = min(max(days_in_replay + 5, 20), 500)  # Add buffer, limit to 500
        
        logger.debug(f"Fetching {count} daily candles for {symbol} starting from {_replay_state['start_date']} (since={since_ms})")
        kline_data = get_kline_data(symbol, market, period='1d', count=count, since=since_ms)
        
        if not kline_data:
            logger.warning(f"No kline data found for {symbol} at {day_start}")
            return None
        
        # Filter candles to only those within replay period, then find closest
        replay_candles = []
        for candle in kline_data:
            candle_timestamp = candle.get('timestamp', 0)
            if isinstance(candle_timestamp, (int, float)):
                candle_time = datetime.fromtimestamp(candle_timestamp)
                # Only consider candles within replay period
                if _replay_state['start_date'] <= candle_time <= _replay_state['current_date']:
                    replay_candles.append(candle)
        
        if not replay_candles:
            logger.warning(f"No kline data found within replay period for {symbol} (period: {_replay_state['start_date']} to {_replay_state['current_date']})")
            return None
        
        # Find the closest candle to our requested day
        closest_candle = None
        min_diff = float('inf')
        
        for candle in replay_candles:
            candle_timestamp = candle.get('timestamp', 0)
            if isinstance(candle_timestamp, (int, float)):
                candle_time = datetime.fromtimestamp(candle_timestamp)
                candle_day_start = candle_time.replace(hour=0, minute=0, second=0, microsecond=0)
                diff = abs((candle_day_start - day_start).total_seconds())
                if diff < min_diff:
                    min_diff = diff
                    closest_candle = candle
        
        if closest_candle:
            # Use close price (or open if close not available)
            price = closest_candle.get('close') or closest_candle.get('open')
            if price:
                cached_price = float(price)
                _replay_state['price_cache'][cache_key] = cached_price
                logger.debug(f"Found historical price for {symbol} at {day_start}: {cached_price}")
                return cached_price
    except Exception as e:
        logger.error(f"Failed to get historical price for {symbol} at {timestamp}: {e}", exc_info=True)
    
    return None


def advance_replay_time(seconds: int) -> Optional[datetime]:
    """
    Advance replay time by specified seconds
    
    Args:
        seconds: Seconds to advance
    
    Returns:
        New current date or None if replay ended
    """
    if not is_replay_active():
        return None
    
    global _replay_state
    
    # Apply speed multiplier
    actual_seconds = int(seconds * _replay_state['speed_multiplier'])
    new_date = _replay_state['current_date'] + timedelta(seconds=actual_seconds)
    
    # Check if we've reached the end
    if new_date >= _replay_state['end_date']:
        _replay_state['current_date'] = _replay_state['end_date']
        logger.info("Replay reached end date")
        return _replay_state['current_date']
    
    _replay_state['current_date'] = new_date
    return new_date


def get_current_replay_date() -> Optional[datetime]:
    """Get current date in replay mode"""
    if not is_replay_active():
        return None
    return _replay_state['current_date']


def get_replay_date_range() -> Optional[Tuple[datetime, datetime]]:
    """
    Get the replay date range (start_date, current_date) if replay is active.
    Returns None if replay is not active.
    
    Returns:
        Tuple of (start_date, current_date) or None
    """
    if not is_replay_active():
        return None
    return (_replay_state['start_date'], _replay_state['current_date'])


def _save_replay_config(db: Session, start_date: datetime, end_date: datetime, speed_multiplier: float) -> None:
    """Save replay configuration to database"""
    try:
        config_data = {
            'start_date': start_date.isoformat(),
            'end_date': end_date.isoformat(),
            'speed_multiplier': speed_multiplier,
            'active': True
        }
        
        import json
        cfg = db.query(SystemConfig).filter(SystemConfig.key == "replay_config").first()
        if cfg:
            cfg.value = json.dumps(config_data)
        else:
            cfg = SystemConfig(
                key="replay_config",
                value=json.dumps(config_data),
                description="Replay/backtest configuration"
            )
            db.add(cfg)
        
        db.commit()
    except Exception as e:
        logger.error(f"Failed to save replay config: {e}")
        db.rollback()


def _clear_replay_config(db: Session) -> None:
    """Clear replay configuration from database"""
    try:
        cfg = db.query(SystemConfig).filter(SystemConfig.key == "replay_config").first()
        if cfg:
            cfg.value = '{}'
            db.commit()
    except Exception as e:
        logger.error(f"Failed to clear replay config: {e}")
        db.rollback()
