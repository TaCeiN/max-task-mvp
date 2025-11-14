import time
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Any, Dict
import json
from urllib.parse import parse_qsl

from ..db import get_db
from ..models.user import User
from ..schemas import UserCreate, UserOut, Token, LoginRequest
from ..security import create_access_token
from ..deps import get_current_user


router = APIRouter(prefix="/auth", tags=["auth"]) 
logger = logging.getLogger(__name__)


@router.post("/register", response_model=UserOut)
def register(payload: UserCreate, db: Session = Depends(get_db)):
    try:
        # Проверяем, существует ли пользователь с таким username
        existing_username = db.query(User).filter(User.username == payload.username).first()
        if existing_username is not None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Пользователь с таким именем уже зарегистрирован")
        
        # Проверяем, существует ли пользователь с таким uuid
        existing_uuid = db.query(User).filter(User.uuid == payload.uuid).first()
        if existing_uuid is not None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Пользователь с таким UUID уже зарегистрирован")

        user = User(username=payload.username, uuid=payload.uuid)
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ошибка в register: {e}")
        db.rollback()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Внутренняя ошибка сервера: {str(e)}")


@router.post("/login", response_model=Token)
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    try:
        user = db.query(User).filter(User.username == payload.username).first()
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Неверные учетные данные")
        
        # Проверяем UUID
        if user.uuid != payload.uuid:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Неверные учетные данные")

        token = create_access_token(str(user.id))
        return Token(access_token=token)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Ошибка в login: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Внутренняя ошибка сервера: {str(e)}")


# ---- WebApp initData auth (авто-логин из мини-приложения) ----
class WebAppInit(BaseModel):
    initData: str


def _parse_init_data(raw: str) -> Dict[str, Any]:
    """Пытаемся распарсить initData из WebApp.
    Поддерживаем 2 формата: JSON и URL-encoded (key=value&...).
    ВАЖНО: проверка подписи должна быть добавлена по документации Max WebApps.
    """
    raw = (raw or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="initData is empty")

    # Попытка распарсить JSON
    if raw.startswith("{"):
        try:
            return json.loads(raw)
        except Exception:
            raise HTTPException(status_code=400, detail="Malformed JSON in initData")

    # Попытка распарсить URL-encoded строку
    try:
        pairs = dict(parse_qsl(raw, keep_blank_values=True))
        # В некоторых реализациях user может быть закодирован как JSON-строка
        if "user" in pairs:
            try:
                pairs["user"] = json.loads(pairs["user"]) if isinstance(pairs["user"], str) else pairs["user"]
            except Exception:
                # оставляем как есть, если не JSON
                pass
        return pairs
    except Exception:
        raise HTTPException(status_code=400, detail="Unsupported initData format")


