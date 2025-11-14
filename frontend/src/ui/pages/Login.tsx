import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { login, register } from '../../api/client'
import { autoLogin } from '../../auth/autoLogin'

// Определяем платформу (iOS/Android/Desktop)
function detectPlatform(): { platform: string; isIOS: boolean; isAndroid: boolean; isMobile: boolean } {
  const ua = navigator.userAgent || navigator.vendor || (window as any).opera || ''
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream
  const isAndroid = /android/i.test(ua)
  const isMobile = isIOS || isAndroid || /Mobile|Android|iP(hone|od|ad)/i.test(ua)
  
  let platform = 'desktop'
  if (isIOS) platform = 'iOS'
  else if (isAndroid) platform = 'Android'
  else if (isMobile) platform = 'mobile'
  
  return { platform, isIOS, isAndroid, isMobile }
}

export default function Login() {
  const platformInfo = detectPlatform()
  const [username, setUsername] = useState('')
  const [uuid, setUuid] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isRegister, setIsRegister] = useState(false)
  const [authFailed, setAuthFailed] = useState(false)
  const [checkingAuth, setCheckingAuth] = useState(true)
  const navigate = useNavigate()

  // Пытаемся автоматически залогиниться при загрузке страницы
  useEffect(() => {
    // Если токен уже есть, перенаправляем
    if (localStorage.getItem('token')) {
      navigate('/')
      return
    }
    let canceled = false
    let attemptCount = 0
    // Для iOS увеличиваем количество попыток (больше времени ожидания SDK)
    const MAX_ATTEMPTS = platformInfo.isIOS ? 8 : 5 // 8 попыток для iOS, 5 для других
    
    // Функция для проверки наличия initData
    const checkInitDataAvailable = (): boolean => {
      try {
        // Проверяем сохраненный initData
        const savedInitData = localStorage.getItem('initData_saved')
        if (savedInitData) {
          return true
        }
        
        // Проверяем sessionStorage
        const fromSession = sessionStorage.getItem('initData_from_postMessage')
        if (fromSession) {
          return true
        }
        
        // Проверяем SDK
        const w = window as any
        const fromSDK = w?.MaxWebApp?.initData || w?.Telegram?.WebApp?.initData || w?.Max?.WebApp?.initData
        if (fromSDK) {
          return true
        }
        
        // Проверяем URL параметры
        const urlParams = new URLSearchParams(window.location.search)
        const fromUrl = urlParams.get('initData') || urlParams.get('init_data') || urlParams.get('data') || urlParams.get('user_id')
        if (fromUrl) {
          return true
        }
        
        return false
      } catch (e) {
        return false
      }
    }
    
    // Функция для ожидания появления initData
    const waitForInitDataAvailable = async (maxWaitTime: number = 5000): Promise<boolean> => {
      const startTime = Date.now()
      const checkInterval = 200
      // Для iOS увеличиваем время ожидания, если не указано явно
      const actualMaxWaitTime = platformInfo.isIOS && maxWaitTime === 5000 ? 10000 : maxWaitTime // 10 секунд для iOS
      const maxAttempts = Math.floor(actualMaxWaitTime / checkInterval)
      
      for (let i = 0; i < maxAttempts; i++) {
        if (canceled) return false
        
        if (checkInitDataAvailable()) {
          return true
        }
        
        if (i < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, checkInterval))
        }
      }
      
      return false
    }
    
    const tryAuth = async () => {
      if (canceled) return
      
      attemptCount++
      
      // Перед авторизацией ждем появления initData
      // Для iOS увеличиваем время ожидания (до 10 секунд для первой попытки, до 5 секунд для последующих)
      // Для других платформ - до 5 секунд для первой попытки, до 2 секунд для последующих
      if (attemptCount === 1) {
        const waitTime = platformInfo.isIOS ? 10000 : 5000
        await waitForInitDataAvailable(waitTime)
      } else {
        // Для последующих попыток ждем меньше (но для iOS все равно больше)
        const waitTime = platformInfo.isIOS ? 5000 : 2000
        await waitForInitDataAvailable(waitTime)
      }
      
      try {
        // Ждем загрузки SDK и initData
        // Для iOS autoLogin будет ждать до 60 секунд, для других - до 30 секунд
        const ok = await autoLogin(true)
        if (!canceled && ok) {
          // Проверяем, что токен действительно сохранен
          const savedToken = localStorage.getItem('token')
          if (!savedToken) {
            // Если это не последняя попытка, пробуем еще раз
            if (attemptCount < MAX_ATTEMPTS) {
              setTimeout(() => {
                if (!canceled) {
                  tryAuth()
                }
              }, 1000)
            } else {
              setAuthFailed(true)
              setCheckingAuth(false)
            }
            return
          }
          
          // Небольшая задержка для гарантии сохранения токена
          await new Promise(resolve => setTimeout(resolve, 200))
          
          // Финальная проверка токена перед навигацией
          const finalToken = localStorage.getItem('token')
          if (!finalToken) {
            if (attemptCount < MAX_ATTEMPTS) {
              setTimeout(() => {
                if (!canceled) {
                  tryAuth()
                }
              }, 1000)
            } else {
              setAuthFailed(true)
              setCheckingAuth(false)
            }
            return
          }
          
          setCheckingAuth(false)
          setAuthFailed(false)
          
          // Используем window.location.href для принудительной перезагрузки страницы
          // Это гарантирует, что все компоненты получат актуальный токен
          window.location.href = '/'
          return
        } else if (!canceled) {
          // Если это не последняя попытка, пробуем еще раз через 2 секунды
          if (attemptCount < MAX_ATTEMPTS) {
            setTimeout(() => {
              if (!canceled) {
                tryAuth()
              }
            }, 2000)
          } else {
            // Все попытки исчерпаны, показываем ошибку
          setAuthFailed(true)
          setCheckingAuth(false)
          }
        }
      } catch (e) {
        if (!canceled) {
          // Если это не последняя попытка, пробуем еще раз
          if (attemptCount < MAX_ATTEMPTS) {
            setTimeout(() => {
              if (!canceled) {
                tryAuth()
              }
            }, 2000)
          } else {
          setAuthFailed(true)
          setCheckingAuth(false)
        }
      }
      }
    }
    
    // Небольшая задержка перед первой попыткой, чтобы дать время SDK загрузиться
    // Для iOS увеличиваем задержку (SDK может загружаться медленнее)
    const initialDelay = platformInfo.isIOS ? 1000 : 500 // 1 секунда для iOS, 500ms для других
    setTimeout(() => {
      if (!canceled) {
        tryAuth()
      }
    }, initialDelay)
    
    return () => { canceled = true }
  }, [navigate])

  async function handleSubmit() {
    if (!username || !uuid) {
      setError('Заполните все поля')
      return
    }

    try {
      setLoading(true)
      setError(null)
      
      if (isRegister) {
        await register(username, uuid)
        await login(username, uuid)
      } else {
        await login(username, uuid)
      }
      
      navigate('/')
    } catch (e: any) {
      const message = e?.message || (isRegister ? 'Ошибка регистрации' : 'Неверное имя пользователя или UUID')
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  // Показываем загрузку во время проверки авторизации
  if (checkingAuth) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="auth-loading">
            <div className="auth-loading-spinner"></div>
            <p>Проверка авторизации...</p>
          </div>
        </div>
      </div>
    )
  }

  // Показываем страницу ошибки, если авторизация не удалась
  if (authFailed) {
    return (
      <div className="login-container">
        <div className="login-card login-card--error">
          <div className="auth-error">
            <div className="auth-error-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" stroke="rgba(255, 68, 0, 0.3)" strokeWidth="2"/>
                <path d="M12 8V12M12 16H12.01" stroke="rgba(255, 68, 0, 0.8)" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <h2 className="auth-error-title">Ошибка авторизации</h2>
            <p className="auth-error-message" style={{ textAlign: 'center', lineHeight: '1.6' }}>
              Не удалось выполнить автоматический вход в систему.
              <br /><br />
              Пожалуйста, закройте мини-приложение через крестик вверху слева и откройте его заново.
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Обычная форма входа (для ручного входа, если нужно)
  return (
    <div className="login-container">
      <div className="login-card">
        <h2 className="login-title">{isRegister ? 'Регистрация' : 'Вход'}</h2>
        
        {error && <div className="error-message">{error}</div>}
        
        <div className="input-group">
          <label className="input-label">Имя пользователя</label>
          <input
            type="text"
            placeholder="Ваше имя"
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            disabled={loading}
          />
        </div>
        
        <div className="input-group">
          <label className="input-label">UUID</label>
          <input
            type="text"
            placeholder="Ваш UUID"
            value={uuid}
            onChange={e => setUuid(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            disabled={loading}
          />
        </div>
        
        <div className="btn-group" style={{ flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Загрузка...' : (isRegister ? 'Зарегистрироваться' : 'Войти')}
          </button>
          <button
            className="btn"
            onClick={() => {
              setIsRegister(!isRegister)
              setError(null)
            }}
            disabled={loading}
            style={{ width: '100%' }}
          >
            {isRegister ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}
          </button>
        </div>
      </div>
    </div>
  )
}
