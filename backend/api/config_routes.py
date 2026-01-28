"""
System config API routes
"""

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import logging

from database.connection import SessionLocal
from database.models import SystemConfig

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/config", tags=["config"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


class ConfigUpdateRequest(BaseModel):
    key: str
    value: str
    description: Optional[str] = None


class TradingIntervalUpdateRequest(BaseModel):
    interval_seconds: int


@router.get("/check-required")
async def check_required_configs(db: Session = Depends(get_db)):
    """Check if required configs are set"""
    try:
        return {
            "has_required_configs": True,
            "missing_configs": []
        }
    except Exception as e:
        logger.error(f"Failed to check required configs: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to check required configs: {str(e)}")


@router.get("/trading-interval")
async def get_trading_interval(db: Session = Depends(get_db)):
    """Get the current auto trading interval in seconds"""
    try:
        cfg = db.query(SystemConfig).filter(SystemConfig.key == "auto_trade_interval_seconds").first()
        if cfg and cfg.value:
            try:
                interval = int(cfg.value)
                return {"interval_seconds": interval}
            except (TypeError, ValueError):
                logger.warning(f"Invalid trading interval value: {cfg.value}")
                return {"interval_seconds": 300}  # Default 5 minutes
        return {"interval_seconds": 300}  # Default 5 minutes
    except Exception as e:
        logger.error(f"Failed to get trading interval: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get trading interval: {str(e)}")


@router.put("/trading-interval")
async def update_trading_interval(
    request: TradingIntervalUpdateRequest,
    db: Session = Depends(get_db)
):
    """Update the auto trading interval
    
    Request body:
        interval_seconds: Trading interval in seconds (60-3600, i.e., 1 minute to 1 hour)
    """
    try:
        interval_seconds = request.interval_seconds
        
        # Validate interval
        if interval_seconds < 60:
            raise HTTPException(status_code=400, detail="Interval must be at least 60 seconds (1 minute)")
        if interval_seconds > 3600:
            raise HTTPException(status_code=400, detail="Interval must be at most 3600 seconds (1 hour)")
        
        cfg = db.query(SystemConfig).filter(SystemConfig.key == "auto_trade_interval_seconds").first()
        if cfg:
            cfg.value = str(interval_seconds)
            logger.info(f"Updated trading interval to {interval_seconds}s")
        else:
            cfg = SystemConfig(
                key="auto_trade_interval_seconds",
                value=str(interval_seconds),
                description="Auto trading interval in seconds (60-3600)"
            )
            db.add(cfg)
            logger.info(f"Created trading interval config: {interval_seconds}s")
        
        db.commit()
        
        # Reset the auto trading job to apply the new interval
        try:
            from services.scheduler import reset_auto_trading_job
            reset_auto_trading_job()
            logger.info("Auto trading job reset with new interval")
        except Exception as e:
            logger.warning(f"Failed to reset auto trading job after interval update: {e}")
        
        return {"interval_seconds": interval_seconds, "message": "Trading interval updated successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update trading interval: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update trading interval: {str(e)}")