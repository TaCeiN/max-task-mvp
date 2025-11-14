/**
 * Определяет платформу (iOS/Android/Desktop)
 */
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

/**
 * Ожидает загрузки Max WebApp SDK и получения initData
 * Делает повторные попытки с интервалом
 * Увеличено время ожидания для надежной работы с медленной загрузкой SDK
 * Использует сохраненный initData из localStorage как fallback
 */
async function waitForInitData(maxAttempts: number = 60, intervalMs: number = 500): Promise<string | null> {
  const platformInfo = detectPlatform()
  
  // Для iOS увеличиваем время ожидания, если не указано явно
  const actualMaxAttempts = platformInfo.isIOS && maxAttempts === 60 ? 120 : maxAttempts // 120 попыток = 60 секунд для iOS
  
  // Сначала проверяем сохраненный initData
  try {
    const savedInitData = localStorage.getItem('initData_saved')
    if (savedInitData) {
      return savedInitData
    }
  } catch (e) {
    // Игнорируем ошибки localStorage
  }
  
  for (let attempt = 0; attempt < actualMaxAttempts; attempt++) {
    // Проверяем все возможные источники
    const initData = getInitData()
    if (initData) {
      // Сохраняем для последующих запусков (если еще не сохранен)
      try {
        if (!localStorage.getItem('initData_saved')) {
          localStorage.setItem('initData_saved', initData)
        }
      } catch (e) {
        // Игнорируем ошибки сохранения
      }
      return initData
    }
    
    // Также проверяем sessionStorage
    try {
      const fromSessionStorage = sessionStorage.getItem('initData_from_postMessage')
      if (fromSessionStorage) {
        // Сохраняем в localStorage
        try {
          localStorage.setItem('initData_saved', fromSessionStorage)
        } catch (e) {
          // Игнорируем ошибки сохранения
        }
        return fromSessionStorage
      }
    } catch (e) {
      // Игнорируем ошибки sessionStorage
    }
    
    // Если это не последняя попытка, ждем перед следующей
    if (attempt < actualMaxAttempts - 1) {
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }
  
  // Финальная попытка: проверяем сохраненный initData еще раз
  try {
    const savedInitData = localStorage.getItem('initData_saved')
    if (savedInitData) {
      return savedInitData
    }
  } catch (e) {
    // Игнорируем ошибки localStorage
  }
  
  return null
}

/**
 * Получает initData из различных источников Max WebApp
 * Max открывает мини-приложение как обычную веб-страницу и передает данные через:
 * 1. URL параметры (?initData=... или другие параметры)
 * 2. postMessage от родительского окна
 * 3. window.MaxWebApp.initData (если SDK загружен)
 */
function getInitData(): string | null {
  const w = window as any
  const platformInfo = detectPlatform()
  
  // 0. Проверяем localStorage для сохраненного initData (если был сохранен ранее)
  try {
    const savedInitData = localStorage.getItem('initData_saved')
    if (savedInitData) {
      return savedInitData
    }
  } catch (e) {
    // Игнорируем ошибки localStorage
  }
  
  // 1. Попытка получить из Max WebApp SDK
  if (w?.MaxWebApp?.initData) {
    const initData = w.MaxWebApp.initData
    // Сохраняем для последующих запусков
    try {
      localStorage.setItem('initData_saved', initData)
    } catch (e) {
      // Игнорируем ошибки сохранения
    }
    return initData
  }
  
  // Проверяем другие возможные пути к Max WebApp SDK
  if (w?.Telegram?.WebApp?.initData) {
    const initData = w.Telegram.WebApp.initData
    try {
      localStorage.setItem('initData_saved', initData)
    } catch (e) {
      // Игнорируем ошибки сохранения
    }
    return initData
  }
  
  if (w?.Max?.WebApp?.initData) {
    const initData = w.Max.WebApp.initData
    try {
      localStorage.setItem('initData_saved', initData)
    } catch (e) {
      // Игнорируем ошибки сохранения
    }
    return initData
  }
  
  // 1.5. Проверяем sessionStorage (может быть сохранен из postMessage)
  try {
  const fromPostMessage = sessionStorage.getItem('initData_from_postMessage')
  if (fromPostMessage) {
      // Также сохраняем в localStorage для последующих запусков
      try {
        localStorage.setItem('initData_saved', fromPostMessage)
      } catch (e) {
        // Игнорируем ошибки сохранения
      }
    return fromPostMessage
    }
  } catch (e) {
    // Игнорируем ошибки sessionStorage
  }
  
  // 2. Попытка получить из URL параметров (самый частый случай для Max)
  const urlParams = new URLSearchParams(location.search)
  
  // Расширенный список возможных названий параметров
  const possibleParamNames = [
    'initData', 'init_data', 'data', 'tgWebAppData', 'webAppData',
    'initdata', 'initDataRaw', 'initDataRaw', 'webapp_data', 'webappdata',
    'tg_web_app_data', 'tgWebAppDataRaw', 'start_param'
  ]
  
  let fromUrl: string | null = null
  for (const paramName of possibleParamNames) {
    fromUrl = urlParams.get(paramName)
    if (fromUrl) {
      break
    }
  }
  
  if (fromUrl) {
    try {
      const decoded = decodeURIComponent(fromUrl)
      // Сохраняем для последующих запусков
      try {
        localStorage.setItem('initData_saved', decoded)
      } catch (e) {
        // Игнорируем ошибки сохранения
      }
      return decoded
    } catch (e) {
      // Пробуем вернуть как есть
      try {
        localStorage.setItem('initData_saved', fromUrl)
      } catch (e2) {
        // Игнорируем ошибки сохранения
      }
      return fromUrl
    }
  }
  
  // 2.5. Проверяем все параметры URL более агрессивно
  const fullUrl = window.location.href
  const allUrlParams = new URLSearchParams(fullUrl.split('?')[1] || '')
  
  for (const [key, value] of allUrlParams.entries()) {
    const keyLower = key.toLowerCase()
    // Более широкий поиск
    if (keyLower.includes('init') || 
        keyLower.includes('data') || 
        keyLower.includes('webapp') ||
        keyLower.includes('web_app') ||
        keyLower.includes('start')) {
      
      // Пробуем распарсить как JSON, если похоже на JSON
      if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(decodeURIComponent(value))
          // Если это объект с пользователем, формируем initData
          if (parsed.user || parsed.user_id) {
            const userId = parsed.user?.user_id || parsed.user?.id || parsed.user_id || parsed.id
            if (userId) {
              const parts = [`user_id=${userId}`]
              if (parsed.user?.first_name || parsed.first_name) {
                parts.push(`first_name=${encodeURIComponent(parsed.user?.first_name || parsed.first_name)}`)
              }
              if (parsed.user?.last_name || parsed.last_name) {
                parts.push(`last_name=${encodeURIComponent(parsed.user?.last_name || parsed.last_name)}`)
              }
              if (parsed.user?.username || parsed.username) {
                parts.push(`username=${encodeURIComponent(parsed.user?.username || parsed.username)}`)
              }
              const constructed = parts.join('&')
              try {
                localStorage.setItem('initData_saved', constructed)
              } catch (e) {
                // Игнорируем ошибки сохранения
              }
              return constructed
            }
          }
        } catch (e) {
          // Не JSON, пробуем использовать как есть
        }
      }
      
      // Используем значение как initData
      try {
        const decoded = decodeURIComponent(value)
        try {
          localStorage.setItem('initData_saved', decoded)
        } catch (e) {
          // Игнорируем ошибки сохранения
        }
        return decoded
      } catch (e) {
        try {
          localStorage.setItem('initData_saved', value)
        } catch (e2) {
          // Игнорируем ошибки сохранения
        }
        return value
      }
    }
  }
  
  // 3. Попытка получить из hash
  try {
  const hashParams = new URLSearchParams(location.hash.substring(1))
    for (const paramName of possibleParamNames) {
      const fromHash = hashParams.get(paramName)
  if (fromHash) {
        try {
          const decoded = decodeURIComponent(fromHash)
          try {
            localStorage.setItem('initData_saved', decoded)
          } catch (e) {
            // Игнорируем ошибки сохранения
          }
          return decoded
        } catch (e) {
          try {
            localStorage.setItem('initData_saved', fromHash)
          } catch (e2) {
            // Игнорируем ошибки сохранения
          }
          return fromHash
        }
      }
    }
  } catch (e) {
    // Игнорируем ошибки hash
  }
  
  // 4. Попытка получить из window.location (полный URL может содержать initData)
  const urlMatch = fullUrl.match(/[?&#](?:initData|init_data|data|tgWebAppData|webAppData|start_param)=([^&?#]+)/i)
  if (urlMatch && urlMatch[1]) {
    try {
      const decoded = decodeURIComponent(urlMatch[1])
      try {
        localStorage.setItem('initData_saved', decoded)
      } catch (e) {
        // Игнорируем ошибки сохранения
      }
      return decoded
    } catch (e) {
      try {
        localStorage.setItem('initData_saved', urlMatch[1])
      } catch (e2) {
        // Игнорируем ошибки сохранения
      }
      return urlMatch[1]
    }
  }
  
  // 5. Проверяем, может быть данные переданы как часть query string без имени параметра
  // Например: ?user_id=123&first_name=John (прямые параметры пользователя)
  const userId = urlParams.get('user_id') || urlParams.get('userId') || urlParams.get('id')
  if (userId) {
    const firstName = urlParams.get('first_name') || urlParams.get('firstName') || urlParams.get('firstname') || ''
    const lastName = urlParams.get('last_name') || urlParams.get('lastName') || urlParams.get('lastname') || ''
    const username = urlParams.get('username') || urlParams.get('userName') || urlParams.get('user') || ''
    
    // Формируем initData в формате URL-encoded
    const parts = [`user_id=${userId}`]
    if (firstName) parts.push(`first_name=${encodeURIComponent(firstName)}`)
    if (lastName) parts.push(`last_name=${encodeURIComponent(lastName)}`)
    if (username) parts.push(`username=${encodeURIComponent(username)}`)
    
    const constructed = parts.join('&')
    try {
      localStorage.setItem('initData_saved', constructed)
    } catch (e) {
      // Игнорируем ошибки сохранения
    }
    return constructed
  }
  
  return null
}

/**
 * Пытается извлечь user_id из initData для логирования
 */
function extractUserIdFromInitData(initData: string): number | null {
  try {
    // Пытаемся распарсить как JSON
    if (initData.trim().startsWith('{')) {
      const data = JSON.parse(initData)
      return data.user?.user_id || data.user?.id || data.user_id || data.id || null
    }
    
    // Пытаемся распарсить как URL-encoded строку
    const params = new URLSearchParams(initData)
    const userStr = params.get('user')
    if (userStr) {
      try {
        const user = JSON.parse(userStr)
        return user.user_id || user.id || null
      } catch {
        // Если не JSON, пробуем найти user_id напрямую
        return params.get('user_id') ? parseInt(params.get('user_id')!) : null
      }
    }
    
    // Пробуем найти user_id напрямую в параметрах
    const userId = params.get('user_id')
    if (userId) {
      return parseInt(userId)
    }
    
    return null
  } catch (e) {
    return null
  }
}

export async function autoLogin(waitForData: boolean = true): Promise<boolean> {
  const platformInfo = detectPlatform()
  
  try {
    let initData: string | null = null
    
    // Сначала пробуем получить сразу
    initData = getInitData()
    
    // Если не найден и нужно ждать, делаем повторные попытки
    if (!initData && waitForData) {
      // Для iOS используем больше попыток (120 попыток = 60 секунд)
      // Для других платформ - 60 попыток = 30 секунд
      const maxAttempts = platformInfo.isIOS ? 120 : 60
      initData = await waitForInitData(maxAttempts, 500)
    }
    
    // Если initData все еще не найден, пробуем использовать сохраненные данные
    if (!initData) {
      // Сначала пробуем использовать сохраненный initData из localStorage
      try {
        const savedInitData = localStorage.getItem('initData_saved')
        if (savedInitData) {
          initData = savedInitData
        }
      } catch (e) {
        // Игнорируем ошибки чтения
      }
      
      // Если все еще нет initData, пробуем использовать mock данные для dev режима
      // НО ТОЛЬКО ЕСЛИ НЕ iOS - на iOS мы должны получать initData от Max
      if (!initData && !platformInfo.isIOS) {
        // Пробуем получить user_id из localStorage (если был сохранен ранее)
        const savedUserId = localStorage.getItem('dev_user_id')
        if (savedUserId) {
          // Создаем mock initData с user_id в формате, который понимает бэкенд
          initData = `user_id=${savedUserId}&first_name=Dev&last_name=User`
          // Сохраняем mock initData для последующих запусков
          try {
            localStorage.setItem('initData_saved', initData)
          } catch (e) {
            // Игнорируем ошибки сохранения
          }
        }
      }
    }
    
    if (!initData) {
      return false
    }
    
    // Определяем API URL в зависимости от окружения
    const getApiUrl = (): string => {
      if (import.meta.env.VITE_API_URL) {
        return import.meta.env.VITE_API_URL
      }
      if (import.meta.env.DEV) {
        return 'http://localhost:8000'
      }
      return 'https://backend.devcore.com.ru'
    }
    
    const apiUrl = getApiUrl()
    const endpoint = `${apiUrl}/auth/webapp-init`
    
    const requestBody = JSON.stringify({ initData })
    
    // Повторные попытки для временных ошибок сервера
    const MAX_RETRIES = 3
    
    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      try {
        if (retry > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody
        })

        if (!res.ok) {
          // Проверяем, является ли ошибка временной (502, 503, 504, 429)
          const isTemporaryError = res.status === 502 || res.status === 503 || res.status === 504 || res.status === 429
          
          if (isTemporaryError && retry < MAX_RETRIES - 1) {
            // Временная ошибка - пробуем еще раз
            continue
          } else {
            // Постоянная ошибка или все попытки исчерпаны
            return false
          }
        }
        
        // Успешный ответ - обрабатываем токен
        const data = await res.json().catch(() => null)
        const token = data?.access_token
        if (!token) {
          return false
        }
        
        // Сохраняем токен в localStorage
        try {
          localStorage.setItem('token', token)
          
          // Проверяем, что токен действительно сохранен
          const savedToken = localStorage.getItem('token')
          if (!savedToken || savedToken !== token) {
            return false
          }
          
          // Небольшая задержка для гарантии сохранения токена перед возвратом
          await new Promise(resolve => setTimeout(resolve, 100))
          
        } catch (e) {
          return false
        }
    
        // Получаем данные пользователя из БД (не критично для авторизации)
        // Временно пропускаем на iOS из-за ошибки с created_at (будет исправлено в backend)
        // После исправления backend можно убрать эту проверку
        if (!platformInfo.isIOS) {
          try {
            const userRes = await fetch(`${apiUrl}/auth/me`, {
              method: 'GET',
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              }
            })
            
            if (userRes.ok) {
              const userData = await userRes.json().catch(() => null)
              if (userData) {
                // Сохраняем данные пользователя в localStorage
                localStorage.setItem('user', JSON.stringify(userData))
              }
            }
          } catch (e) {
            // Не критично, токен уже сохранен, продолжаем работу
          }
        }
        
        // Финальная проверка токена перед возвратом
        const finalTokenCheck = localStorage.getItem('token')
        if (!finalTokenCheck) {
          return false
        }
        
        return true
        
      } catch (e) {
        // Если это не последняя попытка и ошибка сети, пробуем еще раз
        if (retry < MAX_RETRIES - 1) {
          continue
        } else {
          return false
        }
      }
    }
    
    // Если дошли сюда, все попытки исчерпаны
    return false
  } catch (e) {
    return false
  }
}
