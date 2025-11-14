import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NotesProvider } from './ui/contexts/NotesContext'
import { DialogProvider } from './ui/contexts/DialogContext'
import { LanguageProvider } from './ui/contexts/LanguageContext'
import App from './ui/App'
import Login from './ui/pages/Login'
import Dashboard from './ui/pages/Dashboard'
import Settings from './ui/pages/Settings'
import Notes from './ui/pages/Notes'
import { autoLogin } from './auth/autoLogin'
import './ui/styles.css'

const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />
  },
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'settings', element: <Settings /> },
      { path: 'notes', element: <Notes /> },
    ]
  }
])

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false
    }
  }
})

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

const platformInfo = detectPlatform()

// Пробуем найти initData сразу при загрузке
const w = window as any

// Глобальный флаг для отслеживания, была ли уже попытка авторизации
let authAttempted = false
let authInProgress = false

// Функция для попытки авторизации, если токена еще нет
async function tryAutoLoginIfNeeded() {
  const currentPlatformInfo = detectPlatform()
  
  if (localStorage.getItem('token')) {
    return
  }
  
  if (authInProgress) {
    return
  }
  
  authInProgress = true
  
  try {
    // Для iOS используем больше времени ожидания (до 60 секунд)
    // Для других платформ - до 30 секунд
    const ok = await autoLogin(true)
    if (ok) {
      authAttempted = true
      // Проверяем, что токен действительно сохранен
      const savedToken = localStorage.getItem('token')
      if (savedToken) {
        // Если мы на странице логина, перенаправляем на главную
        if (window.location.pathname === '/login') {
          window.location.href = '/'
        } else {
          // Если мы не на странице логина, обновляем страницу, чтобы компоненты получили новый токен
          window.location.reload()
        }
      }
    }
  } catch (e) {
    // Разрешаем повторную попытку при ошибке
  } finally {
    authInProgress = false
  }
}

// Функция для обработки initData из postMessage
function handleInitDataFromPostMessage(initData: string, source: string) {
  // Сохраняем в sessionStorage для немедленного использования
  try {
    sessionStorage.setItem('initData_from_postMessage', initData)
  } catch (e) {
    // Игнорируем ошибки
  }
  
  // Также сохраняем в localStorage для последующих запусков
  try {
    localStorage.setItem('initData_saved', initData)
  } catch (e) {
    // Игнорируем ошибки
  }
  
  // Пробуем авторизоваться немедленно
  tryAutoLoginIfNeeded()
}

// Слушаем postMessage от родительского окна Max (всегда, не только в iframe)
// Max может отправлять postMessage даже если не в iframe

