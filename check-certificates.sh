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

# Функция для поиска сертификата в конкретном Docker volume
# Проверяет один volume на наличие валидного сертификата для домена
find_cert_in_single_volume() {
    local domain=$1
    local volume_name=$2
    
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
    
    # Устанавливаем openssl в контейнере
    docker exec "$temp_container" apk add --no-cache openssl >/dev/null 2>&1 || true
    
    # Ищем все потенциальные файлы сертификатов (включая поддиректории)
    # Исключаем файлы ключей и dhparam
    local cert_files
    cert_files=$(docker exec "$temp_container" find /certs -type f \( -name "*.crt" -o -name "*.pem" \) 2>/dev/null | \
        grep -v "\.key$" | \
        grep -v "key\.pem$" | \
        grep -v "privkey" | \
        grep -v "dhparam" | \
        grep -v "\.csr$" || true)
    
    if [ -z "$cert_files" ]; then
        docker stop "$temp_container" >/dev/null 2>&1
        return 1
    fi
    
    # Создаем временную директорию для проверки
    local temp_dir
    temp_dir=$(mktemp -d)
    
    # Проверяем каждый найденный файл
    while IFS= read -r cert_file; do
        if [ -z "$cert_file" ]; then
            continue
        fi
        
        # Копируем сертификат для проверки
        docker cp "$temp_container:${cert_file}" "$temp_dir/cert_to_check.crt" >/dev/null 2>&1
        
        if [ ! -f "$temp_dir/cert_to_check.crt" ]; then
            continue
        fi
        
        # Проверяем, что это валидный сертификат (формат X.509)
        if ! openssl x509 -in "$temp_dir/cert_to_check.crt" -noout -text >/dev/null 2>&1; then
            rm -f "$temp_dir/cert_to_check.crt"
            continue
        fi
        
        # Проверяем, что сертификат соответствует домену
        # Извлекаем все домены из сертификата (CN и SAN)
        local cert_domains
        cert_domains=$(openssl x509 -in "$temp_dir/cert_to_check.crt" -noout -text 2>/dev/null | \
            grep -E "(Subject:|DNS:)" | \
            sed -n 's/.*CN=\([^,]*\).*/\1/p; s/.*DNS:\([^, ]*\).*/\1/p' | \
            tr -d ' ' | \
            grep -v "^$" || echo "")
        
        # Проверяем соответствие домену (точное совпадение или поддомен)
        local domain_match=0
        while IFS= read -r cert_domain; do
            if [ -z "$cert_domain" ]; then
                continue
            fi
            # Точное совпадение
            if [ "$cert_domain" = "$domain" ]; then
                domain_match=1
                break
            fi
            # Поддомен (например, *.example.com покрывает sub.example.com)
            if echo "$cert_domain" | grep -qE "^\*\.${domain#*.}$" && [ "$domain" != "${domain#*.}" ]; then
                domain_match=1
                break
            fi
        done <<< "$cert_domains"
        
        if [ $domain_match -eq 0 ]; then
            rm -f "$temp_dir/cert_to_check.crt"
            continue
        fi
        
        # Проверяем валидность срока действия (минимум 7 дней)
        if ! openssl x509 -checkend $((7 * 24 * 60 * 60)) -noout -in "$temp_dir/cert_to_check.crt" >/dev/null 2>&1; then
            rm -f "$temp_dir/cert_to_check.crt"
            continue
        fi
        
        # Нашли валидный сертификат для домена, теперь ищем соответствующий ключ
        # Ищем ключ в той же директории, что и сертификат
        local cert_dir=$(dirname "$cert_file")
        local key_files
        
        # Сначала ищем в той же директории
        key_files=$(docker exec "$temp_container" find "$cert_dir" -maxdepth 1 -type f \( -name "*.key" -o -name "*key.pem" -o -name "privkey.pem" \) 2>/dev/null || true)
        
        # Если не нашли, ищем во всем volume
        if [ -z "$key_files" ]; then
            key_files=$(docker exec "$temp_container" find /certs -type f \( -name "*.key" -o -name "*key.pem" -o -name "privkey.pem" \) 2>/dev/null | \
                grep -v "dhparam" || true)
        fi
        
        # Проверяем каждый найденный ключ
        while IFS= read -r key_file; do
            if [ -z "$key_file" ]; then
                continue
            fi
            
            # Копируем ключ
            docker cp "$temp_container:${key_file}" "$temp_dir/key_to_check.key" >/dev/null 2>&1
            
            if [ ! -f "$temp_dir/key_to_check.key" ]; then
                continue
            fi
            
            # Проверяем, что ключ соответствует сертификату
            # Используем сравнение публичных ключей - самый надежный способ
            local cert_pubkey
            local key_pubkey
            
            # Извлекаем публичный ключ из сертификата
            cert_pubkey=$(openssl x509 -noout -pubkey -in "$temp_dir/cert_to_check.crt" 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | openssl md5 2>/dev/null | awk '{print $NF}' || echo "")
            
            # Извлекаем публичный ключ из приватного ключа
            key_pubkey=$(openssl pkey -in "$temp_dir/key_to_check.key" -pubout -outform DER 2>/dev/null | openssl md5 2>/dev/null | awk '{print $NF}' || echo "")
            
            # Если не получилось через DER, пробуем через modulus для RSA
            if [ -z "$cert_pubkey" ] || [ -z "$key_pubkey" ] || [ "$cert_pubkey" != "$key_pubkey" ]; then
                # Для RSA ключей сравниваем modulus
                cert_pubkey=$(openssl x509 -noout -modulus -in "$temp_dir/cert_to_check.crt" 2>/dev/null | openssl md5 2>/dev/null | awk '{print $NF}' || echo "")
                key_pubkey=$(openssl rsa -noout -modulus -in "$temp_dir/key_to_check.key" 2>/dev/null | openssl md5 2>/dev/null | awk '{print $NF}' || echo "")
            fi
            
            # Проверяем совпадение публичных ключей
            if [ -n "$cert_pubkey" ] && [ -n "$key_pubkey" ] && [ "$cert_pubkey" = "$key_pubkey" ]; then
                # Нашли подходящую пару сертификат+ключ!
                mv "$temp_dir/cert_to_check.crt" "$temp_dir/${domain}.crt"
                mv "$temp_dir/key_to_check.key" "$temp_dir/${domain}.key"
                
                # Финальная проверка через функцию check_certificate
                if check_certificate "$domain" "$temp_dir/${domain}.crt" "$temp_dir/${domain}.key"; then
                    rm -rf "$temp_dir"
                    docker stop "$temp_container" >/dev/null 2>&1
                    return 0
                fi
            fi
            
            rm -f "$temp_dir/key_to_check.key"
        done <<< "$key_files"
        
        rm -f "$temp_dir/cert_to_check.crt"
    done <<< "$cert_files"
    
    rm -rf "$temp_dir"
    docker stop "$temp_container" >/dev/null 2>&1
    return 1
}