@router.post("/webapp-init", response_model=Token)
def auth_webapp(body: WebAppInit, db: Session = Depends(get_db)):
    data = _parse_init_data(body.initData)

    # TODO: ПРОВЕРКА ПОДПИСИ initData (HMAC и срок годности) согласно Max WebApps.
    # Сейчас проверка отключена для дев-окружения. НЕ ОСТАВЛЯЙТЕ ТАК В PROD!

    # Извлекаем пользователя из initData
    user = None
    if isinstance(data, dict):
        # Пытаемся получить user из разных мест
        user = data.get("user")
        
        # Если user - строка, пытаемся распарсить как JSON
        if isinstance(user, str):
            try:
                user = json.loads(user)
            except Exception:
                pass
        
        # Если user не найден, проверяем другие варианты
        if not user or not isinstance(user, dict):
            user = data.get("init_data", {}).get("user") if isinstance(data.get("init_data"), dict) else None
        
        # Если user все еще не найден, проверяем верхний уровень
        if not user or not isinstance(user, dict):
            candidate = {k: data.get(k) for k in ("user_id", "id", "first_name", "last_name", "username", "name") if k in data}
            user = candidate if candidate else None
    
    if not user or not isinstance(user, dict):
        logger.error("No user found in initData")
        raise HTTPException(status_code=400, detail="No user in initData")

    user_id = user.get("user_id") or user.get("id")
    if not user_id:
        logger.error("No user_id found in user object")
        raise HTTPException(status_code=400, detail="No user id in initData.user")

    # Формируем имя пользователя: first_name + last_name или username или fallback
    first_name = user.get("first_name") or user.get("name") or ""
    last_name = user.get("last_name") or ""
    username_from_user = user.get("username")
    
    # Собираем полное имя
    if first_name and last_name:
        full_name = f"{first_name} {last_name}".strip()
    elif first_name:
        full_name = first_name
    elif username_from_user:
        full_name = username_from_user
    else:
        full_name = f"user_{user_id}"
    
    # Используем username из Max, если есть, иначе используем полное имя
    # Для уникальности добавляем префикс max_ если нет username
    if username_from_user:
        username = username_from_user
    else:
        username = f"max_{user_id}_{full_name}".strip()
    
    uuid = str(user_id)

    # --- FIX: Повторные попытки для решения race condition ---
    # Проблема: webhook-сервер и API-сервер работают в разных процессах.
    # bot_started создает юзера через webhook, а фронтенд почти одновременно стучится в /webapp-init.
    # Из-за задержки репликации или транзакции, /webapp-init может не найти юзера и попытаться создать своего,
    # что вызовет ошибку уникальности (конфликт по uuid).
    # Решение: сделать несколько попыток с небольшой задержкой, чтобы дать webhook-серверу время.
    
    existing = None
    max_search_attempts = 10  # Увеличено до 10 попыток (всего до 5 секунд ожидания)
    for attempt in range(max_search_attempts):
        existing = db.query(User).filter(User.uuid == uuid).first()
        if existing:
            break
        if attempt < max_search_attempts - 1:
            time.sleep(0.5)  # задержка 0.5 секунды
    # ---------------------------------------------------------
    
    if existing:
        # Пользователь уже есть в БД (был сохранен при bot_started через вебхук)
        
        # Обновляем username, если он изменился
        updated = False
        if username_from_user and existing.username != username_from_user:
            existing.username = username_from_user
            updated = True
        elif not username_from_user and existing.username != username:
            existing.username = username
            updated = True
        
        if updated:
            db.add(existing)
            db.commit()
            db.refresh(existing)
        
        # Возвращаем токен для существующего пользователя
        token = create_access_token(str(existing.id))
        return Token(access_token=token)

    # если юзера нет в БД — создаем (fallback, если вебхук не пришел)
    # дополнительно проверим уникальность username
    
    # Сохраняем оригинальный username для использования
    base_username = username
    
    # Пытаемся создать пользователя с обработкой ошибок уникальности
    max_creation_attempts = 3
    new_user = None
    
    for creation_attempt in range(max_creation_attempts):
        try:
            # Проверяем, не появился ли пользователь в БД за это время
            existing = db.query(User).filter(User.uuid == uuid).first()
            if existing:
                new_user = existing
                break
            
            # Формируем username для текущей попытки
            current_username = base_username
            if creation_attempt > 0:
                # Для повторных попыток добавляем суффикс
                current_username = f"{base_username}_{user_id}_{creation_attempt}"
            else:
                # Для первой попытки проверяем, не занят ли username
                if db.query(User).filter(User.username == base_username).first() is not None:
                    current_username = f"{base_username}_{user_id}"
            
            # Создаем нового пользователя
            new_user = User(username=current_username, uuid=uuid)
            db.add(new_user)
            db.commit()
            db.refresh(new_user)
            break
            
        except Exception as e:
            db.rollback()
            error_str = str(e).lower()
            
            # Импортируем IntegrityError для проверки ошибок уникальности
            from sqlalchemy.exc import IntegrityError
            
            # Проверяем, является ли ошибка ошибкой уникальности (uuid или username)
            if isinstance(e, IntegrityError) or "unique" in error_str or "duplicate" in error_str or "constraint" in error_str:
                # Если ошибка по uuid, значит пользователь был создан параллельно (через вебхук)
                # Пытаемся найти его в БД
                if "uuid" in error_str or "uuid" in str(e) or (isinstance(e, IntegrityError) and "uuid" in str(e.orig).lower()):
                    # Делаем дополнительную попытку найти пользователя
                    for retry in range(3):
                        time.sleep(0.3)
                        existing = db.query(User).filter(User.uuid == uuid).first()
                        if existing:
                            new_user = existing
                            break
                    
                    if new_user:
                        break
                
                # Если ошибка по username, пробуем с другим username
                if new_user is None and creation_attempt < max_creation_attempts - 1:
                    continue
                else:
                    # Если не удалось создать, пытаемся найти пользователя по uuid
                    existing = db.query(User).filter(User.uuid == uuid).first()
                    if existing:
                        new_user = existing
                        break
                    else:
                        # Если это последняя попытка и пользователь не найден, пробуем еще раз
                        if creation_attempt < max_creation_attempts - 1:
                            time.sleep(0.5)
                            continue
                        else:
                            logger.error(f"Не удалось создать пользователя и найти его в БД после {max_creation_attempts} попыток")
                            raise HTTPException(
                                status_code=500, 
                                detail=f"Не удалось создать или найти пользователя после {max_creation_attempts} попыток. Попробуйте позже."
                            )
            else:
                # Другая ошибка
                logger.error(f"Ошибка при создании пользователя: {e}")
                if creation_attempt < max_creation_attempts - 1:
                    time.sleep(0.5)
                    continue
                else:
                    raise HTTPException(status_code=500, detail=f"Ошибка при создании пользователя: {str(e)}")
    
    # Проверяем, что пользователь был создан или найден
    if not new_user:
        logger.error("Пользователь не был создан и не найден в БД")
        raise HTTPException(status_code=500, detail="Не удалось создать или найти пользователя")
    
    # Обновляем username, если он изменился (используем username_from_user из initData)
    if username_from_user and new_user.username != username_from_user:
        try:
            # Проверяем, не занят ли новый username
            existing_username = db.query(User).filter(User.username == username_from_user).filter(User.id != new_user.id).first()
            if not existing_username:
                new_user.username = username_from_user
                db.add(new_user)
                db.commit()
                db.refresh(new_user)
        except Exception as e:
            logger.warning(f"Не удалось обновить username: {e}")
            db.rollback()
    
    # Возвращаем токен для созданного или найденного пользователя
    token = create_access_token(str(new_user.id))
    return Token(access_token=token)


@router.get("/me", response_model=UserOut)
def get_me(user: User = Depends(get_current_user)):
    """
    Получает данные текущего авторизованного пользователя.
    Используется для получения информации о пользователе после авторизации.
    """
    # Конвертируем created_at в строку перед возвратом модели
    # Это необходимо, так как Pydantic v2 с from_attributes=True может не вызывать field_serializer правильно
    user_dict = {
        "id": user.id,
        "username": user.username,
        "uuid": user.uuid,
        "created_at": user.created_at.isoformat() if isinstance(user.created_at, datetime) else str(user.created_at)
    }
    return UserOut(**user_dict)

