import { useEffect } from 'react'
import { AppHeader } from './components/AppHeader'
import { SessionSidebar } from './components/SessionSidebar'
import { WelcomePane } from './components/WelcomePane'
import { useHealth } from './hooks/useHealth'
import { applyTheme, useThemeStore } from './theme/useTheme'

export default function App() {
  const mode = useThemeStore((state) => state.mode)
  const health = useHealth()

  useEffect(() => {
    applyTheme(mode)
  }, [mode])

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <AppHeader status={health.status} serverVersion={health.data?.version} />
      <div className="flex min-h-0 flex-1">
        <SessionSidebar />
        <main className="min-w-0 flex-1 overflow-auto">
          <WelcomePane health={health} />
        </main>
      </div>
    </div>
  )
}
