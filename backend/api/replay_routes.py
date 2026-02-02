"""
Replay/Backtest API Routes
"""
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from datetime import datetime
from typing import Optional
import logging

from sqlalchemy.orm import Session
from database.connection import get_db
from services.replay_service import (
    start_replay,
    stop_replay,
    get_replay_state,
    is_replay_active,
    advance_replay_time,
    get_current_replay_date
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/replay", tags=["replay"])


class ReplayStartRequest(BaseModel):
    start_date: str  # ISO format datetime string
    end_date: str    # ISO format datetime string
    speed_multiplier: float = 1.0
    trading_interval_days: int = 1  # 1 for daily, 7 for weekly


class ReplayAdvanceRequest(BaseModel):
    seconds: int = 300  # Default 5 minutes


@router.post("/start")
async def start_replay_mode(request: ReplayStartRequest, db: Session = Depends(get_db)):
    """Start replay/backtest mode"""
    try:
        logger.info(f"Received replay start request: start_date={request.start_date}, end_date={request.end_date}, speed={request.speed_multiplier}")
        
        # Parse ISO datetime strings
        start_date_str = request.start_date.replace('Z', '+00:00')
        end_date_str = request.end_date.replace('Z', '+00:00')
        
        try:
            start_date = datetime.fromisoformat(start_date_str)
            end_date = datetime.fromisoformat(end_date_str)
        except ValueError as parse_err:
            logger.error(f"Failed to parse dates: start={request.start_date}, end={request.end_date}, error={parse_err}")
            raise HTTPException(status_code=400, detail=f"Invalid date format: {str(parse_err)}")
        
        # Remove timezone for comparison
        if start_date.tzinfo:
            start_date = start_date.replace(tzinfo=None)
        if end_date.tzinfo:
            end_date = end_date.replace(tzinfo=None)
        
        logger.info(f"Parsed dates: start_date={start_date}, end_date={end_date}, trading_interval_days={request.trading_interval_days}")
        
        # Validate trading interval
        if request.trading_interval_days not in [1, 7]:
            raise HTTPException(status_code=400, detail="Trading interval must be 1 (daily) or 7 (weekly) days")
        
        state = start_replay(start_date, end_date, request.speed_multiplier, request.trading_interval_days)
        
        return {
            "success": True,
            "message": "Replay mode started",
            "state": {
                "start_date": state['start_date'].isoformat(),
                "end_date": state['end_date'].isoformat(),
                "current_date": state['current_date'].isoformat(),
                "speed_multiplier": state['speed_multiplier'],
                "trading_interval_days": state.get('trading_interval_days', 1),
                "active": state['active']
            }
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to start replay mode: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to start replay mode: {str(e)}")


@router.post("/stop")
async def stop_replay_mode(db: Session = Depends(get_db)):
    """Stop replay/backtest mode"""
    try:
        stop_replay()
        return {
            "success": True,
            "message": "Replay mode stopped"
        }
    except Exception as e:
        logger.error(f"Failed to stop replay mode: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to stop replay mode: {str(e)}")


@router.get("/state")
async def get_replay_mode_state(db: Session = Depends(get_db)):
    """Get current replay mode state"""
    try:
        state = get_replay_state()
        if not state:
            return {
                "active": False,
                "state": None
            }
        
        return {
            "active": True,
            "state": {
                "start_date": state['start_date'].isoformat(),
                "end_date": state['end_date'].isoformat(),
                "current_date": state['current_date'].isoformat(),
                "speed_multiplier": state['speed_multiplier'],
                "trading_interval_days": state.get('trading_interval_days', 1),
                "progress": ((state['current_date'] - state['start_date']).total_seconds() / 
                             (state['end_date'] - state['start_date']).total_seconds() * 100) if state['end_date'] > state['start_date'] else 0
            }
        }
    except Exception as e:
        logger.error(f"Failed to get replay state: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get replay state: {str(e)}")


@router.post("/advance")
async def advance_replay(request: ReplayAdvanceRequest, db: Session = Depends(get_db)):
    """Advance replay time and trigger trading"""
    try:
        if not is_replay_active():
            raise HTTPException(status_code=400, detail="Replay mode is not active")
        
        new_date = advance_replay_time(request.seconds)
        
        if new_date is None:
            return {
                "success": False,
                "message": "Replay has ended",
                "current_date": None
            }
        
        # Trigger trading at the new time point
        try:
            from services.trading_commands import place_ai_driven_crypto_order
            logger.info(f"🔄 Replay advanced to {new_date} - triggering AI trading...")
            place_ai_driven_crypto_order(max_ratio=0.2)
            logger.info(f"✅ AI trading completed for replay date {new_date}")
        except Exception as trade_err:
            logger.error(f"❌ Failed to execute trading during replay advance: {trade_err}", exc_info=True)
        
        # Broadcast updated snapshots to all connected accounts
        try:
            from api.ws import broadcast_snapshots_to_all_accounts_sync
            broadcast_snapshots_to_all_accounts_sync()
            logger.info("Broadcasted snapshots to all accounts after replay advance")
        except Exception as broadcast_err:
            logger.warning(f"Failed to broadcast snapshots after replay advance: {broadcast_err}")
        
        return {
            "success": True,
            "current_date": new_date.isoformat(),
            "message": f"Replay advanced by {request.seconds} seconds"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to advance replay: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to advance replay: {str(e)}")