# Функция для поиска сертификата в Docker volume
# Универсальный поиск - проверяет ВСЕ volumes с nginx-certs
# Находит сертификаты независимо от структуры и имен файлов
find_cert_in_volume() {
    local domain=$1
    
    # Получаем список всех volumes с nginx-certs
    local all_volumes
    all_volumes=$(docker volume ls --format "{{.Name}}" 2>/dev/null | grep -E ".*nginx-certs$" || true)
    
    if [ -z "$all_volumes" ]; then
        return 1
    fi
    
    # Проверяем каждый volume
    while IFS= read -r volume_name; do
        if [ -z "$volume_name" ]; then
            continue
        fi
        
        # Пытаемся найти сертификат в этом volume
        if find_cert_in_single_volume "$domain" "$volume_name"; then
            return 0
        fi
    done <<< "$all_volumes"
    
    # Не нашли ни в одном volume
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

# Показываем все volumes, которые будут проверяться
ALL_VOLUMES=$(docker volume ls --format "{{.Name}}" 2>/dev/null | grep -E ".*nginx-certs$" || echo "")
if [ -n "$ALL_VOLUMES" ]; then
    echo "  Проверяемые Docker volumes:"
    while IFS= read -r vol; do
        if [ -n "$vol" ]; then
            echo "    - $vol"
        fi
    done <<< "$ALL_VOLUMES"
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

