"""
Сервис для отправки сообщений пользователям через Max Bot API.
"""
import logging
import requests
from typing import Optional, Dict, Any

from ..core.config import settings

logger = logging.getLogger(__name__)

MAX_BOT_API_URL = "https://platform-api.max.ru"


def send_message_to_user(user_uuid: str, text: str, image_url: Optional[str] = None) -> Dict[str, Any]:
    """
    Отправляет сообщение пользователю через Max Bot API.
    
    Args:
        user_uuid: UUID пользователя (user_id из Max Bot API) - может быть строкой или числом
        text: Текст сообщения
        image_url: Опциональный URL изображения для прикрепления к сообщению
        
    Returns:
        Dict с ключами:
        - "success": bool - успешность отправки
        - "message_id": str | None - ID сообщения, если отправлено успешно
        - "error_code": str | None - код ошибки, если есть
        - "error_message": str | None - сообщение об ошибке, если есть
        - "error_type": str | None - тип ошибки ("chat.denied", "network", "other")
        - "result": dict | None - полный результат ответа API
    """
    try:
        token = settings.max_bot_token
        if not token:
            logger.error("MAX_BOT_TOKEN не установлен в настройках")
            return {
                "success": False,
                "message_id": None,
                "error_code": "no_token",
                "error_message": "MAX_BOT_TOKEN не установлен в настройках",
                "error_type": "other",
                "result": None
            }
        
        url = f"{MAX_BOT_API_URL}/messages"
        
        # Пробуем отправить с исходным форматом user_id
        params = {
            "access_token": token,
            "user_id": user_uuid
        }
        
        payload = {
            "text": text
        }
        
        # Добавляем вложение с изображением, если указан URL
        if image_url:
            payload["attachments"] = [
                {
                    "type": "image",
                    "payload": {
                        "url": image_url
                    }
                }
            ]
        
        response = requests.post(url, params=params, json=payload, timeout=10)
        
        if response.status_code == 200:
            result = response.json()
            
            # Пробуем разные варианты извлечения message_id
            message_id = None
            if isinstance(result, dict):
                # Вариант 1: message.body.mid (основной путь для Max Bot API)
                if "message" in result:
                    message_obj = result.get("message")
                    if isinstance(message_obj, dict) and "body" in message_obj:
                        body = message_obj.get("body")
                        if isinstance(body, dict):
                            message_id = body.get("mid")
                
                # Вариант 2: прямо в корне
                if not message_id:
                    message_id = result.get("message_id")
                
                # Вариант 3: в объекте message (другие варианты)
                if not message_id and "message" in result:
                    message_obj = result.get("message")
                    if isinstance(message_obj, dict):
                        message_id = message_obj.get("message_id") or message_obj.get("id") or message_obj.get("mid")
                
                # Вариант 4: в объекте data
                if not message_id and "data" in result:
                    data_obj = result.get("data")
                    if isinstance(data_obj, dict):
                        message_id = data_obj.get("message_id") or data_obj.get("id")
                
                # Вариант 5: в result
                if not message_id and "result" in result:
                    result_obj = result.get("result")
                    if isinstance(result_obj, dict):
                        message_id = result_obj.get("message_id") or result_obj.get("id")
                
                # Вариант 6: просто id
                if not message_id:
                    message_id = result.get("id")
            
            if message_id:
                logger.info(f"Сообщение отправлено пользователю {user_uuid} (message_id: {message_id})")
            else:
                # Пробуем найти сообщение по тексту
                import time
                time.sleep(1)  # Небольшая задержка, чтобы сообщение успело сохраниться
                found_message_id = find_message_by_text(user_uuid, text)
                if found_message_id:
                    message_id = found_message_id
                else:
                    logger.warning(f"Сообщение отправлено пользователю {user_uuid}, но message_id не найден")
            return {
                "success": True,
                "message_id": str(message_id) if message_id else None,
                "error_code": None,
                "error_message": None,
                "error_type": None,
                "result": result
            }
        elif response.status_code == 403:
            # Обрабатываем ошибку 403 отдельно
            error_code = None
            error_message = None
            error_type = "chat.denied"
            
            try:
                error_data = response.json()
                error_code = error_data.get("code")
                error_message = error_data.get("message")
                
                # Если ошибка "chat.denied" или "error.dialog.suspended", пытаемся отправить с числовым user_id
                if error_code == "chat.denied" or (error_message and "dialog.suspended" in error_message):
                    # Пробуем преобразовать user_id в число, если это строка
                    try:
                        numeric_user_id = int(user_uuid)
                        
                        params_numeric = {
                            "access_token": token,
                            "user_id": numeric_user_id
                        }
                        
                        response_numeric = requests.post(url, params=params_numeric, json=payload, timeout=10)
                        
                        if response_numeric.status_code == 200:
                            result_numeric = response_numeric.json()
                            
                            # Извлекаем message_id
                            message_id = None
                            if isinstance(result_numeric, dict):
                                if "message" in result_numeric:
                                    message_obj = result_numeric.get("message")
                                    if isinstance(message_obj, dict) and "body" in message_obj:
                                        body = message_obj.get("body")
                                        if isinstance(body, dict):
                                            message_id = body.get("mid")
                                if not message_id:
                                    message_id = result_numeric.get("message_id") or result_numeric.get("id")
                            
                            logger.info(f"Сообщение отправлено пользователю {user_uuid} (message_id: {message_id})")
                            return {
                                "success": True,
                                "message_id": str(message_id) if message_id else None,
                                "error_code": None,
                                "error_message": None,
                                "error_type": None,
                                "result": result_numeric
                            }
                    except (ValueError, TypeError):
                        pass
                
            except Exception:
                error_message = response.text
            
            logger.error(f"Ошибка 403 при отправке сообщения пользователю {user_uuid}: {error_code or 'chat.denied'}")
            return {
                "success": False,
                "message_id": None,
                "error_code": error_code or "403",
                "error_message": error_message or "Доступ запрещен",
                "error_type": error_type,
                "result": None
            }
        else:
            # Другие ошибки
            error_code = None
            error_message = None
            
            try:
                error_data = response.json()
                error_code = error_data.get("code")
                error_message = error_data.get("message")
            except Exception:
                error_message = response.text
            
            logger.error(f"Ошибка {response.status_code} при отправке сообщения пользователю {user_uuid}: {error_code or error_message}")
            return {
                "success": False,
                "message_id": None,
                "error_code": error_code or str(response.status_code),
                "error_message": error_message or f"Ошибка отправки сообщения: {response.status_code}",
                "error_type": "other",
                "result": None
            }
            
    except requests.exceptions.Timeout:
        logger.error(f"Таймаут при отправке сообщения пользователю {user_uuid}")
        return {
            "success": False,
            "message_id": None,
            "error_code": "timeout",
            "error_message": "Таймаут при отправке сообщения",
            "error_type": "network",
            "result": None
        }
    except requests.exceptions.ConnectionError:
        logger.error(f"Ошибка соединения при отправке сообщения пользователю {user_uuid}")
        return {
            "success": False,
            "message_id": None,
            "error_code": "connection_error",
            "error_message": "Ошибка соединения с Max Bot API",
            "error_type": "network",
            "result": None
        }
    except Exception as e:
        logger.error(f"Ошибка при отправке сообщения пользователю {user_uuid}: {e}")
        return {
            "success": False,
            "message_id": None,
            "error_code": "exception",
            "error_message": str(e),
            "error_type": "other",
            "result": None
        }


