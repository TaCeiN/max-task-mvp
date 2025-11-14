#!/bin/bash
# Скрипт проверки валидности SSL сертификатов для доменов из .env
# Проверяет сертификаты только для BACKEND_DOMAIN и WEBHOOK_DOMAIN
# Ищет сертификаты в Docker volume и файловой системе хоста

set -e

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Функция для проверки сертификата
check_certificate() {
    local domain=$1
    local cert_file=$2
    local key_file=$3
    
    if [ ! -f "$cert_file" ] || [ ! -f "$key_file" ]; then
        return 1
    fi
    
    # Проверяем валидность сертификата (минимум 7 дней до истечения)
    local days_until_expiry
    days_until_expiry=$(openssl x509 -checkend $((7 * 24 * 60 * 60)) -noout -in "$cert_file" 2>/dev/null && echo "valid" || echo "expired")
    
    if [ "$days_until_expiry" = "expired" ]; then
        return 1
    fi
    
    # Проверяем, что сертификат соответствует домену
    local cert_domain
    cert_domain=$(openssl x509 -noout -subject -in "$cert_file" 2>/dev/null | sed -n 's/.*CN=\([^,]*\).*/\1/p' | head -1)
    
    if [ -z "$cert_domain" ] || [ "$cert_domain" != "$domain" ]; then
        # Проверяем альтернативные имена (SAN)
        local san_match
        san_match=$(openssl x509 -noout -text -in "$cert_file" 2>/dev/null | grep -A1 "Subject Alternative Name" | grep -q "$domain" && echo "yes" || echo "no")
        if [ "$san_match" != "yes" ]; then
            return 1
        fi
    fi
    
    return 0
}

# Функция для поиска сертификата в Docker volume
find_cert_in_volume() {
    local domain=$1
    local volume_name="nginx-certs"
    
    # Проверяем, существует ли volume
    if ! docker volume inspect "$volume_name" >/dev/null 2>&1; then
        return 1
    fi
    
    # Создаем временный контейнер для доступа к volume
    local temp_container
    temp_container=$(docker run -d --rm -v "$volume_name:/certs" alpine sleep 3600 2>/dev/null || echo "")
    
    if [ -z "$temp_container" ]; then
        return 1
    fi
    
    # Проверяем наличие файлов
    local cert_exists
    local key_exists
    cert_exists=$(docker exec "$temp_container" test -f "/certs/${domain}.crt" && echo "yes" || echo "no")
    key_exists=$(docker exec "$temp_container" test -f "/certs/${domain}.key" && echo "yes" || echo "no")
    
    if [ "$cert_exists" = "yes" ] && [ "$key_exists" = "yes" ]; then
        # Копируем файлы во временную директорию для проверки
        local temp_dir
        temp_dir=$(mktemp -d)
        docker cp "$temp_container:/certs/${domain}.crt" "$temp_dir/${domain}.crt" >/dev/null 2>&1
        docker cp "$temp_container:/certs/${domain}.key" "$temp_dir/${domain}.key" >/dev/null 2>&1
        
        # Проверяем сертификат
        if check_certificate "$domain" "$temp_dir/${domain}.crt" "$temp_dir/${domain}.key"; then
            rm -rf "$temp_dir"
            docker stop "$temp_container" >/dev/null 2>&1
            return 0
        fi
        
        rm -rf "$temp_dir"
    fi
    
    docker stop "$temp_container" >/dev/null 2>&1
    return 1
}

# Функция для поиска сертификата в файловой системе хоста
find_cert_on_host() {
    local domain=$1
    local cert_path="/etc/letsencrypt/live/${domain}/fullchain.pem"
    local key_path="/etc/letsencrypt/live/${domain}/privkey.pem"
    
    # Проверяем наличие файлов (требуются права root)
    if [ ! -f "$cert_path" ] || [ ! -f "$key_path" ]; then
        return 1
    fi
    
    # Проверяем сертификат
    if check_certificate "$domain" "$cert_path" "$key_path"; then
        return 0
    fi
    
    return 1
}

# Основная функция проверки домена
check_domain_certificate() {
    local domain=$1
    
    echo -n "  Проверка сертификата для $domain... "
    
    # Сначала проверяем в Docker volume
    if find_cert_in_volume "$domain"; then
        echo -e "${GREEN}✓ Найден в Docker volume и валиден${NC}"
        return 0
    fi
    
    # Затем проверяем в файловой системе хоста
    if find_cert_on_host "$domain"; then
        echo -e "${GREEN}✓ Найден на хосте и валиден${NC}"
        return 0
    fi
    
    echo -e "${RED}✗ Не найден или невалиден${NC}"
    return 1
}

# Загружаем переменные из .env
if [ ! -f .env ]; then
    echo -e "${RED}Ошибка: файл .env не найден${NC}"
    exit 1
fi

# Загружаем переменные (игнорируем комментарии и пустые строки)
export $(grep -v '^#' .env | grep -v '^$' | xargs)

# Проверяем наличие обязательных переменных
if [ -z "$BACKEND_DOMAIN" ] || [ -z "$WEBHOOK_DOMAIN" ]; then
    echo -e "${RED}Ошибка: BACKEND_DOMAIN или WEBHOOK_DOMAIN не установлены в .env${NC}"
    exit 1
fi

echo "Проверка SSL сертификатов для доменов из .env:"
echo "  BACKEND_DOMAIN: $BACKEND_DOMAIN"
echo "  WEBHOOK_DOMAIN: $WEBHOOK_DOMAIN"
echo ""

# Проверяем сертификаты
backend_ok=0
webhook_ok=0

if check_domain_certificate "$BACKEND_DOMAIN"; then
    backend_ok=1
fi

if check_domain_certificate "$WEBHOOK_DOMAIN"; then
    webhook_ok=1
fi

echo ""

# Возвращаем код ошибки
if [ $backend_ok -eq 1 ] && [ $webhook_ok -eq 1 ]; then
    echo -e "${GREEN}Все сертификаты валидны${NC}"
    exit 0
else
    echo -e "${YELLOW}Некоторые сертификаты отсутствуют или невалидны${NC}"
    exit 1
fi

