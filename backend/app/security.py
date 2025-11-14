import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import jwt
from jose.exceptions import ExpiredSignatureError, JWTError, JWTClaimsError

from .core.config import settings

logger = logging.getLogger(__name__)


def create_access_token(subject: str, expires_minutes: Optional[int] = None) -> str:
    expire_delta = expires_minutes or settings.access_token_expire_minutes
    expire = datetime.now(tz=timezone.utc) + timedelta(minutes=expire_delta)
    to_encode = {"sub": subject, "exp": expire}
    
    token = jwt.encode(to_encode, settings.secret_key, algorithm="HS256")
    return token


def decode_access_token(token: str) -> dict:
    """
    Декодирует JWT токен.
    """
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        return payload
        
    except ExpiredSignatureError:
        logger.error("Токен истек")
        raise
    except JWTClaimsError as e:
        logger.error(f"Неверные claims в токене: {e}")
        raise
    except JWTError as e:
        logger.error(f"Ошибка JWT: {e}")
        raise
    except Exception as e:
        logger.error(f"Ошибка при декодировании токена: {e}")
        raise 


