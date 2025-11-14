#!/bin/bash
# Скрипт для деплоя фронтенда на GitHub Pages через Docker (вариант 1)
# Убедитесь, что файл .env существует и содержит все необходимые переменные

set -e

echo "=========================================="
echo "🚀 Деплой на GitHub Pages (вариант 1)"
echo "=========================================="
echo ""

# Проверяем наличие .env файла
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please create .env file based on env.example"
    echo ""
    echo "Example:"
    echo "  cp env.example .env"
    echo "  # Then edit .env and fill in all required values"
    exit 1
fi

echo "📋 Loading environment variables from .env..."
# Загружаем переменные из .env (игнорируем комментарии и пустые строки)
export $(grep -v '^#' .env | grep -v '^$' | xargs)

# Проверяем обязательные переменные
if [ -z "$MAX_BOT_TOKEN" ]; then
    echo "❌ Error: MAX_BOT_TOKEN is not set in .env"
    exit 1
fi

if [ -z "$BACKEND_DOMAIN" ]; then
    echo "❌ Error: BACKEND_DOMAIN is not set in .env"
    exit 1
fi

if [ -z "$WEBHOOK_DOMAIN" ]; then
    echo "❌ Error: WEBHOOK_DOMAIN is not set in .env"
    exit 1
fi

if [ -z "$BACKEND_URL" ]; then
    echo "❌ Error: BACKEND_URL is not set in .env"
    exit 1
fi

if [ -z "$WEBHOOK_URL" ]; then
    echo "❌ Error: WEBHOOK_URL is not set in .env"
    exit 1
fi

if [ -z "$SECRET_KEY" ]; then
    echo "❌ Error: SECRET_KEY is not set in .env"
    exit 1
fi

if [ -z "$LETSENCRYPT_EMAIL" ]; then
    echo "❌ Error: LETSENCRYPT_EMAIL is not set in .env (required for SSL certificates)"
    exit 1
fi

if [ -z "$GITHUB_TOKEN" ]; then
    echo "❌ Error: GITHUB_TOKEN is not set in .env (required for GitHub Pages deployment)"
    exit 1
fi

echo "✅ Environment variables loaded"
echo "   BACKEND_DOMAIN: ${BACKEND_DOMAIN}"
echo "   WEBHOOK_DOMAIN: ${WEBHOOK_DOMAIN}"
echo "   BACKEND_URL: ${BACKEND_URL}"
echo "   WEBHOOK_URL: ${WEBHOOK_URL}"
echo "   LETSENCRYPT_EMAIL: ${LETSENCRYPT_EMAIL}"
echo "   GITHUB_REPO: ${GITHUB_REPO:-tacein/tacein.github.io}"
echo ""

echo "🔧 Starting Nginx reverse proxy and Let's Encrypt..."
docker compose -f docker-compose.github.yml up -d nginx-proxy letsencrypt

echo "⏳ Waiting for Nginx proxy to be ready..."
sleep 5

# Функция для проверки и получения сертификатов
check_and_obtain_certificates() {
    local compose_file=$1
    local max_attempts=2
    local attempt=1
    
    echo ""
    echo "🔒 Checking SSL certificates..."
    
    # Проверяем наличие скрипта проверки
    if [ ! -f "./check-certificates.sh" ]; then
        echo "⚠️  Warning: check-certificates.sh not found, skipping certificate validation"
        return 0
    fi
    
    # Делаем скрипт исполняемым
    chmod +x ./check-certificates.sh 2>/dev/null || true
    
    # Проверяем сертификаты
    while [ $attempt -le $max_attempts ]; do
        if ./check-certificates.sh; then
            echo ""
            echo "✅ All SSL certificates are valid and will be used"
            return 0
        fi
        
        if [ $attempt -lt $max_attempts ]; then
            echo "⚠️  Certificates not found or invalid, attempt $attempt/$max_attempts: trying to obtain..."
            echo "   Restarting Let's Encrypt container..."
            docker compose -f "$compose_file" restart letsencrypt
            echo "   Waiting 60 seconds for certificate generation..."
            sleep 60
        fi
        
        attempt=$((attempt + 1))
    done
    
    # Если не удалось получить сертификаты после всех попыток
    echo ""
    echo -e "\033[0;31m"
    echo "=================================================================="
    echo "⚠️  ВНИМАНИЕ: SSL СЕРТИФИКАТЫ НЕ ВАЛИДНЫ ИЛИ НЕ ПОЛУЧЕНЫ!"
    echo "=================================================================="
    echo ""
    echo "Сертификаты для доменов не найдены или невалидны после $max_attempts попыток."
    echo "Требуется ручная настройка SSL сертификатов."
    echo ""
    echo "Что делать:"
    echo "1. Проверьте логи Let's Encrypt:"
    echo "   docker compose -f $compose_file logs letsencrypt"
    echo ""
    echo "2. Убедитесь, что DNS записи настроены правильно:"
    echo "   nslookup $BACKEND_DOMAIN"
    echo "   nslookup $WEBHOOK_DOMAIN"
    echo ""
    echo "3. Проверьте, что порты 80 и 443 открыты в firewall"
    echo ""
    echo "4. Если вы достигли лимита Let's Encrypt rate limit, подождите"
    echo "   или используйте существующие сертификаты (см. DOCKER.md)"
    echo ""
    echo "5. Деплой продолжается, но HTTPS может не работать до настройки сертификатов"
    echo ""
    echo "=================================================================="
    echo -e "\033[0m"
    echo ""
    
    return 1
}

# Проверяем и пытаемся получить сертификаты
check_and_obtain_certificates "docker-compose.github.yml" || true

echo "🔨 Building and starting backend and webhook containers..."
docker compose -f docker-compose.github.yml up --build -d backend webhook

echo "⏳ Waiting for backend to be ready..."
sleep 5

echo "🚀 Starting frontend deployment to GitHub Pages..."
docker compose -f docker-compose.github.yml up --build frontend-deploy

if [ $? -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "✅ Deployment completed successfully!"
    echo "=========================================="
    echo ""
    echo "📊 Services status:"
    docker compose -f docker-compose.github.yml ps
    echo ""
    echo "🌐 Backend: ${BACKEND_URL}"
    echo "🔔 Webhook: ${WEBHOOK_URL}"
    echo "📱 Frontend: https://$(echo ${GITHUB_REPO:-tacein/tacein.github.io} | cut -d'/' -f1).github.io"
    echo ""
    echo "🔒 SSL сертификаты будут автоматически получены и обновлены через Let's Encrypt"
    echo "   Первый запуск может занять несколько минут для получения сертификатов"
    echo ""
    echo "📝 View logs:"
    echo "   docker compose -f docker-compose.github.yml logs -f"
    echo ""
    echo "📝 Check SSL certificate status:"
    echo "   docker compose -f docker-compose.github.yml logs letsencrypt"
else
    echo ""
    echo "=========================================="
    echo "❌ Deployment failed!"
    echo "=========================================="
    echo ""
    echo "📝 Check logs:"
    echo "   docker compose -f docker-compose.github.yml logs"
    exit 1
fi

