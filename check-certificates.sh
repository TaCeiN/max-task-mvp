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

# Функция для определения имени Docker volume с сертификатами
# Docker Compose добавляет префикс имени проекта к volumes
find_nginx_certs_volume() {
    local possible_volumes=()
    
    # 1. Проверяем переменную окружения COMPOSE_PROJECT_NAME
    if [ -n "$COMPOSE_PROJECT_NAME" ]; then
        possible_volumes+=("${COMPOSE_PROJECT_NAME}_nginx-certs")
    fi
    
    # 2. Пытаемся определить имя проекта из текущей директории
    local current_dir=$(basename "$(pwd)")
    local dir_project_name=$(echo "$current_dir" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')
    possible_volumes+=("${dir_project_name}_nginx-certs")
    
    # 3. Проверяем все существующие volumes с nginx-certs
    local existing_volumes
    existing_volumes=$(docker volume ls --format "{{.Name}}" 2>/dev/null | grep -E ".*nginx-certs$" || true)
    
    if [ -n "$existing_volumes" ]; then
        while IFS= read -r vol; do
            if [ -n "$vol" ]; then
                # Проверяем, что volume еще не добавлен в список
                local found=0
                for existing in "${possible_volumes[@]}"; do
                    if [ "$existing" = "$vol" ]; then
                        found=1
                        break
                    fi
                done
                if [ $found -eq 0 ]; then
                    possible_volumes+=("$vol")
                fi
            fi
        done <<< "$existing_volumes"
    fi
    
    # 4. Добавляем вариант без префикса (для обратной совместимости)
    possible_volumes+=("nginx-certs")
    
    # Проверяем каждый volume на наличие файлов
    for volume_name in "${possible_volumes[@]}"; do
        if docker volume inspect "$volume_name" >/dev/null 2>&1; then
            # Проверяем, что volume не пустой
            local temp_container
            temp_container=$(docker run -d --rm -v "$volume_name:/certs" alpine sleep 3600 2>/dev/null || echo "")
            
            if [ -n "$temp_container" ]; then
                # Проверяем, есть ли хотя бы один файл в volume
                local file_count
                file_count=$(docker exec "$temp_container" sh -c "ls -1 /certs 2>/dev/null | wc -l" 2>/dev/null || echo "0")
                docker stop "$temp_container" >/dev/null 2>&1 || true
                
                if [ "$file_count" -gt 0 ]; then
                    echo "$volume_name"
                    return 0
                fi
            fi
        fi
    done
    
    # Если ничего не найдено, возвращаем первое возможное имя (для создания нового volume)
    if [ -n "$COMPOSE_PROJECT_NAME" ]; then
        echo "${COMPOSE_PROJECT_NAME}_nginx-certs"
    elif [ -n "$dir_project_name" ]; then
        echo "${dir_project_name}_nginx-certs"
    else
        echo "nginx-certs"
    fi
    
    return 1
}

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
    
    # Определяем правильное имя volume (с учетом префикса проекта)
    local volume_name
    volume_name=$(find_nginx_certs_volume)
    
    if [ -z "$volume_name" ]; then
        return 1
    fi
    
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

# Определяем используемый volume для информационного вывода
DETECTED_VOLUME=$(find_nginx_certs_volume 2>/dev/null || echo "")
if [ -n "$DETECTED_VOLUME" ]; then
    echo "  Используемый Docker volume: $DETECTED_VOLUME"
fi
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

