import logging
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .db import get_db
from .models.user import User
from .security import decode_access_token

logger = logging.getLogger(__name__)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def get_current_user(
    token: str = Depends(oauth2_scheme), 
    db: Session = Depends(get_db)
) -> User:
    """
    Получает текущего авторизованного пользователя из токена.
    """
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, 
            detail="Токен не предоставлен. Пожалуйста, войдите заново."
        )
    
    try:
        payload = decode_access_token(token)
        
        user_id_str = payload.get("sub")
        
        if not user_id_str:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, 
                detail="Токен не содержит идентификатор пользователя"
            )
        
        try:
            user_id = int(user_id_str)
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, 
                detail=f"Неверный формат идентификатора пользователя в токене: {user_id_str}"
            )
        
    except HTTPException:
        # Пробрасываем HTTPException дальше
        raise
    except Exception as e:
        # Проверяем конкретные типы ошибок
        error_str = str(e).lower()
        if "expired" in error_str or "exp" in error_str:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, 
                detail="Токен истек. Пожалуйста, войдите заново."
            )
        elif "signature" in error_str or "invalid" in error_str:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, 
                detail="Неверный токен. Пожалуйста, войдите заново."
            )
        else:
            logger.error(f"Ошибка при проверке токена: {e}")
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, 
                detail="Не удалось проверить токен. Пожалуйста, войдите заново."
            )

    # Поиск пользователя в БД
    user = db.get(User, user_id)
    
    if user is None:
        logger.error(f"Пользователь с id={user_id} не найден в БД")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, 
            detail=f"Пользователь с id={user_id} не найден в базе данных"
        )
    
    return user


