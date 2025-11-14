import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
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

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const platformInfo = detectPlatform()
  const [checking, setChecking] = useState<boolean>(() => !localStorage.getItem('token'))
  const [failed, setFailed] = useState<boolean>(false)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'))

  // Слушаем изменения токена в localStorage
  useEffect(() => {
    const checkToken = () => {
      const currentToken = localStorage.getItem('token')
      if (currentToken !== token) {
        setToken(currentToken)
        if (currentToken) {
          setChecking(false)
          setFailed(false)
        }
      }
    }

    // Проверяем токен сразу
    checkToken()

    // Проверяем токен периодически (на случай, если он изменился извне)
    const interval = setInterval(checkToken, 100)

    return () => clearInterval(interval)
  }, [token])

  useEffect(() => {
    const hasToken = !!localStorage.getItem('token')
    
    if (hasToken) {
      setChecking(false)
      setToken(localStorage.getItem('token'))
      return
    }
    let canceled = false
    let attemptCount = 0
    // Для iOS увеличиваем количество попыток (больше времени ожидания SDK)
    const MAX_ATTEMPTS = platformInfo.isIOS ? 8 : 5 // 8 попыток для iOS, 5 для других
    let lastInitDataCheck: string | null = null
    
    // Проверяем наличие initData перед началом авторизации
    const checkInitDataAvailable = (): boolean => {
      try {
        // Проверяем сохраненный initData
        const savedInitData = localStorage.getItem('initData_saved')
        if (savedInitData && savedInitData !== lastInitDataCheck) {
          lastInitDataCheck = savedInitData
          return true
        }
        
        // Проверяем sessionStorage
        const fromSession = sessionStorage.getItem('initData_from_postMessage')
        if (fromSession && fromSession !== lastInitDataCheck) {
          lastInitDataCheck = fromSession
          return true
        }
        
        // Проверяем SDK
        const w = window as any
        const fromSDK = w?.MaxWebApp?.initData || w?.Telegram?.WebApp?.initData || w?.Max?.WebApp?.initData
        if (fromSDK && fromSDK !== lastInitDataCheck) {
          lastInitDataCheck = fromSDK
          return true
        }
        
        // Проверяем URL параметры
        const urlParams = new URLSearchParams(window.location.search)
        const fromUrl = urlParams.get('initData') || urlParams.get('init_data') || urlParams.get('data') || urlParams.get('user_id')
        if (fromUrl && fromUrl !== lastInitDataCheck) {
          lastInitDataCheck = fromUrl
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
      const checkInterval = 200 // Проверяем каждые 200ms
      const maxAttempts = Math.floor(maxWaitTime / checkInterval)
      
      // Для iOS увеличиваем время ожидания, если не указано явно
      const actualMaxWaitTime = platformInfo.isIOS && maxWaitTime === 5000 ? 10000 : maxWaitTime // 10 секунд для iOS
      const actualMaxAttempts = Math.floor(actualMaxWaitTime / checkInterval)
      
      for (let i = 0; i < actualMaxAttempts; i++) {
        if (canceled) return false
        
        if (checkInitDataAvailable()) {
          return true
        }
        
        if (i < actualMaxAttempts - 1) {
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
        // Ждем загрузки SDK и initData (до 30 секунд)
        const ok = await autoLogin(true)
        
        if (!canceled) {
          if (ok) {
            // Успешная авторизация - проверяем токен
            const savedToken = localStorage.getItem('token')
            
            if (savedToken) {
              setToken(savedToken)
              setChecking(false)
              setFailed(false)
              
              // Небольшая задержка для гарантии обновления компонентов
              setTimeout(() => {
                if (!canceled) {
                  const finalToken = localStorage.getItem('token')
                  if (finalToken) {
                    setToken(finalToken)
                    setChecking(false)
                    setFailed(false)
                  }
                }
              }, 300)
            } else {
              // Если это не последняя попытка, пробуем еще раз
              if (attemptCount < MAX_ATTEMPTS) {
                setTimeout(() => {
                  if (!canceled) {
                    tryAuth()
                  }
                }, 2000)
              } else {
                setChecking(false)
                setFailed(true)
              }
            }
          } else {
            // Если это не последняя попытка, пробуем еще раз
            if (attemptCount < MAX_ATTEMPTS) {
              setTimeout(() => {
                if (!canceled) {
                  tryAuth()
                }
              }, 2000)
            } else {
              // Все попытки исчерпаны
              setChecking(false)
              setFailed(true)
            }
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
            setChecking(false)
            setFailed(true)
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
  }, [])

  // Используем состояние token вместо прямого чтения из localStorage
  if (token) {
    return <>{children}</>
  }
  
  if (checking) {
    // Показываем индикатор загрузки во время проверки авторизации
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        flexDirection: 'column',
        gap: '16px'
      }}>
        <div className="auth-loading-spinner" style={{
          width: '40px',
          height: '40px',
          border: '4px solid rgba(255, 255, 255, 0.1)',
          borderTopColor: 'var(--primary-color, #007bff)',
          borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }}></div>
        <p style={{ color: 'var(--text-color, #333)', fontSize: '14px' }}>Проверка авторизации...</p>
      </div>
    )
  }
  if (failed) return <Navigate to="/login" replace />
  return <Navigate to="/login" replace />
}