// Обработчик postMessage событий
const postMessageHandler = (event: MessageEvent) => {
  // Проверяем различные форматы данных
  if (!event.data) {
    return
  }
  
  // Формат 1: Объект с initData
  if (typeof event.data === 'object' && event.data !== null) {
    if (event.data.initData && typeof event.data.initData === 'string') {
      handleInitDataFromPostMessage(event.data.initData, 'postMessage (объект)')
      return
    }
    
    // Формат 2: Объект с user_id и другими полями
    if (event.data.user_id || event.data.userId || event.data.id) {
      const userId = event.data.user_id || event.data.userId || event.data.id
      const firstName = event.data.first_name || event.data.firstName || event.data.firstname || ''
      const lastName = event.data.last_name || event.data.lastName || event.data.lastname || ''
      const username = event.data.username || event.data.userName || event.data.user || ''
      
      const initData = `user_id=${userId}${firstName ? `&first_name=${encodeURIComponent(firstName)}` : ''}${lastName ? `&last_name=${encodeURIComponent(lastName)}` : ''}${username ? `&username=${encodeURIComponent(username)}` : ''}`
      handleInitDataFromPostMessage(initData, 'postMessage (user_id)')
      return
    }
    
    // Формат 3: Объект с вложенным user объектом
    if (event.data.user && typeof event.data.user === 'object') {
      const user = event.data.user
      if (user.user_id || user.id) {
        const userId = user.user_id || user.id
        const firstName = user.first_name || user.firstName || ''
        const lastName = user.last_name || user.lastName || ''
        const username = user.username || user.userName || ''
        
        const initData = `user_id=${userId}${firstName ? `&first_name=${encodeURIComponent(firstName)}` : ''}${lastName ? `&last_name=${encodeURIComponent(lastName)}` : ''}${username ? `&username=${encodeURIComponent(username)}` : ''}`
        handleInitDataFromPostMessage(initData, 'postMessage (user объект)')
        return
      }
    }
    
    // Формат 4: JSON строка в объекте
    if (event.data.data && typeof event.data.data === 'string') {
      try {
        const parsed = JSON.parse(event.data.data)
        if (parsed.user || parsed.user_id) {
          const userId = parsed.user?.user_id || parsed.user?.id || parsed.user_id || parsed.id
          if (userId) {
            const firstName = parsed.user?.first_name || parsed.first_name || ''
            const lastName = parsed.user?.last_name || parsed.last_name || ''
            const username = parsed.user?.username || parsed.username || ''
            
            const initData = `user_id=${userId}${firstName ? `&first_name=${encodeURIComponent(firstName)}` : ''}${lastName ? `&last_name=${encodeURIComponent(lastName)}` : ''}${username ? `&username=${encodeURIComponent(username)}` : ''}`
            handleInitDataFromPostMessage(initData, 'postMessage (JSON data)')
            return
          }
        }
      } catch (e) {
        // Не JSON, пробуем использовать как строку
        if (event.data.data.includes('user_id') || event.data.data.includes('initData')) {
          handleInitDataFromPostMessage(event.data.data, 'postMessage (data строка)')
          return
        }
      }
    }
  }
  
  // Формат 5: Строка с initData или user_id
  if (typeof event.data === 'string') {
    if (event.data.includes('user_id') || event.data.includes('initData') || event.data.includes('init_data')) {
      handleInitDataFromPostMessage(event.data, 'postMessage (строка)')
      return
    }
    
    // Пробуем распарсить как JSON
    try {
      const parsed = JSON.parse(event.data)
      if (parsed.user || parsed.user_id || parsed.initData) {
        if (parsed.initData) {
          handleInitDataFromPostMessage(parsed.initData, 'postMessage (JSON initData)')
          return
        }
        
        const userId = parsed.user?.user_id || parsed.user?.id || parsed.user_id || parsed.id
        if (userId) {
          const firstName = parsed.user?.first_name || parsed.first_name || ''
          const lastName = parsed.user?.last_name || parsed.last_name || ''
          const username = parsed.user?.username || parsed.username || ''
          
          const initData = `user_id=${userId}${firstName ? `&first_name=${encodeURIComponent(firstName)}` : ''}${lastName ? `&last_name=${encodeURIComponent(lastName)}` : ''}${username ? `&username=${encodeURIComponent(username)}` : ''}`
          handleInitDataFromPostMessage(initData, 'postMessage (JSON user)')
          return
        }
      }
    } catch (e) {
      // Не JSON, пропускаем
    }
  }
}

// Добавляем обработчик postMessage
// Слушаем всегда, не только в iframe, так как Max может отправлять postMessage разными способами
window.addEventListener('message', postMessageHandler, false)

// Дополнительно: запрашиваем initData у родительского окна (если в iframe)
if (window.parent !== window) {
  try {
    // Отправляем сообщение родителю с запросом initData
    window.parent.postMessage({ type: 'requestInitData' }, '*')
  } catch (e) {
    // Игнорируем ошибки
  }
}

// Слушаем изменения в Max WebApp SDK (если SDK загружается асинхронно)
let lastInitData: string | null = null
let checkSDKInterval: ReturnType<typeof setInterval> | null = null
let checkSDKStartTime = Date.now()
// Увеличено время ожидания SDK при первом запуске до 60 секунд для iOS (SDK может загружаться медленнее)
// Для Android и других платформ - 30 секунд
const MAX_SDK_CHECK_TIME = platformInfo.isIOS ? 60000 : 30000 // 60 секунд для iOS, 30 секунд для других
const SDK_CHECK_INTERVAL = 200 // Проверяем каждые 200ms (чаще, чем раньше)

