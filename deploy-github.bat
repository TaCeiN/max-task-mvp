@echo off
REM Скрипт для деплоя фронтенда на GitHub Pages через Docker (вариант 1)
REM Убедитесь, что файл .env существует и содержит все необходимые переменные

echo ==========================================
echo 🚀 Деплой на GitHub Pages (вариант 1)
echo ==========================================
echo.

REM Проверяем наличие .env файла
if not exist .env (
    echo ❌ Error: .env file not found!
    echo Please create .env file based on env.example
    echo.
    echo Example:
    echo   copy env.example .env
    echo   REM Then edit .env and fill in all required values
    pause
    exit /b 1
)

echo 📋 Loading environment variables from .env...
REM Загружаем переменные из .env
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    set "%%a=%%b"
)

REM Проверяем обязательные переменные
if "%MAX_BOT_TOKEN%"=="" (
    echo ❌ Error: MAX_BOT_TOKEN is not set in .env
    pause
    exit /b 1
)

if "%BACKEND_DOMAIN%"=="" (
    echo ❌ Error: BACKEND_DOMAIN is not set in .env
    pause
    exit /b 1
)

if "%WEBHOOK_DOMAIN%"=="" (
    echo ❌ Error: WEBHOOK_DOMAIN is not set in .env
    pause
    exit /b 1
)

if "%BACKEND_URL%"=="" (
    echo ❌ Error: BACKEND_URL is not set in .env
    pause
    exit /b 1
)

if "%WEBHOOK_URL%"=="" (
    echo ❌ Error: WEBHOOK_URL is not set in .env
    pause
    exit /b 1
)

if "%SECRET_KEY%"=="" (
    echo ❌ Error: SECRET_KEY is not set in .env
    pause
    exit /b 1
)

if "%LETSENCRYPT_EMAIL%"=="" (
    echo ❌ Error: LETSENCRYPT_EMAIL is not set in .env (required for SSL certificates)
    pause
    exit /b 1
)

if "%GITHUB_TOKEN%"=="" (
    echo ❌ Error: GITHUB_TOKEN is not set in .env (required for GitHub Pages deployment)
    pause
    exit /b 1
)

echo ✅ Environment variables loaded
echo    BACKEND_DOMAIN: %BACKEND_DOMAIN%
echo    WEBHOOK_DOMAIN: %WEBHOOK_DOMAIN%
echo    BACKEND_URL: %BACKEND_URL%
echo    WEBHOOK_URL: %WEBHOOK_URL%
echo    LETSENCRYPT_EMAIL: %LETSENCRYPT_EMAIL%
echo    GITHUB_REPO: %GITHUB_REPO%
echo.

echo 🔧 Starting Nginx reverse proxy and Let's Encrypt...
docker compose -f docker-compose.github.yml up -d nginx-proxy letsencrypt

echo ⏳ Waiting for Nginx proxy to be ready...
timeout /t 5 /nobreak >nul

REM Проверка SSL сертификатов (требует bash/WSL на Windows)
echo.
echo 🔒 Checking SSL certificates...
where bash >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    REM Bash доступен, используем скрипт проверки
    if exist check-certificates.sh (
        bash check-certificates.sh
        set CERT_CHECK_RESULT=%ERRORLEVEL%
        if %CERT_CHECK_RESULT% NEQ 0 (
            echo.
            echo ⚠️  Certificates not found or invalid, attempting to obtain...
            echo    Attempt 1/2: Restarting Let's Encrypt container...
            docker compose -f docker-compose.github.yml restart letsencrypt
            echo    Waiting 60 seconds for certificate generation...
            timeout /t 60 /nobreak >nul
            bash check-certificates.sh
            set CERT_CHECK_RESULT=%ERRORLEVEL%
            if %CERT_CHECK_RESULT% NEQ 0 (
                echo.
                echo    Attempt 2/2: Restarting Let's Encrypt container again...
                docker compose -f docker-compose.github.yml restart letsencrypt
                echo    Waiting 60 seconds for certificate generation...
                timeout /t 60 /nobreak >nul
                bash check-certificates.sh
                set CERT_CHECK_RESULT=%ERRORLEVEL%
                if %CERT_CHECK_RESULT% NEQ 0 (
                    echo.
                    echo ==================================================================
                    echo ⚠️  ВНИМАНИЕ: SSL СЕРТИФИКАТЫ НЕ ВАЛИДНЫ ИЛИ НЕ ПОЛУЧЕНЫ!
                    echo ==================================================================
                    echo.
                    echo Сертификаты для доменов не найдены или невалидны после 2 попыток.
                    echo Требуется ручная настройка SSL сертификатов.
                    echo.
                    echo Что делать:
                    echo 1. Проверьте логи Let's Encrypt:
                    echo    docker compose -f docker-compose.github.yml logs letsencrypt
                    echo.
                    echo 2. Убедитесь, что DNS записи настроены правильно:
                    echo    nslookup %BACKEND_DOMAIN%
                    echo    nslookup %WEBHOOK_DOMAIN%
                    echo.
                    echo 3. Проверьте, что порты 80 и 443 открыты в firewall
                    echo.
                    echo 4. Если вы достигли лимита Let's Encrypt rate limit, подождите
                    echo    или используйте существующие сертификаты (см. DOCKER.md)
                    echo.
                    echo 5. Деплой продолжается, но HTTPS может не работать до настройки сертификатов
                    echo.
                    echo ==================================================================
                    echo.
                )
            )
        ) else (
            echo ✅ All SSL certificates are valid
        )
    ) else (
        echo ⚠️  Warning: check-certificates.sh not found, skipping certificate validation
    )
) else (
    echo ⚠️  Warning: bash not found, skipping certificate validation
    echo    Certificate validation will be performed on Linux production server
)

echo 🔨 Building and starting backend and webhook containers...
docker compose -f docker-compose.github.yml up --build -d backend webhook

echo ⏳ Waiting for backend to be ready...
timeout /t 5 /nobreak >nul

echo 🚀 Starting frontend deployment to GitHub Pages...
docker compose -f docker-compose.github.yml up --build frontend-deploy

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ==========================================
    echo ✅ Deployment completed successfully!
    echo ==========================================
    echo.
    echo 📊 Services status:
    docker compose -f docker-compose.github.yml ps
    echo.
    echo 🌐 Backend: %BACKEND_URL%
    echo 🔔 Webhook: %WEBHOOK_URL%
    echo 📱 Frontend: https://github.com/%GITHUB_REPO%
    echo.
    echo 🔒 SSL сертификаты будут автоматически получены и обновлены через Let's Encrypt
    echo    Первый запуск может занять несколько минут для получения сертификатов
    echo.
    echo 📝 View logs:
    echo    docker compose -f docker-compose.github.yml logs -f
    echo.
    echo 📝 Check SSL certificate status:
    echo    docker compose -f docker-compose.github.yml logs letsencrypt
) else (
    echo.
    echo ==========================================
    echo ❌ Deployment failed!
    echo ==========================================
    echo.
    echo 📝 Check logs:
    echo    docker compose -f docker-compose.github.yml logs
)

pause