def get_messages_from_chat(user_uuid: str, limit: int = 50) -> Optional[list]:
    """
    Получает список последних сообщений из чата с пользователем.
    
    Args:
        user_uuid: UUID пользователя (user_id из Max Bot API)
        limit: Максимальное количество сообщений для получения
        
    Returns:
        Список сообщений или None в случае ошибки
    """
    try:
        token = settings.max_bot_token
        if not token:
            logger.error("MAX_BOT_TOKEN не установлен в настройках")
            return None
        
        url = f"{MAX_BOT_API_URL}/messages"
        params = {
            "access_token": token,
            "user_id": user_uuid,
            "limit": limit
        }
        
        response = requests.get(url, params=params, timeout=10)
        
        if response.status_code == 200:
            result = response.json()
            messages = result.get("messages", []) or result.get("data", []) or []
            return messages
        else:
            logger.error(f"Ошибка {response.status_code} при получении сообщений для пользователя {user_uuid}")
            return None
            
    except Exception as e:
        logger.error(f"Ошибка при получении сообщений для пользователя {user_uuid}: {e}")
        return None


def find_message_by_text(user_uuid: str, text: str) -> Optional[str]:
    """
    Ищет сообщение в чате по тексту и возвращает его message_id.
    
    Args:
        user_uuid: UUID пользователя
        text: Текст сообщения для поиска
        
    Returns:
        message_id найденного сообщения или None
    """
    try:
        messages = get_messages_from_chat(user_uuid, limit=50)
        if not messages:
            return None
        
        # Ищем сообщение с нужным текстом
        for msg in messages:
            # Проверяем разные варианты структуры сообщения
            msg_text = None
            msg_id = None
            
            if isinstance(msg, dict):
                # Вариант 1: message.body.text
                if "body" in msg and isinstance(msg["body"], dict):
                    msg_text = msg["body"].get("text")
                    msg_id = msg["body"].get("mid")
                # Вариант 2: message.text
                elif "text" in msg:
                    msg_text = msg.get("text")
                    msg_id = msg.get("mid") or msg.get("message_id") or msg.get("id")
                # Вариант 3: body.text
                elif "body" in msg:
                    body = msg.get("body")
                    if isinstance(body, dict):
                        msg_text = body.get("text")
                        msg_id = body.get("mid")
            
            # Сравниваем тексты (учитываем, что текст может быть обрезан)
            if msg_text and (text in msg_text or msg_text in text):
                return str(msg_id) if msg_id else None
        
        return None
        
    except Exception as e:
        logger.error(f"Ошибка при поиске сообщения по тексту для пользователя {user_uuid}: {e}")
        return None


def delete_message(message_id: str, user_uuid: str) -> bool:
    """
    Удаляет сообщение через Max Bot API.
    
    Args:
        message_id: ID сообщения для удаления
        user_uuid: UUID пользователя (user_id из Max Bot API)
        
    Returns:
        True если сообщение удалено успешно, False в противном случае
    """
    try:
        token = settings.max_bot_token
        if not token:
            logger.error("MAX_BOT_TOKEN не установлен в настройках")
            return False
        
        # Согласно swagger, DELETE /messages использует message_id в query параметрах
        url = f"{MAX_BOT_API_URL}/messages"
        params = {
            "access_token": token,
            "message_id": message_id
        }
        
        response = requests.delete(url, params=params, timeout=10)
        
        if response.status_code == 200:
            logger.info(f"Сообщение {message_id} удалено для пользователя {user_uuid}")
            return True
        else:
            logger.error(f"Ошибка {response.status_code} при удалении сообщения {message_id} для пользователя {user_uuid}")
            return False
            
    except Exception as e:
        logger.error(f"Ошибка при удалении сообщения {message_id} для пользователя {user_uuid}: {e}")
        return False