// Функция для проверки SDK и остановки при необходимости
function checkSDKAndStopIfNeeded() {
  if (localStorage.getItem('token')) {
    if (checkSDKInterval) {
      clearInterval(checkSDKInterval)
      checkSDKInterval = null
    }
    return true
  }
  
  const elapsed = Date.now() - checkSDKStartTime
  if (elapsed > MAX_SDK_CHECK_TIME) {
    if (checkSDKInterval) {
      clearInterval(checkSDKInterval)
      checkSDKInterval = null
    }
    return true
  }
  
  return false
}

// Функция для обработки найденного initData из SDK
function handleInitDataFromSDK(initData: string, source: string) {
  if (initData === lastInitData) {
    return // Уже обработали
  }
  
  lastInitData = initData
  
  // Сохраняем в sessionStorage для немедленного использования
  try {
    sessionStorage.setItem('initData_from_postMessage', initData)
  } catch (e) {
    // Игнорируем ошибки
  }
  
  // Также сохраняем в localStorage для последующих запусков
  try {
    localStorage.setItem('initData_saved', initData)
  } catch (e) {
    // Игнорируем ошибки
  }
  
  // Пробуем авторизоваться немедленно
  tryAutoLoginIfNeeded()
}

// Проверяем появление initData в SDK с интервалом
let checkAttempts = 0
checkSDKInterval = setInterval(() => {
  if (checkSDKAndStopIfNeeded()) {
    return
  }
  
  checkAttempts++
  
  // Проверяем SDK объекты
  const currentInitData = w?.MaxWebApp?.initData || 
                         w?.Telegram?.WebApp?.initData || 
                         w?.Max?.WebApp?.initData
  
  if (currentInitData && currentInitData !== lastInitData) {
    handleInitDataFromSDK(currentInitData, 'SDK объект')
    return
  }
  
  // Также проверяем sessionStorage (может быть сохранен из postMessage)
  try {
    const fromSessionStorage = sessionStorage.getItem('initData_from_postMessage')
    if (fromSessionStorage && fromSessionStorage !== lastInitData) {
      handleInitDataFromSDK(fromSessionStorage, 'sessionStorage (postMessage)')
      return
    }
  } catch (e) {
    // Игнорируем ошибки sessionStorage
  }
  
  // Проверяем localStorage для сохраненного initData (если токена еще нет)
  if (!localStorage.getItem('token')) {
    try {
      const savedInitData = localStorage.getItem('initData_saved')
      if (savedInitData && savedInitData !== lastInitData) {
        handleInitDataFromSDK(savedInitData, 'localStorage (сохраненный)')
        return
      }
    } catch (e) {
      // Игнорируем ошибки localStorage
    }
  }
}, SDK_CHECK_INTERVAL)

// Останавливаем проверку через максимальное время
setTimeout(() => {
  if (checkSDKInterval) {
    clearInterval(checkSDKInterval)
    checkSDKInterval = null
  }
}, MAX_SDK_CHECK_TIME)

// Пытаемся авторизоваться при загрузке приложения, если токена нет
// Это особенно важно для iOS, где авторизация может не происходить автоматически
if (!localStorage.getItem('token')) {
  // Запускаем авторизацию с небольшой задержкой, чтобы дать время SDK загрузиться
  const initialAuthDelay = platformInfo.isIOS ? 1000 : 500
  setTimeout(() => {
    tryAutoLoginIfNeeded().catch((error) => {
      // Игнорируем ошибки
    })
  }, initialAuthDelay)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <DialogProvider>
          <NotesProvider>
            <RouterProvider router={router} />
          </NotesProvider>
        </DialogProvider>
      </LanguageProvider>
    </QueryClientProvider>
  </React.StrictMode>
)
