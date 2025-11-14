"""
Сервис для отслеживания отправленных сообщений и их прочтения.
"""
import logging
import threading
from typing import Dict, Optional
from datetime import datetime, timedelta

from .bot_service import delete_message
from ..core.config import settings

logger = logging.getLogger(__name__)

# Хранилище отправленных сообщений: message_id -> {user_id, sent_at, ...}
_sent_messages: Dict[str, Dict] = {}
_lock = threading.Lock()


def track_message(message_id: str, user_id: str, text: str) -> None:
    """
    Сохраняет информацию об отправленном сообщении для отслеживания.
    Автоматически планирует удаление через заданное время после отправки,
    так как API Max Bot не поддерживает отслеживание прочтения через webhook.
    
    Args:
        message_id: ID сообщения
        user_id: UUID пользователя
        text: Текст сообщения
    """
    if not message_id:
        return
    
    message_id_str = str(message_id)
    delete_delay = settings.notification_delete_after_read_seconds
    
    with _lock:
        _sent_messages[message_id_str] = {
            "user_id": user_id,
            "text": text,
            "sent_at": datetime.now(),
            "read_at": None,
            "delete_scheduled": False
        }
    
    # Планируем автоматическое удаление через заданное время после отправки
    # (так как API не поддерживает отслеживание прочтения через webhook)
    def auto_delete_after_delay():
        import time
        time.sleep(delete_delay)
        
        with _lock:
            if message_id_str not in _sent_messages:
                return
            
            message_info = _sent_messages[message_id_str]
            # Если сообщение уже было отмечено как прочитанное, не удаляем автоматически
            # (удаление уже запланировано через mark_message_as_read)
            if message_info.get("read_at") is not None:
                return
            
            user_id_for_delete = message_info.get("user_id")
            success = delete_message(message_id_str, user_id_for_delete)
            if success:
                del _sent_messages[message_id_str]
            else:
                logger.error(f"Не удалось автоматически удалить сообщение {message_id_str}")
    
    thread = threading.Thread(target=auto_delete_after_delay, daemon=True, name=f"auto_delete_{message_id_str}")
    thread.start()


def mark_message_as_read(message_id: str) -> Optional[Dict]:
    """
    Отмечает сообщение как прочитанное и планирует его удаление.
    
    Args:
        message_id: ID сообщения
        
    Returns:
        Информация о сообщении, если оно найдено, None в противном случае
    """
    message_id_str = str(message_id)
    with _lock:
        if message_id_str not in _sent_messages:
            return None
        
        message_info = _sent_messages[message_id_str]
        
        # Если уже отмечено как прочитанное, не обрабатываем повторно
        if message_info.get("read_at") is not None:
            return message_info
        
        # Отмечаем как прочитанное
        message_info["read_at"] = datetime.now()
        message_info["delete_scheduled"] = True
        
        user_id = message_info["user_id"]
        delete_delay = settings.notification_delete_after_read_seconds
        
        # Планируем удаление через заданное время
        def delete_after_delay():
            import time
            time.sleep(delete_delay)
            
            # Проверяем, что сообщение все еще в отслеживаемых (не было удалено вручную)
            with _lock:
                if message_id_str not in _sent_messages:
                    return
                
                message_info = _sent_messages[message_id_str]
                user_id_for_delete = message_info.get("user_id")
                
                success = delete_message(message_id_str, user_id_for_delete)
                if success:
                    # Удаляем из отслеживаемых
                    del _sent_messages[message_id_str]
                else:
                    logger.error(f"Не удалось удалить сообщение {message_id_str} после прочтения")
        
        # Запускаем удаление в отдельном потоке
        thread = threading.Thread(target=delete_after_delay, daemon=True, name=f"delete_msg_{message_id_str}")
        thread.start()
        
        return message_info


def get_message_info(message_id: str) -> Optional[Dict]:
    """
    Получает информацию о сообщении.
    
    Args:
        message_id: ID сообщения
        
    Returns:
        Информация о сообщении или None
    """
    with _lock:
        return _sent_messages.get(message_id)


def remove_message(message_id: str) -> None:
    """
    Удаляет сообщение из отслеживаемых (например, если оно было удалено вручную).
    
    Args:
        message_id: ID сообщения
    """
    with _lock:
        if message_id in _sent_messages:
            del _sent_messages[message_id]

