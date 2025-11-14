#!/usr/bin/env python3
"""
Отдельный сервер для приема вебхуков от Max Bot API.
Запускается на отдельном порту для удобного логирования.

Использование:
    python webhook_server.py
Или с указанием порта:
    WEBHOOK_PORT=9000 python webhook_server.py
"""
import os
import sys
import json
import logging
import requests
from datetime import datetime
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
import uvicorn

# Импорты для работы с БД
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app.db import SessionLocal
from app.models.user import User
from app.core.config import settings

# Настройка логирования
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# URL для подписки на вебхуки
MAX_API_URL = "https://platform-api.max.ru"
WEBHOOK_URL = os.getenv("WEBHOOK_URL", "https://webhook-devcore-max.cloudpub.ru/")

# Типы обновлений, на которые подписываемся
# ВАЖНО: message_read не поддерживается API Max Bot для подписки, но оставляем обработку на случай, если событие придет
UPDATE_TYPES = [
    "message_created",
    "message_callback",
    "bot_started",
    "bot_stopped",
    "message_edited",
    "message_removed",
    # "message_read",  # Не поддерживается API для подписки, но обрабатываем если придет
    "bot_added",
    "bot_removed",
    "user_added",
    "user_removed",
]


def subscribe_webhook():
    """Подписывает бота на вебхуки."""
    token = settings.max_bot_token
    if not token:
        logger.error("Токен бота не установлен")
        return False

    try:
        # Проверяем текущие подписки
        response = requests.get(
            f"{MAX_API_URL}/subscriptions",
            params={"access_token": token},
            timeout=10
        )
        
        if response.status_code == 200:
            subscriptions = response.json().get("subscriptions", [])
            # Если уже есть подписка на наш URL, удаляем её
            for sub in subscriptions:
                if sub.get("url") == WEBHOOK_URL:
                    delete_response = requests.delete(
                        f"{MAX_API_URL}/subscriptions",
                        params={"access_token": token, "url": WEBHOOK_URL},
                        timeout=10
                    )
                    if delete_response.status_code != 200:
                        logger.warning(f"Ошибка при удалении подписки: {delete_response.status_code}")

        # Создаём новую подписку
        payload = {
            "url": WEBHOOK_URL,
            "update_types": UPDATE_TYPES,
        }
        
        response = requests.post(
            f"{MAX_API_URL}/subscriptions",
            params={"access_token": token},
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=10
        )
        
        if response.status_code == 200:
            result = response.json()
            if result.get("success"):
                return True
            else:
                logger.error(f"Ошибка подписки: {result.get('message', 'Неизвестная ошибка')}")
                return False
        else:
            logger.error(f"Ошибка HTTP {response.status_code} при подписке на вебхуки")
            return False
    except Exception as e:
        logger.error(f"Ошибка при подписке на вебхуки: {e}")
        return False


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: автоматическая подписка на webhooks
    if WEBHOOK_URL:
        subscribe_webhook()
    else:
        logger.warning("WEBHOOK_URL не установлен, пропускаем подписку")
    
    yield


app = FastAPI(title="Max Bot Webhook Server", lifespan=lifespan)


def _upsert_user_from_webhook(user_data: dict) -> None:
    """
    Сохраняет или обновляет пользователя в БД из данных вебхука.
    """
    if not isinstance(user_data, dict):
        return
    
    user_id = user_data.get("user_id") or user_data.get("id")
    if not user_id:
        return
    
    db = SessionLocal()
    try:
        uuid = str(user_id)
        
        # Формируем username
        first_name = user_data.get("first_name") or user_data.get("name") or ""
        last_name = user_data.get("last_name") or ""
        username_from_data = user_data.get("username")
        
        if first_name and last_name:
            full_name = f"{first_name} {last_name}".strip()
        elif first_name:
            full_name = first_name
        elif username_from_data:
            full_name = username_from_data
        else:
            full_name = f"user_{user_id}"
        
        # Используем username из Max, если есть, иначе формируем
        if username_from_data:
            username = username_from_data
        else:
            username = f"max_{user_id}_{full_name}".strip()
        
        # Проверяем существующего пользователя
        existing = db.query(User).filter(User.uuid == uuid).first()
        
        if existing:
            # Обновляем username, если изменился
            updated = False
            if username_from_data and existing.username != username_from_data:
                existing.username = username_from_data
                updated = True
            elif not username_from_data and existing.username != username:
                existing.username = username
                updated = True
            
            if updated:
                db.add(existing)
                db.commit()
                db.refresh(existing)
        else:
            # Проверяем уникальность username
            if db.query(User).filter(User.username == username).first() is not None:
                username = f"{username}_{user_id}"
            
            # Создаем нового пользователя
            new_user = User(username=username, uuid=uuid)
            db.add(new_user)
            db.commit()
            db.refresh(new_user)
            
    except Exception as e:
        logger.error(f"Ошибка при сохранении пользователя в БД: {e}")
        db.rollback()
    finally:
        db.close()


@app.get("/")
async def root_get(request: Request):
    """Проверка работоспособности сервера и обработка GET запросов."""
    return {"status": "ok", "service": "webhook_server", "webhook_ready": True}


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy"}


@app.post("/")
async def webhook(request: Request):
    """
    Принимает вебхуки от Max Bot API на корневом пути.
    Логирует все входящие данные для отладки.
    """
    try:
        # Получаем заголовки
        headers = dict(request.headers)
        client_ip = request.client.host if request.client else "unknown"
        
        # Получаем тело запроса
        try:
            body_bytes = await request.body()
            body_str = body_bytes.decode('utf-8')
            
            # Пытаемся распарсить как JSON
            payload = None
            try:
                payload = json.loads(body_str)
            except json.JSONDecodeError:
                logger.error(f"Webhook: невалидный JSON")
                payload = None
        except Exception as e:
            logger.error(f"Webhook: ошибка чтения тела запроса: {e}")
            payload = None
        
        # Извлекаем информацию о пользователе
        if payload:
            update_type = payload.get("update_type")
            
            # Извлекаем пользователя из разных типов обновлений
            user = None
            if update_type == "bot_started":
                user = payload.get("user")
            elif update_type == "message_created":
                message = payload.get("message")
                if message:
                    user = message.get("sender")
            elif update_type == "message_callback":
                callback = payload.get("callback")
                if callback:
                    user = callback.get("user")
            
            if user:
                user_id = user.get("user_id") or user.get("id")
                if update_type and user_id:
                    logger.info(f"Webhook: {update_type}, user_id: {user_id}")
                
                # Сохраняем пользователя в БД при bot_started
                if update_type == "bot_started":
                    _upsert_user_from_webhook(user)
            elif update_type:
                logger.info(f"Webhook: {update_type}")
        
        # Всегда возвращаем 200 OK, чтобы Max не повторял запрос
        return JSONResponse(
            status_code=200,
            content={"ok": True, "received": True}
        )
        
    except Exception as e:
        logger.error(f"Webhook: ошибка обработки: {e}")
        # Все равно возвращаем 200, чтобы Max не повторял запрос
        return JSONResponse(
            status_code=200,
            content={"ok": True, "error": str(e)}
        )


# GET на корневой путь уже обрабатывается в root()


if __name__ == "__main__":
    port = int(os.getenv("WEBHOOK_PORT", "8080"))
    host = os.getenv("WEBHOOK_HOST", "0.0.0.0")
    
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info"
    )

